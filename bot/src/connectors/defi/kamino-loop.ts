import { createChildLogger } from '../../utils/logger.js';
import { withRetry } from '../../utils/retry.js';
import type { LendingProtocol } from '../../types.js';
import { MINTS } from './types.js';
import {
  KaminoMarket,
  KaminoAction,
  VanillaObligation,
  DEFAULT_RECENT_SLOT_DURATION_MS,
  PROGRAM_ID,
} from '@kamino-finance/klend-sdk';
import {
  address,
  createSolanaRpc,
  createKeyPairSignerFromBytes,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
  type KeyPairSigner,
} from '@solana/kit';

const log = createChildLogger('kamino-loop');

const KAMINO_API = 'https://api.kamino.finance';
const KAMINO_MAIN_MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';

/** Minimum spread (supply - borrow) to activate leverage. Below this, supply-only. */
const MIN_SPREAD_FOR_LEVERAGE = 0.001; // 0.1%

export interface KaminoLoopConfig {
  targetHealthRate: number;   // 1.15
  liquidationLtv: number;     // 0.85 (Kamino's USDC-USDT liquidation LTV)
  alertHealthRate: number;    // 1.10
  emergencyHealthRate: number; // 1.05
  warnUtilizationRatio: number; // 0.95 — USDC supply side; above this, withdrawals may queue
}

const DEFAULT_LOOP_CONFIG: KaminoLoopConfig = {
  targetHealthRate: 1.15,
  liquidationLtv: 0.85,
  alertHealthRate: 1.10,
  emergencyHealthRate: 1.05,
  warnUtilizationRatio: 0.95,
};

/**
 * Calculate the max leverage for a given health rate target.
 *
 *   healthRate = leverage * liquidationLtv / (leverage - 1)
 *   => leverage = healthRate / (healthRate - liquidationLtv)
 */
function maxLeverageForHealth(healthRate: number, liquidationLtv: number): number {
  if (healthRate <= liquidationLtv) return Infinity; // degenerate
  return healthRate / (healthRate - liquidationLtv);
}

/**
 * KaminoLoop — conservative USDC/USDT leverage loop via Kamino Lending.
 *
 * Strategy:
 *   1. Deposit USDC as collateral
 *   2. Borrow USDT against it
 *   3. Swap USDT → USDC via Jupiter
 *   4. Re-deposit — repeat until target leverage
 *
 * When supply APY - borrow APY spread is negative, falls back to
 * supply-only mode (equivalent to plain Kamino lending).
 */
export class KaminoLoopLending implements LendingProtocol {
  readonly name = 'kamino-loop';
  private walletAddress: string;
  private rpc: any = null;
  private signer: KeyPairSigner | null = null;
  private market: KaminoMarket | null = null;
  private rpcUrl: string | null = null;
  private secretKey: Uint8Array | null = null;
  private loopConfig: KaminoLoopConfig;
  private jupiterSwapWalletAddress: string;

  /** Calculated from targetHealthRate */
  readonly targetLeverage: number;

  constructor(
    walletAddress: string,
    rpcUrl?: string,
    secretKey?: Uint8Array,
    loopConfig?: Partial<KaminoLoopConfig>,
  ) {
    this.walletAddress = walletAddress;
    this.jupiterSwapWalletAddress = walletAddress;
    this.rpcUrl = rpcUrl ?? null;
    this.secretKey = secretKey ?? null;
    this.loopConfig = { ...DEFAULT_LOOP_CONFIG, ...loopConfig };
    this.targetLeverage = maxLeverageForHealth(
      this.loopConfig.targetHealthRate,
      this.loopConfig.liquidationLtv,
    );
    log.info(
      {
        targetHealthRate: this.loopConfig.targetHealthRate,
        targetLeverage: Math.round(this.targetLeverage * 100) / 100,
      },
      'KaminoLoop initialized',
    );
  }

