import { createChildLogger } from '../../utils/logger.js';
import { withRetry } from '../../utils/retry.js';
import type { LendingProtocol, CapacityInfo } from '../../types.js';
import { getOnycApy, isOnycToken } from './onre-apy.js';
import { getPrimeApy, isPrimeToken } from './hastra-apy.js';
import {
  KaminoMarket,
  MultiplyObligation,
  ObligationTypeTag,
  DEFAULT_RECENT_SLOT_DURATION_MS,
  PROGRAM_ID,
  getDepositWithLeverageIxs,
  getWithdrawWithLeverageIxs,
  type KaminoObligation,
} from '@kamino-finance/klend-sdk';
import { Farms } from '@kamino-finance/farms-sdk';
import Decimal from 'decimal.js';
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
  type Address,
  type Instruction,
  none,
} from '@solana/kit';

const log = createChildLogger('kamino-multiply');

const JUPITER_API = 'https://api.jup.ag/swap/v1';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY ?? '';

// Well-known stablecoin mints — price fixed at $1 for reward APR calculation
const STABLECOIN_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', // USDG
  'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',  // USDS
  'CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH', // CASH
]);

/** Price function for Kamino reward APR — stablecoins fixed at $1, others via Jupiter */
async function getRewardTokenPrice(mint: string): Promise<number> {
  if (STABLECOIN_MINTS.has(mint)) return 1;
  try {
    const res = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`);
    if (!res.ok) return 0;
    const data = (await res.json()) as any;
    return parseFloat(data.data?.[mint]?.price ?? '0');
  } catch {
    return 0;
  }
}

export interface KaminoMultiplyConfig {
  /** Kamino market address */
  market: string;
  /** Collateral token mint */
  collToken: string;
  /** Debt token mint */
  debtToken: string;
  /** Human-readable name for logging (e.g. "USDG/PYUSD", "ONyc/USDG") */
  label: string;
  /** Target health rate (default 1.15) */
  targetHealthRate: number;
  /** Alert when health drops below this (default 1.10) */
  alertHealthRate: number;
  /** Emergency deleverage below this (default 1.05) */
  emergencyHealthRate: number;
  /** Collateral token decimals (default 6) */
  collDecimals?: number;
  /** Debt token decimals (default 6) */
  debtDecimals?: number;
  /** Native yield of collateral token (for APY calculation, e.g. 0.05 = 5% for RWA tokens) */
  collNativeYield?: number;
  /** Enable reward claiming (default true) */
  claimRewards?: boolean;
  /**
   * Token held in wallet for deposit/withdraw (default: same as collToken).
   * When different from collToken, auto-swaps via Jupiter before deposit
   * and after withdraw. e.g. "USDC mint" when collToken is ONyc.
   */
  inputToken?: string;
  /** Decimals of inputToken (default: 6) */
  inputDecimals?: number;
}

/**
 * Kamino Multiply adapter — uses the official Multiply SDK
 * (flash-loan based, 1-2 tx) instead of manual deposit/borrow/swap loops.
 *
 * Supports any market and any collateral/debt token pair,
 * including RWA Loop (e.g. ONyc/USDG).
 */
export class KaminoMultiplyLending implements LendingProtocol {
  readonly name: string;
  private walletAddress: string;
  private rpc: any = null;
  private signer: KeyPairSigner | null = null;
  private market: KaminoMarket | null = null;
  private farms: Farms | null = null;
  private rpcUrl: string | null = null;
  private secretKey: Uint8Array | null = null;
  private cfg: Required<KaminoMultiplyConfig>;

  /** Calculated from targetHealthRate + on-chain LTV */
  private _targetLeverage: number | null = null;

  constructor(
    walletAddress: string,
    config: KaminoMultiplyConfig,
    rpcUrl?: string,
    secretKey?: Uint8Array,
  ) {
    this.walletAddress = walletAddress;
    this.rpcUrl = rpcUrl ?? null;
    this.secretKey = secretKey ?? null;
    this.cfg = {
      collDecimals: 6,
      debtDecimals: 6,
      collNativeYield: 0,
      claimRewards: true,
      inputToken: config.collToken, // default: deposit/withdraw in collateral token
      inputDecimals: 6,
      ...config,
    };
    this.name = `kamino-multiply:${this.cfg.label}`;

    log.info(
      { label: this.cfg.label, market: this.cfg.market, targetHealth: this.cfg.targetHealthRate },
      'KaminoMultiply initialized',
    );
  }

  // ── Initialization ────────────────────────────────────────────

  /**
   * Load RPC + market only (no signer required).
   * Used by read-only methods: getApy, getBalance, getHealthRate, getTargetLeverage.
   */
  private async ensureMarketLoaded(): Promise<{ rpc: any; market: KaminoMarket }> {
    if (!this.rpcUrl) {
      throw new Error('KaminoMultiply: rpcUrl required');
    }

    if (!this.rpc) {
      this.rpc = createSolanaRpc(this.rpcUrl as Parameters<typeof createSolanaRpc>[0]);
    }

    if (!this.market) {
      const m = await KaminoMarket.load(
        this.rpc,
        address(this.cfg.market),
        DEFAULT_RECENT_SLOT_DURATION_MS,
      );
      if (!m) throw new Error(`Failed to load Kamino market ${this.cfg.market}`);
      this.market = m;
      log.info({ market: this.cfg.market, label: this.cfg.label }, 'Kamino market loaded');
    }

    return { rpc: this.rpc, market: this.market };
  }

  /**
   * Full initialization including signer for on-chain writes.
   */
  private async ensureInitialized(): Promise<{
    rpc: any;
    signer: KeyPairSigner;
    market: KaminoMarket;
  }> {
    const { rpc, market } = await this.ensureMarketLoaded();

    if (!this.secretKey) {
      throw new Error('KaminoMultiply not configured for on-chain operations (no secretKey)');
    }

    if (!this.signer) {
      this.signer = await createKeyPairSignerFromBytes(this.secretKey);
    }

    if (!this.farms) {
      this.farms = new Farms(rpc);
    }

    return { rpc, signer: this.signer, market };
  }

  private getObligationType(): MultiplyObligation {
    return new MultiplyObligation(
      address(this.cfg.collToken),
      address(this.cfg.debtToken),
      PROGRAM_ID,
    );
  }

  /**
   * Get the target leverage based on on-chain LTV data.
   * Caches after first calculation.
   */
  async getTargetLeverage(): Promise<number> {
    if (this._targetLeverage) return this._targetLeverage;

    const { market } = await this.ensureMarketLoaded();
    const { liquidationLtv } = market.getMaxAndLiquidationLtvAndBorrowFactorForPair(
      address(this.cfg.collToken),
      address(this.cfg.debtToken),
    );

    // health = leverage * liqLtv / (leverage - 1)
    // => leverage = health / (health - liqLtv)
    const health = this.cfg.targetHealthRate;
    const liqLtv = liquidationLtv;

    if (health <= liqLtv) {
      log.warn({ health, liqLtv }, 'targetHealthRate <= liquidationLtv, capping leverage at 2x');
      this._targetLeverage = 2;
    } else {
      this._targetLeverage = Math.round((health / (health - liqLtv)) * 100) / 100;
    }

    const maxLeverage = market.getMaxLeverageForPair(
      address(this.cfg.collToken),
      address(this.cfg.debtToken),
    );

    // Cap at market max
    if (this._targetLeverage > maxLeverage) {
      log.warn(
        { calculated: this._targetLeverage, maxLeverage },
        'Target leverage exceeds market max, capping',
      );
      this._targetLeverage = maxLeverage;
    }

    log.info(
      { targetLeverage: this._targetLeverage, liquidationLtv: liqLtv, maxLeverage },
      'Target leverage calculated',
    );

    return this._targetLeverage;
  }

  // ── Jupiter quoter/swapper for SDK ────────────────────────────

  private createQuoter() {
    const walletAddress = this.walletAddress;
    return async (inputs: { inputAmountLamports: Decimal; inputMint: Address; outputMint: Address }, _klendAccounts: Address[]) => {
      const params = new URLSearchParams({
        inputMint: inputs.inputMint,
        outputMint: inputs.outputMint,
        amount: inputs.inputAmountLamports.floor().toString(),
        slippageBps: '10',
      });
      const headers: Record<string, string> = {};
      if (JUPITER_API_KEY) headers['x-api-key'] = JUPITER_API_KEY;
      const res = await fetch(`${JUPITER_API}/quote?${params}`, { headers });
      if (!res.ok) throw new Error(`Jupiter quote failed: ${res.status}`);
      const data = (await res.json()) as any;

      const outAmount = new Decimal(data.outAmount);
      const inAmount = new Decimal(data.inAmount);
      const priceAInB = outAmount.div(inAmount);

      return {
        priceAInB,
        quoteResponse: data,
      };
    };
  }

  private createSwapper() {
    const walletAddress = this.walletAddress;
    return async (
      inputs: { inputAmountLamports: Decimal; inputMint: Address; outputMint: Address },
      _klendAccounts: Address[],
      quote: { priceAInB: Decimal; quoteResponse?: any },
    ) => {
      const quoteResponse = quote.quoteResponse;
      if (!quoteResponse) throw new Error('No quote response for swap');

      const swapHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (JUPITER_API_KEY) swapHeaders['x-api-key'] = JUPITER_API_KEY;
      const swapRes = await fetch(`${JUPITER_API}/swap-instructions`, {
        method: 'POST',
        headers: swapHeaders,
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: walletAddress,
          wrapAndUnwrapSol: true,
          useSharedAccounts: true,
          asLegacyTransaction: false,
        }),
      });
      if (!swapRes.ok) throw new Error(`Jupiter swap-instructions failed: ${swapRes.status}`);
      const swapData = (await swapRes.json()) as any;

      // Deserialize instructions from Jupiter
      const { deserializeInstruction } = await import('./jupiter-ix-utils.js');
      const computeBudgetIxs = (swapData.computeBudgetInstructions ?? []).map(deserializeInstruction);
      const swapIxs = swapData.swapInstruction ? [deserializeInstruction(swapData.swapInstruction)] : [];
      const setupIxs = (swapData.setupInstructions ?? []).map(deserializeInstruction);
      const cleanupIx = swapData.cleanupInstruction ? [deserializeInstruction(swapData.cleanupInstruction)] : [];

      // Fetch ALT accounts via @solana/web3.js (more reliable)
      const { Connection, PublicKey, AddressLookupTableAccount } = await import('@solana/web3.js');
      const conn = new Connection(this.rpcUrl!, 'confirmed');
      const lookupTables: any[] = [];
      for (const addr of swapData.addressLookupTableAddresses ?? []) {
        try {
          const ltResult = await conn.getAddressLookupTable(new PublicKey(addr));
          if (ltResult.value) lookupTables.push(ltResult.value);
        } catch { /* skip */ }
      }

      return [{
        preActionIxs: [...setupIxs],
        swapIxs: [...swapIxs, ...cleanupIx],
        lookupTables,
        quote: { priceAInB: quote.priceAInB, quoteResponse },
      }];
    };
  }

  // ── Read-only methods ────────────────��────────────────────────

  /**
   * Returns effective APY including leverage and native yield.
   */
  async getApy(): Promise<number> {
    return withRetry(async () => {
      const { market } = await this.ensureMarketLoaded();
      await market.loadReserves();

      const slotResult = await this.rpc.getSlot({ commitment: 'confirmed' }).send();
      const slot = typeof slotResult === 'object' && slotResult !== null ? (slotResult as any).value ?? slotResult : slotResult;

      const collReserve = market.getReserveByMint(address(this.cfg.collToken));
      const debtReserve = market.getReserveByMint(address(this.cfg.debtToken));
      if (!collReserve || !debtReserve) {
        log.warn('Reserve not found for APY calculation');
        return 0;
      }

      // Resolve native yield dynamically for RWA tokens
      let nativeYield = this.cfg.collNativeYield;
      let nativeYieldSource: 'onchain' | 'api' | 'fallback' | 'config' = 'config';

      if (isOnycToken(this.cfg.collToken) && this.rpcUrl) {
        const onreResult = await getOnycApy(this.rpcUrl, this.cfg.collToken, this.cfg.collNativeYield);
        nativeYield = onreResult.apy;
        nativeYieldSource = onreResult.source;
      } else if (isPrimeToken(this.cfg.collToken)) {
        const hastraResult = await getPrimeApy(this.cfg.collNativeYield);
        nativeYield = hastraResult.apy;
        nativeYieldSource = hastraResult.source;
      }

      const baseSupplyApy = collReserve.totalSupplyAPY(BigInt(slot));
      const baseBorrowApy = debtReserve.totalBorrowAPY(BigInt(slot));

      // Fetch farm reward APRs (deposit rewards on collateral, borrow rewards on debt)
      let depositRewardApr = 0;
      let borrowRewardApr = 0;
      try {
        const collFarmInfo = await market.getReserveFarmInfo(
          address(this.cfg.collToken),
          getRewardTokenPrice as any,
        );
        depositRewardApr = collFarmInfo.depositingRewards.rewardApr.toNumber();
      } catch { /* no deposit farm */ }
      try {
        const debtFarmInfo = await market.getReserveFarmInfo(
          address(this.cfg.debtToken),
          getRewardTokenPrice as any,
        );
        borrowRewardApr = debtFarmInfo.borrowingRewards.rewardApr.toNumber();
      } catch { /* no borrow farm */ }

      const supplyApy = baseSupplyApy + nativeYield + depositRewardApr;
      const borrowApy = baseBorrowApy - borrowRewardApr; // rewards reduce effective borrow cost

      const leverage = await this.getTargetLeverage();
      const effectiveApy = leverage * supplyApy - (leverage - 1) * borrowApy;

      log.debug(
        {
          label: this.cfg.label,
          baseSupplyApy: (baseSupplyApy * 100).toFixed(2),
          baseBorrowApy: (baseBorrowApy * 100).toFixed(2),
          nativeYield: (nativeYield * 100).toFixed(2),
          nativeYieldSource,
          depositRewardApr: (depositRewardApr * 100).toFixed(2),
          borrowRewardApr: (borrowRewardApr * 100).toFixed(2),
          leverage: leverage.toFixed(2),
          effectiveApy: (effectiveApy * 100).toFixed(2),
        },
        'Multiply APY calculated',
      );

      return effectiveApy;
    }, 'kamino-multiply-apy');
  }

  /**
   * Returns net equity (deposited collateral value - borrowed debt value) in USD terms.
   */
  async getBalance(): Promise<number> {
    return withRetry(async () => {
      const { market } = await this.ensureMarketLoaded();
      await market.loadReserves();

      const obligation = await market.getObligationByWallet(
        address(this.walletAddress),
        this.getObligationType(),
      );
      if (!obligation) return 0;

      const stats = obligation.refreshedStats;
      const netValue = stats.userTotalDeposit.minus(stats.userTotalBorrow).toNumber();
      return Math.max(netValue, 0);
    }, 'kamino-multiply-balance');
  }

  /**
   * Get deposit capacity info for the collateral reserve.
   */
  async getCapacity(): Promise<CapacityInfo> {
    return withRetry(async () => {
      const { market } = await this.ensureMarketLoaded();
      await market.loadReserves();

      const collReserve = market.getReserveByMint(address(this.cfg.collToken));
      if (!collReserve) {
        throw new Error(`Collateral reserve not found: ${this.cfg.collToken}`);
      }

      const slotResult = await this.rpc.getSlot({ commitment: 'confirmed' }).send();
      const slot = typeof slotResult === 'object' && slotResult !== null ? (slotResult as any).value ?? slotResult : slotResult;

      const depositLimit = new Decimal(collReserve.state.config.depositLimit.toString())
        .div(new Decimal(10).pow(this.cfg.collDecimals))
        .toNumber();
      const totalSupply = collReserve.getTotalSupply()
        .div(new Decimal(10).pow(this.cfg.collDecimals))
        .toNumber();
      const remaining = Math.max(depositLimit - totalSupply, 0);
      const utilizationRatio = collReserve.calculateUtilizationRatio();

      let dailyCapRemaining: number | null = null;
      try {
        const capCurrent = collReserve.getDepositWithdrawalCapCurrent(BigInt(slot));
        const capCapacity = collReserve.getDepositWithdrawalCapCapacity();
        if (capCapacity.gt(0)) {
          dailyCapRemaining = capCurrent
            .div(new Decimal(10).pow(this.cfg.collDecimals))
            .toNumber();
        }
      } catch { /* no daily cap configured */ }

      log.debug(
        {
          label: this.cfg.label,
          depositLimit: depositLimit.toFixed(0),
          totalSupply: totalSupply.toFixed(0),
          remaining: remaining.toFixed(0),
          utilizationRatio: (utilizationRatio * 100).toFixed(1),
          dailyCapRemaining,
        },
        'Capacity info',
      );

      return { depositLimit, totalSupply, remaining, utilizationRatio, dailyCapRemaining };
    }, 'kamino-multiply-capacity');
  }

  /**
   * Get current health rate from on-chain obligation data.
   */
  async getHealthRate(): Promise<number> {
    return withRetry(async () => {
      const { market } = await this.ensureMarketLoaded();
      await market.loadReserves();

      const obligation = await market.getObligationByWallet(
        address(this.walletAddress),
        this.getObligationType(),
      );
      if (!obligation) return Infinity; // no position

      const stats = obligation.refreshedStats;
      if (stats.userTotalBorrow.isZero()) return Infinity;

      // health = borrowLiquidationLimit / userTotalBorrow
      const health = stats.borrowLiquidationLimit.div(stats.userTotalBorrow).toNumber();
      return health;
    }, 'kamino-multiply-health');
  }

  /**
   * Get the on-chain obligation (position data). Returns null if no position.
   */
  async getObligation(): Promise<KaminoObligation | null> {
    const { market } = await this.ensureMarketLoaded();
    await market.loadReserves();
    return market.getObligationByWallet(
      address(this.walletAddress),
      this.getObligationType(),
    );
  }

  // ── Token swap helper ──────────────────────────────────────────

  /** Whether the wallet's input token differs from the collateral token */
  private needsInputSwap(): boolean {
    return this.cfg.inputToken !== this.cfg.collToken;
  }

  /**
   * Swap inputToken → collToken (before deposit) or collToken → inputToken (after withdraw).
   * Uses Jupiter v6 swap API. Returns output amount in human units and tx signature.
   */
  private async jupiterSwap(
    inputMint: string,
    outputMint: string,
    amountHuman: number,
    inputDecimals: number,
  ): Promise<{ outputAmount: number; txSig: string }> {
    const baseUnits = Math.floor(amountHuman * Math.pow(10, inputDecimals));

    // Quote
    const quoteParams = new URLSearchParams({
      inputMint,
      outputMint,
      amount: baseUnits.toString(),
      slippageBps: '50', // 0.5% — slightly wider for non-stable pairs like USDC→ONyc
    });
    const quoteHeaders: Record<string, string> = {};
    if (JUPITER_API_KEY) quoteHeaders['x-api-key'] = JUPITER_API_KEY;
    const quoteRes = await fetch(`${JUPITER_API}/quote?${quoteParams}`, { headers: quoteHeaders });
    if (!quoteRes.ok) throw new Error(`Jupiter quote failed: ${quoteRes.status}`);
    const quoteData = (await quoteRes.json()) as any;

    // Swap transaction
    const swapHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (JUPITER_API_KEY) swapHeaders['x-api-key'] = JUPITER_API_KEY;
    const swapRes = await fetch(`${JUPITER_API}/swap`, {
      method: 'POST',
      headers: swapHeaders,
      body: JSON.stringify({
        quoteResponse: quoteData,
        userPublicKey: this.walletAddress,
        wrapAndUnwrapSol: true,
      }),
    });
    if (!swapRes.ok) throw new Error(`Jupiter swap failed: ${swapRes.status}`);
    const swapData = (await swapRes.json()) as any;

    // Sign and send via @solana/web3.js (Jupiter returns versioned tx)
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

    const outputDecimals = outputMint === this.cfg.collToken ? this.cfg.collDecimals : (this.cfg.inputDecimals ?? 6);
    const outputAmount = Number(quoteData.outAmount) / Math.pow(10, outputDecimals);

    log.info(
      { inputMint: inputMint.slice(0, 8), outputMint: outputMint.slice(0, 8), amountHuman, outputAmount, txSig },
      'Jupiter swap complete',
    );

    return { outputAmount, txSig };
  }

  // ── On-chain operations ───────────────────────────────────────

  /**
   * Send instructions as a versioned transaction with Address Lookup Tables.
   * Uses @solana/web3.js for reliable ALT support (required for Multiply flash loans).
   */
  private async sendIxs(
    ixs: Instruction[],
    lookupTables: any[] = [],
    _rpc: any,
    signer: KeyPairSigner,
  ): Promise<string> {
    if (ixs.length === 0) throw new Error('No instructions to send');

    const {
      Connection, Keypair, VersionedTransaction, TransactionMessage,
      PublicKey, TransactionInstruction, AddressLookupTableAccount,
    } = await import('@solana/web3.js');

    const connection = new Connection(this.rpcUrl!, 'confirmed');
    const keypair = Keypair.fromSecretKey(this.secretKey!);

    // Convert @solana/kit instructions to @solana/web3.js format
    const web3Ixs = ixs.map((ix) => new TransactionInstruction({
      programId: new PublicKey(ix.programAddress),
      keys: (ix.accounts ?? []).map((acc: any) => ({
        pubkey: new PublicKey(acc.address),
        isSigner: acc.role === 2 || acc.role === 3,
        isWritable: acc.role === 1 || acc.role === 3,
      })),
      data: Buffer.from(ix.data as Uint8Array),
    }));

    // Convert lookup tables — may be @solana/web3.js AddressLookupTableAccount or raw objects
    const web3ALTs: InstanceType<typeof AddressLookupTableAccount>[] = [];
    for (const lt of lookupTables) {
      try {
        // Already a web3.js AddressLookupTableAccount
        if (lt && lt.key && lt.state && lt.state.addresses) {
          web3ALTs.push(lt as any);
          continue;
        }
        // Raw address — fetch from chain
        const key = lt?.address ?? lt?.key;
        if (!key) continue;
        const ltAddress = new PublicKey(typeof key === 'string' ? key : key.toString());
        const ltAccount = await connection.getAddressLookupTable(ltAddress);
        if (ltAccount.value) {
          web3ALTs.push(ltAccount.value);
        }
      } catch {
        // Skip invalid lookup tables
      }
    }

    const { blockhash } = await connection.getLatestBlockhash('confirmed');

    const messageV0 = new (TransactionMessage as any)({
      payerKey: keypair.publicKey,
      recentBlockhash: blockhash,
      instructions: web3Ixs,
    }).compileToV0Message(web3ALTs);

    log.debug({ ixCount: web3Ixs.length, altCount: web3ALTs.length, altKeys: web3ALTs.map(a => a.key.toBase58().slice(0,8)) }, 'Building v0 transaction');

    const tx = new VersionedTransaction(messageV0);
    tx.sign([keypair]);

    log.debug({ txSize: tx.serialize().length }, 'Transaction serialized');

    const sig = await connection.sendTransaction(tx, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    });

    log.info({ sig, ixCount: ixs.length, altCount: web3ALTs.length }, 'Transaction sent');
    return sig;
  }

  /**
   * Deposit and build leveraged Multiply position via SDK flash loan.
   *
   * When inputToken differs from collToken (e.g. USDC → ONyc),
   * automatically swaps via Jupiter before depositing.
   *
   * @param amount - Amount in inputToken units (e.g. USDC amount)
   */
  async deposit(amount: number): Promise<string> {
    const { rpc, signer, market } = await this.ensureInitialized();
    await market.loadReserves();

    // Step 0: Swap inputToken → collToken if needed
    let collAmount = amount;
    const swapTxSigs: string[] = [];

    if (this.needsInputSwap()) {
      log.info(
        { from: this.cfg.inputToken!.slice(0, 8), to: this.cfg.collToken.slice(0, 8), amount },
        'Pre-deposit swap: inputToken → collToken',
      );
      const { outputAmount, txSig } = await this.jupiterSwap(
        this.cfg.inputToken!,
        this.cfg.collToken,
        amount,
        this.cfg.inputDecimals ?? 6,
      );
      collAmount = outputAmount;
      swapTxSigs.push(txSig);
    }

    const targetLeverage = await this.getTargetLeverage();
    const slotResult = await rpc.getSlot({ commitment: 'confirmed' }).send();
    const slot = typeof slotResult === 'object' && slotResult !== null ? (slotResult as any).value ?? slotResult : slotResult;

    // Get existing obligation if any
    const existingObligation = await market.getObligationByWallet(
      address(this.walletAddress),
      this.getObligationType(),
    );

    // Price: how much collateral per 1 debt token
    const collReserve = market.getReserveByMint(address(this.cfg.collToken));
    const debtReserve = market.getReserveByMint(address(this.cfg.debtToken));
    if (!collReserve || !debtReserve) throw new Error('Reserves not found');

    // Use Scope oracle prices from market for price ratio
    const collPrice = collReserve.getOracleMarketPrice();
    const debtPrice = debtReserve.getOracleMarketPrice();
    const priceDebtToColl = debtPrice.div(collPrice);

    log.info(
      {
        inputAmount: amount,
        collAmount,
        targetLeverage,
        label: this.cfg.label,
        priceDebtToColl: priceDebtToColl.toFixed(6),
        hasExistingPosition: !!existingObligation,
        swapped: this.needsInputSwap(),
      },
      'Multiply deposit starting',
    );

    const depositLamports = new Decimal(collAmount).mul(new Decimal(10).pow(this.cfg.collDecimals));

    const responses = await getDepositWithLeverageIxs({
      owner: signer,
      kaminoMarket: market,
      collTokenMint: address(this.cfg.collToken),
      debtTokenMint: address(this.cfg.debtToken),
      depositAmount: depositLamports,
      targetLeverage: new Decimal(targetLeverage),
      priceDebtToColl,
      slippagePct: new Decimal(0.01), // 1%
      obligation: existingObligation,
      obligationTypeTagOverride: ObligationTypeTag.Multiply,
      referrer: none(),
      currentSlot: BigInt(slot),
      selectedTokenMint: address(this.cfg.collToken),
      scopeRefreshIx: [],
      quoteBufferBps: new Decimal(10),
      quoter: this.createQuoter(),
      swapper: this.createSwapper(),
      useV2Ixs: false,
    });

    // Each response is a separate transaction
    const txSigs: string[] = [];
    for (const resp of responses) {
      const sig = await this.sendIxs(resp.ixs, resp.lookupTables, rpc, signer);
      txSigs.push(sig);
      log.info({ sig }, 'Multiply deposit tx sent');
    }

    const finalHealth = await this.getHealthRate();
    log.info(
      { amount, targetLeverage, txCount: txSigs.length, finalHealth, label: this.cfg.label },
      'Multiply deposit complete',
    );

    return txSigs[0]!;
  }

  /**
   * Withdraw from Multiply position, automatically deleveraging.
   */
  async withdraw(amount: number): Promise<string> {
    const { rpc, signer, market } = await this.ensureInitialized();
    await market.loadReserves();

    const obligation = await market.getObligationByWallet(
      address(this.walletAddress),
      this.getObligationType(),
    );
    if (!obligation) throw new Error('No Multiply position found to withdraw from');

    const slotResult = await rpc.getSlot({ commitment: 'confirmed' }).send();
    const slot = typeof slotResult === 'object' && slotResult !== null ? (slotResult as any).value ?? slotResult : slotResult;

    const stats = obligation.refreshedStats;
    const deposited = stats.userTotalDeposit;
    const borrowed = stats.userTotalBorrow;
    const netValue = deposited.minus(borrowed);

    const isClosingPosition = new Decimal(amount).gte(netValue.mul(0.99));

    const collReserve = market.getReserveByMint(address(this.cfg.collToken));
    const debtReserve = market.getReserveByMint(address(this.cfg.debtToken));
    if (!collReserve || !debtReserve) throw new Error('Reserves not found');

    const collPrice = collReserve.getOracleMarketPrice();
    const debtPrice = debtReserve.getOracleMarketPrice();
    const priceCollToDebt = collPrice.div(debtPrice);

    const withdrawLamports = new Decimal(amount).mul(new Decimal(10).pow(this.cfg.collDecimals));

    // Get SOL balance for fee calculation
    const solBalResult = await rpc
      .getBalance(address(this.walletAddress), { commitment: 'confirmed' })
      .send();
    const solBalance = typeof solBalResult === 'object' && solBalResult !== null ? (solBalResult as any).value ?? solBalResult : solBalResult;

    log.info(
      { amount, isClosingPosition, deposited: deposited.toFixed(2), borrowed: borrowed.toFixed(2), label: this.cfg.label },
      'Multiply withdraw starting',
    );

    const responses = await getWithdrawWithLeverageIxs({
      owner: signer,
      kaminoMarket: market,
      collTokenMint: address(this.cfg.collToken),
      debtTokenMint: address(this.cfg.debtToken),
      obligation,
      deposited,
      borrowed,
      withdrawAmount: withdrawLamports,
      priceCollToDebt,
      slippagePct: new Decimal(0.01),
      isClosingPosition,
      selectedTokenMint: address(this.cfg.collToken),
      referrer: none(),
      currentSlot: BigInt(slot),
      scopeRefreshIx: [],
      quoteBufferBps: new Decimal(10),
      quoter: this.createQuoter(),
      swapper: this.createSwapper(),
      useV2Ixs: false,
      budgetAndPriorityFeeIxs: [],
      userSolBalanceLamports: Number(solBalance),
    });

    const txSigs: string[] = [];
    for (const resp of responses) {
      const sig = await this.sendIxs(resp.ixs, resp.lookupTables, rpc, signer);
      txSigs.push(sig);
      log.info({ sig }, 'Multiply withdraw tx sent');
    }

    // Post-withdraw swap: collToken → inputToken if needed
    if (this.needsInputSwap()) {
      // Withdraw gives us collToken (e.g. ONyc), swap back to inputToken (e.g. USDC)
      // Use the withdrawn amount (approximate — actual amount may differ slightly)
      log.info(
        { from: this.cfg.collToken.slice(0, 8), to: this.cfg.inputToken!.slice(0, 8), amount },
        'Post-withdraw swap: collToken → inputToken',
      );
      try {
        const { txSig: swapSig } = await this.jupiterSwap(
          this.cfg.collToken,
          this.cfg.inputToken!,
          amount, // approximate: withdraw amount in collToken units
          this.cfg.collDecimals,
        );
        txSigs.push(swapSig);
      } catch (err) {
        log.error({ error: (err as Error).message }, 'Post-withdraw swap failed — collToken remains in wallet');
      }
    }

    log.info(
      { amount, isClosingPosition, txCount: txSigs.length, label: this.cfg.label },
      'Multiply withdraw complete',
    );

    return txSigs[0]!;
  }

  /**
   * Emergency: close entire position (full deleverage + withdraw).
   */
  async emergencyDeleverage(): Promise<string[]> {
    log.warn({ label: this.cfg.label }, 'EMERGENCY DELEVERAGE starting');

    const balance = await this.getBalance();
    if (balance < 0.01) {
      log.info('No position to deleverage');
      return [];
    }

    // Withdraw everything (isClosingPosition = true)
    const sig = await this.withdraw(balance);
    log.warn({ sig, label: this.cfg.label }, 'Emergency deleverage complete');
    return [sig];
  }

  /**
   * Claim pending farm rewards for this Multiply position.
   * Returns claimed reward amounts.
   */
  async claimRewards(): Promise<{ mint: string; amount: number; txSig: string }[]> {
    if (!this.cfg.claimRewards) return [];

    const { rpc, signer, market } = await this.ensureInitialized();
    if (!this.farms) this.farms = new Farms(rpc);

    await market.loadReserves();

    const collReserve = market.getReserveByMint(address(this.cfg.collToken));
    if (!collReserve) return [];

    const farmOption = collReserve.getCollateralFarmAddress();
    if (!farmOption || (farmOption as any).__option === 'None') {
      log.debug({ label: this.cfg.label }, 'No collateral farm found');
      return [];
    }
    const farmAddress = (farmOption as any).value ?? farmOption;

    try {
      const claimIxs = await this.farms.claimForUserForFarmAllRewardsIx(
        signer,
        address(this.walletAddress),
        farmAddress as Address,
        false, // isDelegated
      );

      if (claimIxs.length === 0) {
        log.debug('No rewards to claim');
        return [];
      }

      const sig = await this.sendIxs(claimIxs, [], rpc, signer);
      log.info({ sig, label: this.cfg.label }, 'Rewards claimed');

      // We don't easily know exact amounts claimed from the tx,
      // so return the sig for tracking
      return [{ mint: 'unknown', amount: 0, txSig: sig }];
    } catch (err) {
      log.warn({ error: (err as Error).message, label: this.cfg.label }, 'Reward claim failed');
      return [];
    }
  }

  /** Expose config for orchestrator health monitoring */
  getMultiplyConfig(): KaminoMultiplyConfig {
    return { ...this.cfg };
  }
}
