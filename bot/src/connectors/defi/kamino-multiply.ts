import { createChildLogger } from '../../utils/logger.js';
import { withRetry } from '../../utils/retry.js';
import type { LendingProtocol, CapacityInfo } from '../../types.js';
import { getOnycApy, isOnycToken } from './onre-apy.js';
import { getPrimeApy, isPrimeToken } from './hastra-apy.js';
import {
  KaminoMarket,
  KaminoAction,
  MultiplyObligation,
  DEFAULT_RECENT_SLOT_DURATION_MS,
  PROGRAM_ID,
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

export function calculateDailyCapRemaining(
  capCapacity: Decimal,
  capCurrent: Decimal,
  decimals: number,
): number {
  return capCapacity
    .sub(capCurrent)
    .div(new Decimal(10).pow(decimals))
    .toNumber();
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
   * Get current actual leverage from on-chain obligation data.
   * leverage = totalDeposit / (totalDeposit - totalBorrow)
   */
  async getCurrentLeverage(): Promise<number> {
    return withRetry(async () => {
      const { market } = await this.ensureMarketLoaded();
      await market.loadReserves();

      const obligation = await market.getObligationByWallet(
        address(this.walletAddress),
        this.getObligationType(),
      );
      if (!obligation) return 1;

      const stats = obligation.refreshedStats;
      const deposit = stats.userTotalDeposit.toNumber();
      const borrow = stats.userTotalBorrow.toNumber();
      const equity = deposit - borrow;

      if (equity <= 0) return 1;
      return Math.round((deposit / equity) * 100) / 100;
    }, 'kamino-multiply-current-leverage');
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

      // Use actual on-chain leverage if position exists, otherwise target leverage
      let leverage: number;
      try {
        const currentLev = await this.getCurrentLeverage();
        leverage = currentLev > 1 ? currentLev : await this.getTargetLeverage();
      } catch {
        leverage = await this.getTargetLeverage();
      }
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
          dailyCapRemaining = calculateDailyCapRemaining(
            capCapacity,
            capCurrent,
            this.cfg.collDecimals,
          );
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
   * Send a KaminoAction transaction via @solana/kit.
   */
  private async sendKaminoTx(
    kaminoAction: { setupIxs: any[]; lendingIxs: any[]; cleanupIxs: any[] },
    rpc: any,
    signer: KeyPairSigner,
  ): Promise<string> {
    const allIxs = [...kaminoAction.setupIxs, ...kaminoAction.lendingIxs, ...kaminoAction.cleanupIxs];
    if (allIxs.length === 0) throw new Error('No instructions');

    const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const txMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayer(signer.address, msg),
      (msg) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
      (msg) => appendTransactionMessageInstructions(allIxs, msg),
    );
    const signedTx = await signTransactionMessageWithSigners(txMessage);
    const base64Tx = getBase64EncodedWireTransaction(signedTx);
    return rpc.sendTransaction(base64Tx, {
      encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: BigInt(3),
    }).send();
  }

  /**
   * Deposit and build leveraged Multiply position via manual loop.
   *
   * @param amount - Amount in inputToken units (e.g. USDC amount)
   */
  async deposit(amount: number): Promise<string> {
    const { rpc, signer, market } = await this.ensureInitialized();

    const targetLeverage = await this.getTargetLeverage();
    const maxLtv = 0.60;
    const maxLoops = 5;
    const txSigs: string[] = [];
    const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

    log.info({ amount, targetLeverage, label: this.cfg.label }, 'Multiply deposit starting (manual loop)');

    // Step 0: Check for existing collToken balance in wallet (e.g. stranded from previous failed deposit/withdraw)
    let existingCollBalance = 0;
    if (this.needsInputSwap() && this.rpcUrl) {
      try {
        const { Connection, PublicKey } = await import('@solana/web3.js');
        const conn = new Connection(this.rpcUrl, 'confirmed');
        const tokenAccounts = await conn.getParsedTokenAccountsByOwner(
          new PublicKey(this.walletAddress),
          { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') },
        );
        const collAccount = tokenAccounts.value.find(t => t.account.data.parsed.info.mint === this.cfg.collToken);
        existingCollBalance = collAccount ? parseFloat(collAccount.account.data.parsed.info.tokenAmount.uiAmountString) : 0;
        if (existingCollBalance > 0.001) {
          log.info({ existingCollBalance, token: this.cfg.collToken.slice(0, 8) }, 'Found existing collToken balance in wallet');
        }
      } catch (err) {
        log.warn({ error: (err as Error).message }, 'Failed to fetch existing collToken balance');
      }
    }

    // Step 1: Swap inputToken → collToken if needed
    let collAmount = existingCollBalance;
    if (this.needsInputSwap()) {
      log.info({ from: this.cfg.inputToken!.slice(0, 8), to: this.cfg.collToken.slice(0, 8), amount }, 'Swap inputToken → collToken');
      const { outputAmount, txSig } = await this.jupiterSwap(this.cfg.inputToken!, this.cfg.collToken, amount, this.cfg.inputDecimals ?? 6);
      collAmount += outputAmount;
      txSigs.push(txSig);
      await wait(2000);
    } else {
      collAmount += amount;
    }

    // Step 2: Initial deposit
    await market.loadReserves();
    const depositBase = Math.floor(collAmount * Math.pow(10, this.cfg.collDecimals)).toString();
    const depositAction = await KaminoAction.buildDepositTxns(market, depositBase, address(this.cfg.collToken), signer, this.getObligationType(), false, undefined);
    const depositSig = await this.sendKaminoTx(depositAction, rpc, signer);
    txSigs.push(depositSig);
    log.info({ collAmount, sig: depositSig }, 'Initial deposit complete');
    await wait(2000);

    // Step 3-5: Leverage loops
    for (let loop = 0; loop < maxLoops; loop++) {
      await market.loadReserves();
      const obl = await market.getObligationByWallet(signer.address, this.getObligationType());
      if (!obl) break;

      const stats = obl.refreshedStats;
      const deposited = stats.userTotalDeposit.toNumber();
      const borrowed = stats.userTotalBorrow.toNumber();
      const health = borrowed > 0 ? stats.borrowLiquidationLimit.div(stats.userTotalBorrow).toNumber() : Infinity;

      log.info({ loop: loop + 1, deposited, borrowed, health }, 'Loop status');

      if (health !== Infinity && health <= this.cfg.targetHealthRate * 1.02) {
        log.info({ health, target: this.cfg.targetHealthRate }, 'Target health reached');
        break;
      }

      const maxBorrow = deposited * maxLtv - borrowed;
      if (maxBorrow < 1) break;

      // Borrow debtToken
      await market.loadReserves();
      const borrowBase = Math.floor(maxBorrow * Math.pow(10, this.cfg.debtDecimals)).toString();
      const borrowAction = await KaminoAction.buildBorrowTxns(market, borrowBase, address(this.cfg.debtToken), signer, this.getObligationType(), false, undefined);
      const borrowSig = await this.sendKaminoTx(borrowAction, rpc, signer);
      txSigs.push(borrowSig);
      log.info({ loop: loop + 1, borrowAmount: maxBorrow, sig: borrowSig }, 'Borrow complete');
      await wait(2000);

      // Swap debtToken → collToken
      const { outputAmount: swappedColl, txSig: swapSig } = await this.jupiterSwap(this.cfg.debtToken, this.cfg.collToken, maxBorrow, this.cfg.debtDecimals);
      txSigs.push(swapSig);
      await wait(2000);

      // Re-deposit collToken
      await market.loadReserves();
      const reDepositBase = Math.floor(swappedColl * Math.pow(10, this.cfg.collDecimals)).toString();
      const reDepositAction = await KaminoAction.buildDepositTxns(market, reDepositBase, address(this.cfg.collToken), signer, this.getObligationType(), false, undefined);
      const reDepositSig = await this.sendKaminoTx(reDepositAction, rpc, signer);
      txSigs.push(reDepositSig);
      log.info({ loop: loop + 1, reDeposited: swappedColl, sig: reDepositSig }, 'Re-deposit complete');
      await wait(2000);
    }

    const finalHealth = await this.getHealthRate();
    const finalBalance = await this.getBalance();
    log.info({ amount, finalHealth, finalBalance, txCount: txSigs.length, label: this.cfg.label }, 'Multiply deposit complete');
    return txSigs[0]!;
  }

  /**
   * Withdraw from Multiply position, automatically deleveraging.
   */
  async withdraw(amount: number): Promise<string> {
    const { rpc, signer, market } = await this.ensureInitialized();

    const maxLoops = 6;
    const txSigs: string[] = [];
    const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

    await market.loadReserves();
    const obligation = await market.getObligationByWallet(address(this.walletAddress), this.getObligationType());
    if (!obligation) throw new Error('No Multiply position found to withdraw from');

    const stats = obligation.refreshedStats;
    const netValue = stats.userTotalDeposit.minus(stats.userTotalBorrow).toNumber();
    const isFullWithdraw = amount >= netValue * 0.99;

    log.info(
      { amount, isFullWithdraw, deposited: stats.userTotalDeposit.toFixed(2), borrowed: stats.userTotalBorrow.toFixed(2), label: this.cfg.label },
      'Multiply withdraw starting (manual loop)',
    );

    // Deleverage loops: withdraw collateral → swap → repay debt
    for (let loop = 0; loop < maxLoops; loop++) {
      await market.loadReserves();
      const obl = await market.getObligationByWallet(signer.address, this.getObligationType());
      if (!obl) break;

      const oblStats = obl.refreshedStats;
      const totalBorrow = oblStats.userTotalBorrow.toNumber();
      if (totalBorrow < 1) break;

      const totalDeposit = oblStats.userTotalDeposit.toNumber();
      const withdrawRatio = isFullWithdraw ? 1 : Math.min(amount / netValue, 1);
      const repayTarget = isFullWithdraw ? totalBorrow : totalBorrow * withdrawRatio * 1.1;
      const repayAmount = Math.min(repayTarget, totalBorrow);
      const withdrawForRepay = Math.ceil(repayAmount * 1.005);

      log.info({ loop: loop + 1, totalDeposit, totalBorrow, withdrawForRepay }, 'Deleverage loop');

      // Withdraw collToken
      await market.loadReserves();
      const withdrawBase = Math.floor(withdrawForRepay * Math.pow(10, this.cfg.collDecimals)).toString();
      const withdrawAction = await KaminoAction.buildWithdrawTxns(market, withdrawBase, address(this.cfg.collToken), signer, this.getObligationType(), false, undefined);
      const withdrawSig = await this.sendKaminoTx(withdrawAction, rpc, signer);
      txSigs.push(withdrawSig);
      await wait(2000);

      // Swap collToken → debtToken
      const { outputAmount: debtForRepay, txSig: swapSig } = await this.jupiterSwap(this.cfg.collToken, this.cfg.debtToken, withdrawForRepay, this.cfg.collDecimals);
      txSigs.push(swapSig);
      await wait(2000);

      // Repay debtToken
      await market.loadReserves();
      const repayBase = Math.floor(debtForRepay * Math.pow(10, this.cfg.debtDecimals)).toString();
      const slotResult = await rpc.getSlot({ commitment: 'confirmed' }).send();
      const currentSlot = typeof slotResult === 'object' && slotResult !== null ? (slotResult as any).value ?? slotResult : slotResult;
      const repayAction = await KaminoAction.buildRepayTxns(market, repayBase, address(this.cfg.debtToken), signer, this.getObligationType(), false, undefined, BigInt(currentSlot));
      const repaySig = await this.sendKaminoTx(repayAction, rpc, signer);
      txSigs.push(repaySig);
      log.info({ loop: loop + 1, repaid: debtForRepay, sig: repaySig }, 'Repay complete');
      await wait(2000);
    }

    // Final: withdraw remaining collateral
    await market.loadReserves();
    const finalObl = await market.getObligationByWallet(signer.address, this.getObligationType());
    if (finalObl) {
      const finalDeposited = finalObl.refreshedStats.userTotalDeposit.toNumber();
      const finalBorrowed = finalObl.refreshedStats.userTotalBorrow.toNumber();
      const withdrawableNet = finalDeposited - finalBorrowed;
      const finalWithdrawAmount = isFullWithdraw ? withdrawableNet : Math.min(amount, withdrawableNet);

      if (finalWithdrawAmount > 0.01) {
        await market.loadReserves();
        const finalBase = Math.floor(finalWithdrawAmount * Math.pow(10, this.cfg.collDecimals)).toString();
        const finalAction = await KaminoAction.buildWithdrawTxns(market, finalBase, address(this.cfg.collToken), signer, this.getObligationType(), false, undefined);
        const finalSig = await this.sendKaminoTx(finalAction, rpc, signer);
        txSigs.push(finalSig);
        log.info({ withdrawn: finalWithdrawAmount, sig: finalSig }, 'Final withdrawal complete');
        await wait(2000);
      }
    }

    // Post-withdraw: swap collToken → inputToken if needed
    if (this.needsInputSwap()) {
      try {
        const { Connection, PublicKey } = await import('@solana/web3.js');
        const conn = new Connection(this.rpcUrl!, 'confirmed');
        const tokenAccounts = await conn.getParsedTokenAccountsByOwner(
          new PublicKey(this.walletAddress),
          { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') },
        );
        const collAccount = tokenAccounts.value.find(t => t.account.data.parsed.info.mint === this.cfg.collToken);
        const collBalance = collAccount ? parseFloat(collAccount.account.data.parsed.info.tokenAmount.uiAmountString) : 0;

        if (collBalance > 0.001) {
          log.info({ collBalance, to: this.cfg.inputToken!.slice(0, 8) }, 'Post-withdraw swap');
          const { txSig: swapSig } = await this.jupiterSwap(this.cfg.collToken, this.cfg.inputToken!, collBalance, this.cfg.collDecimals);
          txSigs.push(swapSig);
        }
      } catch (err) {
        log.error({ error: (err as Error).message }, 'Post-withdraw swap failed');
      }
    }

    log.info({ amount, isFullWithdraw, txCount: txSigs.length, label: this.cfg.label }, 'Multiply withdraw complete');
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

      const sig = await this.sendKaminoTx({ setupIxs: [], lendingIxs: claimIxs, cleanupIxs: [] }, rpc, signer);
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