  private async ensureInitialized(): Promise<{
    rpc: any;
    signer: KeyPairSigner;
    market: KaminoMarket;
  }> {
    if (!this.rpcUrl || !this.secretKey) {
      throw new Error('KaminoLoop not configured for on-chain operations');
    }

    if (!this.rpc) {
      this.rpc = createSolanaRpc(this.rpcUrl as Parameters<typeof createSolanaRpc>[0]);
    }

    if (!this.signer) {
      this.signer = await createKeyPairSignerFromBytes(this.secretKey);
    }

    if (!this.market) {
      const market = await KaminoMarket.load(
        this.rpc,
        address(KAMINO_MAIN_MARKET),
        DEFAULT_RECENT_SLOT_DURATION_MS,
      );
      if (!market) throw new Error('Failed to load Kamino market');
      this.market = market;
      log.info('Kamino market loaded for loop strategy');
    }

    return { rpc: this.rpc, signer: this.signer, market: this.market };
  }

  // ── Read-only methods (API based, no wallet needed) ─────────────

  /**
   * Returns the effective APY accounting for leverage.
   * If spread is negative, returns supply-only APY.
   */
  async getApy(): Promise<number> {
    return withRetry(async () => {
      const res = await fetch(
        `${KAMINO_API}/kamino-market/${KAMINO_MAIN_MARKET}/reserves/metrics`,
      );
      if (!res.ok) throw new Error(`Kamino metrics fetch failed: ${res.status}`);
      const data = (await res.json()) as any[];
      const reserves = Array.isArray(data) ? data : [];

      const usdcReserve = reserves.find(
        (r: any) => r.liquidityToken === 'USDC' || r.liquidityTokenMint === MINTS.USDC,
      );
      const usdtReserve = reserves.find(
        (r: any) => r.liquidityToken === 'USDT' || r.liquidityTokenMint === MINTS.USDT,
      );

      const supplyApy = usdcReserve?.supplyApy ? parseFloat(usdcReserve.supplyApy) : 0;
      const borrowApy = usdtReserve?.borrowApy ? parseFloat(usdtReserve.borrowApy) : 0;
      const spread = supplyApy - borrowApy;

      if (spread < MIN_SPREAD_FOR_LEVERAGE) {
        // Negative spread — leverage loop would reduce yield.
        // Fall back to supply-only APY.
        log.debug(
          { supplyApy, borrowApy, spread },
          'Negative spread — reporting supply-only APY',
        );
        return supplyApy;
      }

      // Effective APY with leverage:
      //   leverage * supplyApy - (leverage - 1) * borrowApy
      const lev = this.targetLeverage;
      const effectiveApy = lev * supplyApy - (lev - 1) * borrowApy;

      log.debug(
        {
          supplyApy: (supplyApy * 100).toFixed(2),
          borrowApy: (borrowApy * 100).toFixed(2),
          spread: (spread * 100).toFixed(2),
          leverage: lev.toFixed(2),
          effectiveApy: (effectiveApy * 100).toFixed(2),
        },
        'Loop APY calculated',
      );

      return effectiveApy;
    }, 'kamino-loop-apy');
  }

  /**
   * Returns net USDC balance (supply - borrow converted to USDC).
   */
  async getBalance(): Promise<number> {
    return withRetry(async () => {
      const res = await fetch(
        `${KAMINO_API}/kamino-market/${KAMINO_MAIN_MARKET}/users/${this.walletAddress}/obligations`,
      );
      if (!res.ok) {
        log.warn({ status: res.status }, 'KaminoLoop balance fetch failed');
        return 0;
      }
      const data = (await res.json()) as any[];
      const obligations = Array.isArray(data) ? data : [];

      let totalSupply = 0;
      let totalBorrow = 0;

      for (const obligation of obligations) {
        const deposits = obligation?.deposits ?? obligation?.supplyPositions ?? [];
        const borrows = obligation?.borrows ?? obligation?.borrowPositions ?? [];

        for (const d of deposits) {
          if (d.mint === MINTS.USDC || d.symbol === 'USDC') {
            totalSupply += d.amount ?? d.balance ?? 0;
          }
        }
        for (const b of borrows) {
          if (b.mint === MINTS.USDT || b.symbol === 'USDT') {
            // USDT ≈ 1 USDC for net balance calculation
            totalBorrow += b.amount ?? b.balance ?? 0;
          }
        }
      }

      // Net equity = deposited USDC - borrowed USDT (both ~$1)
      return Math.max(totalSupply - totalBorrow, 0);
    }, 'kamino-loop-balance');
  }

