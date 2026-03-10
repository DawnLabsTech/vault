import { createChildLogger } from '../../utils/logger.js';
import { withRetry } from '../../utils/retry.js';
import type { LendingProtocol } from '../../types.js';
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
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';

const log = createChildLogger('kamino');

const KAMINO_API = 'https://api.kamino.finance';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const KAMINO_MAIN_MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';

export class KaminoLending implements LendingProtocol {
  readonly name = 'kamino';
  private walletAddress: string;
  private rpc: any = null;
  private signer: KeyPairSigner | null = null;
  private market: KaminoMarket | null = null;
  private rpcUrl: string | null = null;
  private secretKey: Uint8Array | null = null;

  constructor(walletAddress: string, rpcUrl?: string, secretKey?: Uint8Array) {
    this.walletAddress = walletAddress;
    this.rpcUrl = rpcUrl ?? null;
    this.secretKey = secretKey ?? null;
  }

  private async ensureInitialized(): Promise<{
    rpc: any;
    signer: KeyPairSigner;
    market: KaminoMarket;
  }> {
    if (!this.rpcUrl || !this.secretKey) {
      throw new Error('Kamino adapter not configured for on-chain operations (missing rpcUrl or secretKey)');
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
      if (!market) {
        throw new Error('Failed to load Kamino market');
      }
      this.market = market;
      log.info('Kamino market loaded');
    }

    return { rpc: this.rpc, signer: this.signer, market: this.market };
  }

  async getApy(): Promise<number> {
    return withRetry(async () => {
      const res = await fetch(`${KAMINO_API}/kamino-market/${KAMINO_MAIN_MARKET}/reserves/metrics`);
      if (!res.ok) {
        throw new Error(`Kamino APY fetch failed: ${res.status}`);
      }
      const data = await res.json() as any;
      const reserves = Array.isArray(data) ? data : [];
      const usdcReserve = reserves.find((r: any) => r.liquidityTokenMint === USDC_MINT || r.liquidityToken === 'USDC');
      return usdcReserve?.supplyApy ? parseFloat(usdcReserve.supplyApy) : 0;
    }, 'kamino-apy');
  }

  async getBalance(): Promise<number> {
    return withRetry(async () => {
      const res = await fetch(
        `${KAMINO_API}/kamino-market/${KAMINO_MAIN_MARKET}/users/${this.walletAddress}/obligations`,
      );
      if (!res.ok) {
        log.warn({ status: res.status }, 'Kamino balance fetch failed, returning 0');
        return 0;
      }
      const data = await res.json() as any;
      // Find USDC supply balance across obligations
      const obligations = Array.isArray(data) ? data : [];
      for (const obligation of obligations) {
        const deposits = obligation?.deposits ?? obligation?.supplyPositions ?? [];
        const usdcDeposit = deposits.find((d: any) => d.mint === USDC_MINT || d.symbol === 'USDC');
        if (usdcDeposit?.amount ?? usdcDeposit?.balance) {
          return usdcDeposit.amount ?? usdcDeposit.balance;
        }
      }
      return 0;
    }, 'kamino-balance');
  }

  async deposit(amount: number): Promise<string> {
    const { rpc, signer, market } = await this.ensureInitialized();

    log.info({ amount }, 'Kamino deposit starting');

    // Reload reserves for fresh state
    await market.loadReserves();

    // Amount in base units (USDC has 6 decimals)
    const amountBase = Math.floor(amount * 1e6).toString();

    const kaminoAction = await KaminoAction.buildDepositTxns(
      market,
      amountBase,
      address(USDC_MINT),
      signer,
      new VanillaObligation(PROGRAM_ID),
      false, // useV2Ixs
      undefined, // scopeRefreshConfig
    );

    // Combine all instructions
    const allIxs = [
      ...kaminoAction.setupIxs,
      ...kaminoAction.lendingIxs,
      ...kaminoAction.cleanupIxs,
    ];

    if (allIxs.length === 0) {
      throw new Error('Kamino deposit: no instructions generated');
    }

    // Build, sign, and send transaction
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

    const signature = await rpc
      .sendTransaction(base64Tx, {
        encoding: 'base64',
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: BigInt(3),
      })
      .send();

    log.info({ amount, signature }, 'Kamino deposit sent');
    return signature;
  }

  async withdraw(amount: number): Promise<string> {
    const { rpc, signer, market } = await this.ensureInitialized();

    log.info({ amount }, 'Kamino withdraw starting');

    await market.loadReserves();

    const amountBase = Math.floor(amount * 1e6).toString();

    const kaminoAction = await KaminoAction.buildWithdrawTxns(
      market,
      amountBase,
      address(USDC_MINT),
      signer,
      new VanillaObligation(PROGRAM_ID),
      false,
      undefined,
    );

    const allIxs = [
      ...kaminoAction.setupIxs,
      ...kaminoAction.lendingIxs,
      ...kaminoAction.cleanupIxs,
    ];

    if (allIxs.length === 0) {
      throw new Error('Kamino withdraw: no instructions generated');
    }

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

    const signature = await rpc
      .sendTransaction(base64Tx, {
        encoding: 'base64',
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: BigInt(3),
      })
      .send();

    log.info({ amount, signature }, 'Kamino withdraw sent');
    return signature;
  }
}