  /**
   * Get the current health rate of the obligation.
   * Returns Infinity if no borrows.
   */
  async getHealthRate(): Promise<number> {
    return withRetry(async () => {
      const res = await fetch(
        `${KAMINO_API}/kamino-market/${KAMINO_MAIN_MARKET}/users/${this.walletAddress}/obligations`,
      );
      if (!res.ok) return Infinity;
      const data = (await res.json()) as any[];
      const obligations = Array.isArray(data) ? data : [];

      for (const obligation of obligations) {
        const healthRate = obligation?.healthRate ?? obligation?.health_rate;
        if (healthRate !== undefined && healthRate !== null) {
          return parseFloat(healthRate);
        }
      }
      return Infinity; // no borrows = infinitely healthy
    }, 'kamino-loop-health');
  }

  /**
   * USDC (collateral / supply-side) reserve utilization.
   * High utilization = withdrawals may be queued, early indicator of bank-run / exploit exit pressure.
   * Returns null if reserve data is unavailable.
   */
  async getSupplyUtilization(): Promise<number | null> {
    return withRetry(async () => {
      const { market } = await this.ensureInitialized();
      await market.loadReserves();
      const usdcReserve = market.getReserveByMint(address(MINTS.USDC));
      if (!usdcReserve) return null;
      return usdcReserve.calculateUtilizationRatio();
    }, 'kamino-loop-utilization').catch((err) => {
      log.warn({ error: (err as Error).message }, 'Failed to fetch supply utilization');
      return null;
    });
  }

  /**
   * Check if the current spread justifies leverage.
   */
  async isLeverageProfitable(): Promise<{
    profitable: boolean;
    supplyApy: number;
    borrowApy: number;
    spread: number;
  }> {
    const res = await fetch(
      `${KAMINO_API}/kamino-market/${KAMINO_MAIN_MARKET}/reserves/metrics`,
    );
    if (!res.ok) throw new Error(`Kamino metrics fetch failed: ${res.status}`);
    const data = (await res.json()) as any[];
    const reserves = Array.isArray(data) ? data : [];

    const usdcReserve = reserves.find(
      (r: any) => r.liquidityToken === 'USDC' || r.liquidityTokenMint === MINTS.USDC,
    );
    const usdtReserve = reserves.find(
      (r: any) => r.liquidityToken === 'USDT' || r.liquidityTokenMint === MINTS.USDT,
    );

    const supplyApy = usdcReserve?.supplyApy ? parseFloat(usdcReserve.supplyApy) : 0;
    const borrowApy = usdtReserve?.borrowApy ? parseFloat(usdtReserve.borrowApy) : 0;
    const spread = supplyApy - borrowApy;

    return {
      profitable: spread >= MIN_SPREAD_FOR_LEVERAGE,
      supplyApy,
      borrowApy,
      spread,
    };
  }

  // ── On-chain operations ──────────────────────���──────────────────

  /**
   * Build, sign, and send a Kamino transaction.
   */
  private async sendKaminoTx(
    kaminoAction: { setupIxs: any[]; lendingIxs: any[]; cleanupIxs: any[] },
    rpc: any,
    signer: KeyPairSigner,
  ): Promise<string> {
    const allIxs = [
      ...kaminoAction.setupIxs,
      ...kaminoAction.lendingIxs,
      ...kaminoAction.cleanupIxs,
    ];
    if (allIxs.length === 0) throw new Error('No instructions generated');

    const { value: latestBlockhash } = await rpc
      .getLatestBlockhash({ commitment: 'confirmed' })
      .send();

    const txMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayer(signer.address, msg),
      (msg) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
      (msg) => appendTransactionMessageInstructions(allIxs, msg),
    );

    const signedTx = await signTransactionMessageWithSigners(txMessage);
    const base64Tx = getBase64EncodedWireTransaction(signedTx);

    return rpc
      .sendTransaction(base64Tx, {
        encoding: 'base64',
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: BigInt(3),
      })
      .send();
  }

  /**
   * Swap USDT → USDC (or reverse) via Jupiter.
   * Returns the output amount in human units.
   */
  private async swapViaJupiter(
    inputMint: string,
    outputMint: string,
    amountHuman: number,
  ): Promise<{ outputAmount: number; txSig: string }> {
    const JUPITER_API = 'https://quote-api.jup.ag/v6';
    const baseUnits = Math.floor(amountHuman * 1e6); // both USDC/USDT have 6 decimals

    // Get quote
    const quoteParams = new URLSearchParams({
      inputMint,
      outputMint,
      amount: baseUnits.toString(),
      slippageBps: '10', // tight slippage for stablecoin pairs
    });
    const quoteRes = await fetch(`${JUPITER_API}/quote?${quoteParams}`);
    if (!quoteRes.ok) throw new Error(`Jupiter quote failed: ${quoteRes.status}`);
    const quoteData = (await quoteRes.json()) as any;

    // Get swap transaction
    const swapRes = await fetch(`${JUPITER_API}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quoteData,
        userPublicKey: this.walletAddress,
        wrapAndUnwrapSol: false,
      }),
    });
    if (!swapRes.ok) throw new Error(`Jupiter swap failed: ${swapRes.status}`);
    const swapData = (await swapRes.json()) as any;

    // Sign and send via RPC
    if (!this.rpc || !this.signer) throw new Error('Not initialized for on-chain ops');

    // Jupiter returns a versioned transaction — we need @solana/web3.js to handle it
    // since the swap tx format differs from klend-sdk transactions
    const { Connection, Keypair, VersionedTransaction } = await import('@solana/web3.js');
    const connection = new Connection(this.rpcUrl!, 'confirmed');
    const keypair = Keypair.fromSecretKey(this.secretKey!);

    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);

    const txSig = await connection.sendTransaction(tx, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    });

    const outputAmount = Number(quoteData.outAmount) / 1e6;
    log.info({ inputMint, outputMint, amountHuman, outputAmount, txSig }, 'Jupiter swap done');

    return { outputAmount, txSig };
  }

  /**
   * Deposit USDC and build leverage loop.
   *
   * Steps:
   *   1. Deposit initial USDC
   *   2. Check if leverage is profitable
   *   3. If yes: borrow USDT → swap to USDC → deposit → repeat
   *   4. If no: just deposit (supply-only fallback)
   */
  async deposit(amount: number): Promise<string> {
    const { rpc, signer, market } = await this.ensureInitialized();

    log.info({ amount, targetLeverage: this.targetLeverage }, 'KaminoLoop deposit starting');

    await market.loadReserves();

    // Step 1: Initial USDC deposit
    const amountBase = Math.floor(amount * 1e6).toString();
    const depositAction = await KaminoAction.buildDepositTxns(
      market,
      amountBase,
      address(MINTS.USDC),
      signer,
      new VanillaObligation(PROGRAM_ID),
      false,
      undefined,
    );
    const depositSig = await this.sendKaminoTx(depositAction, rpc, signer);
    log.info({ amount, depositSig }, 'Initial deposit complete');

    // Step 2: Check if leverage is profitable
    const { profitable, supplyApy, borrowApy, spread } = await this.isLeverageProfitable();
    if (!profitable) {
      log.info(
        { supplyApy, borrowApy, spread },
        'Spread negative — staying in supply-only mode',
      );
      return depositSig;
    }

    // Step 3: Build leverage via iterative loops
    // Total borrow target = (targetLeverage - 1) * initialAmount
    const totalBorrowTarget = (this.targetLeverage - 1) * amount;
    let totalBorrowed = 0;
    let loopCount = 0;
    const maxLoops = 5; // safety cap
    const txSigs = [depositSig];

    while (totalBorrowed < totalBorrowTarget * 0.95 && loopCount < maxLoops) {
      const remainingBorrow = totalBorrowTarget - totalBorrowed;
      // Each loop borrows up to 80% LTV of newly deposited collateral
      const loopBorrowAmount = Math.min(
        remainingBorrow,
        (amount * Math.pow(0.8, loopCount)) * 0.8, // conservative: use 80% of max
      );

      if (loopBorrowAmount < 1) break; // not worth the gas

      // 3a: Borrow USDT
      await market.loadReserves();
      const borrowBase = Math.floor(loopBorrowAmount * 1e6).toString();
      const borrowAction = await KaminoAction.buildBorrowTxns(
        market,
        borrowBase,
        address(MINTS.USDT),
        signer,
        new VanillaObligation(PROGRAM_ID),
        false,
        undefined,
      );
      const borrowSig = await this.sendKaminoTx(borrowAction, rpc, signer);
      txSigs.push(borrowSig);
      log.info({ loopCount, borrowAmount: loopBorrowAmount, borrowSig }, 'Borrow complete');

      // 3b: Swap USDT → USDC
      const { outputAmount: swappedUsdc, txSig: swapSig } = await this.swapViaJupiter(
        MINTS.USDT,
        MINTS.USDC,
        loopBorrowAmount,
      );
      txSigs.push(swapSig);

      // 3c: Deposit swapped USDC
      await market.loadReserves();
      const reDepositBase = Math.floor(swappedUsdc * 1e6).toString();
      const reDepositAction = await KaminoAction.buildDepositTxns(
        market,
        reDepositBase,
        address(MINTS.USDC),
        signer,
        new VanillaObligation(PROGRAM_ID),
        false,
        undefined,
      );
      const reDepositSig = await this.sendKaminoTx(reDepositAction, rpc, signer);
      txSigs.push(reDepositSig);

      totalBorrowed += loopBorrowAmount;
      loopCount++;

      log.info(
        {
          loopCount,
          totalBorrowed,
          totalBorrowTarget,
          reDepositSig,
        },
        'Loop iteration complete',
      );

      // Safety: check health after each loop
      const health = await this.getHealthRate();
      if (health < this.loopConfig.alertHealthRate) {
        log.warn({ health, alertThreshold: this.loopConfig.alertHealthRate }, 'Health below alert threshold — stopping loop');
        break;
      }
    }

    const finalHealth = await this.getHealthRate();
    log.info(
      {
        loops: loopCount,
        totalBorrowed,
        effectiveLeverage: 1 + totalBorrowed / amount,
        finalHealth,
        txCount: txSigs.length,
      },
      'KaminoLoop deposit complete',
    );

    return depositSig; // return first tx sig as the primary identifier
  }

  /**
   * Unwind leverage and withdraw USDC.
   *
   * Steps (reverse of deposit):
   *   1. Withdraw some USDC collateral
   *   2. Swap USDC → USDT
   *   3. Repay USDT debt
   *   4. Repeat until fully unwound
   *   5. Withdraw requested amount
   */
  async withdraw(amount: number): Promise<string> {
    const { rpc, signer, market } = await this.ensureInitialized();

    log.info({ amount }, 'KaminoLoop withdraw starting');

    // First check if we have any borrows to unwind
    const currentHealth = await this.getHealthRate();
    const currentBalance = await this.getBalance();

    if (currentHealth === Infinity) {
      // No borrows — simple withdrawal
      await market.loadReserves();
      const amountBase = Math.floor(amount * 1e6).toString();
      const withdrawAction = await KaminoAction.buildWithdrawTxns(
        market,
        amountBase,
        address(MINTS.USDC),
        signer,
        new VanillaObligation(PROGRAM_ID),
        false,
        undefined,
      );
      const sig = await this.sendKaminoTx(withdrawAction, rpc, signer);
      log.info({ amount, sig }, 'Simple withdraw (no leverage) complete');
      return sig;
    }

    // Need to unwind leverage proportionally
    // withdrawRatio = amount / netBalance
    const withdrawRatio = Math.min(amount / currentBalance, 1);
    const txSigs: string[] = [];
    let loopCount = 0;
    const maxLoops = 6;

    // Iteratively deleverage
    while (loopCount < maxLoops) {
      const health = await this.getHealthRate();
      if (health === Infinity) break; // fully unwound

      await market.loadReserves();

      // Calculate how much USDC we can safely withdraw while keeping health > emergency
      // Withdraw a conservative portion each iteration
      const res = await fetch(
        `${KAMINO_API}/kamino-market/${KAMINO_MAIN_MARKET}/users/${this.walletAddress}/obligations`,
      );
      if (!res.ok) break;
      const obligations = (await res.json()) as any[];
      let totalBorrow = 0;
      for (const obl of obligations) {
        const borrows = obl?.borrows ?? obl?.borrowPositions ?? [];
        for (const b of borrows) {
          if (b.mint === MINTS.USDT || b.symbol === 'USDT') {
            totalBorrow += b.amount ?? b.balance ?? 0;
          }
        }
      }

      if (totalBorrow < 1) break; // negligible debt

      // Repay a chunk: proportional to withdrawRatio, or all if full exit
      const repayAmount = withdrawRatio >= 0.99
        ? totalBorrow
        : Math.min(totalBorrow * withdrawRatio * 1.1, totalBorrow); // slightly over to account for interest

      // 1. Withdraw USDC to get funds for swap
      const withdrawForRepay = Math.ceil(repayAmount * 1.002); // 0.2% buffer for swap
      const withdrawBase = Math.floor(withdrawForRepay * 1e6).toString();
      const withdrawAction = await KaminoAction.buildWithdrawTxns(
        market,
        withdrawBase,
        address(MINTS.USDC),
        signer,
        new VanillaObligation(PROGRAM_ID),
        false,
        undefined,
      );
      const withdrawSig = await this.sendKaminoTx(withdrawAction, rpc, signer);
      txSigs.push(withdrawSig);

      // 2. Swap USDC → USDT for repayment
      const { outputAmount: usdtForRepay, txSig: swapSig } = await this.swapViaJupiter(
        MINTS.USDC,
        MINTS.USDT,
        withdrawForRepay,
      );
      txSigs.push(swapSig);

      // 3. Repay USDT
      await market.loadReserves();
      const repayBase = Math.floor(usdtForRepay * 1e6).toString();
      const { value: slotInfo } = await rpc.getSlot({ commitment: 'confirmed' }).send();
      const repayAction = await KaminoAction.buildRepayTxns(
        market,
        repayBase,
        address(MINTS.USDT),
        signer,
        new VanillaObligation(PROGRAM_ID),
        false,
        undefined,
        BigInt(slotInfo),
      );
      const repaySig = await this.sendKaminoTx(repayAction, rpc, signer);
      txSigs.push(repaySig);

      loopCount++;
      log.info(
        { loopCount, repayAmount: usdtForRepay, repaySig },
        'Deleverage iteration complete',
      );
    }

    // Final withdrawal of requested amount
    await market.loadReserves();
    const finalBase = Math.floor(amount * 1e6).toString();
    const finalAction = await KaminoAction.buildWithdrawTxns(
      market,
      finalBase,
      address(MINTS.USDC),
      signer,
      new VanillaObligation(PROGRAM_ID),
      false,
      undefined,
    );
    const finalSig = await this.sendKaminoTx(finalAction, rpc, signer);
    txSigs.push(finalSig);

    log.info(
      { amount, loops: loopCount, txCount: txSigs.length, finalSig },
      'KaminoLoop withdraw complete',
    );

    return finalSig;
  }

  /**
   * Emergency full deleverage — unwind all borrows without withdrawing.
   * Called when health drops below emergency threshold.
   * Leaves USDC deposited as supply-only (no leverage).
   */
  async emergencyDeleverage(): Promise<string[]> {
    const { rpc, signer, market } = await this.ensureInitialized();

    log.warn('EMERGENCY DELEVERAGE starting');

    const txSigs: string[] = [];
    let loopCount = 0;
    const maxLoops = 8;

    while (loopCount < maxLoops) {
      // Check remaining borrows
      const res = await fetch(
        `${KAMINO_API}/kamino-market/${KAMINO_MAIN_MARKET}/users/${this.walletAddress}/obligations`,
      );
      if (!res.ok) break;
      const obligations = (await res.json()) as any[];
      let totalBorrow = 0;
      for (const obl of obligations) {
        const borrows = obl?.borrows ?? obl?.borrowPositions ?? [];
        for (const b of borrows) {
          if (b.mint === MINTS.USDT || b.symbol === 'USDT') {
            totalBorrow += b.amount ?? b.balance ?? 0;
          }
        }
      }

      if (totalBorrow < 1) {
        log.info('Emergency deleverage complete — all borrows repaid');
        break;
      }

      await market.loadReserves();

      // Withdraw USDC to swap for USDT repayment
      const withdrawAmount = Math.ceil(totalBorrow * 1.005); // 0.5% buffer
      const withdrawBase = Math.floor(withdrawAmount * 1e6).toString();
      const withdrawAction = await KaminoAction.buildWithdrawTxns(
        market,
        withdrawBase,
        address(MINTS.USDC),
        signer,
        new VanillaObligation(PROGRAM_ID),
        false,
        undefined,
      );
      const withdrawSig = await this.sendKaminoTx(withdrawAction, rpc, signer);
      txSigs.push(withdrawSig);

      // Swap USDC → USDT
      const { outputAmount: usdtAmount, txSig: swapSig } = await this.swapViaJupiter(
        MINTS.USDC,
        MINTS.USDT,
        withdrawAmount,
      );
      txSigs.push(swapSig);

      // Repay USDT
      await market.loadReserves();
      const repayBase = Math.floor(usdtAmount * 1e6).toString();
      const { value: slotInfo } = await rpc.getSlot({ commitment: 'confirmed' }).send();
      const repayAction = await KaminoAction.buildRepayTxns(
        market,
        repayBase,
        address(MINTS.USDT),
        signer,
        new VanillaObligation(PROGRAM_ID),
        false,
        undefined,
        BigInt(slotInfo),
      );
      const repaySig = await this.sendKaminoTx(repayAction, rpc, signer);
      txSigs.push(repaySig);

      loopCount++;
      log.warn(
        { loopCount, repaid: usdtAmount, remainingBorrow: totalBorrow - usdtAmount },
        'Emergency deleverage iteration',
      );
    }

    const finalHealth = await this.getHealthRate();
    log.warn(
      { loops: loopCount, txCount: txSigs.length, finalHealth },
      'Emergency deleverage finished',
    );

    return txSigs;
  }

  /** Expose config for orchestrator health monitoring */
  getLoopConfig(): KaminoLoopConfig {
    return { ...this.loopConfig };
  }
}
