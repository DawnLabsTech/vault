import {
  Connection,
  Keypair,
  VersionedTransaction,
  Transaction,
  ComputeBudgetProgram,
  TransactionMessage,
  PublicKey,
  SendOptions,
} from '@solana/web3.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('tx-sender');

const MIN_PRIORITY_FEE_MICRO_LAMPORTS = 1_000;
const MAX_PRIORITY_FEE_MICRO_LAMPORTS = 1_000_000;
const DEFAULT_CU_LIMIT = 300_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_FEE_BUMP_FACTOR = 1.5;
const DEFAULT_CONFIRM_TIMEOUT_MS = 60_000;

export interface PriorityFeeOptions {
  /** 最小優先手数料 (micro-lamports / CU) */
  minMicroLamports?: number;
  /** 最大優先手数料 (micro-lamports / CU) */
  maxMicroLamports?: number;
  /** CU上限 (legacy txに注入) */
  computeUnitLimit?: number;
  /** リトライ時の手数料増額倍率 */
  feeBumpFactor?: number;
}

export interface SendRetryOptions extends PriorityFeeOptions {
  /** 最大試行回数 */
  maxAttempts?: number;
  /** confirm タイムアウト (ms) */
  confirmTimeoutMs?: number;
}

export class SolanaTransactionSender {
  readonly connection: Connection;
  readonly keypair: Keypair;
  private readonly rpcUrl: string;

  constructor(rpcUrl: string, secretKey: Uint8Array) {
    this.rpcUrl = rpcUrl;
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.keypair = Keypair.fromSecretKey(secretKey);
    log.info(
      { publicKey: this.keypair.publicKey.toBase58() },
      'SolanaTransactionSender initialized',
    );
  }

  get publicKey() {
    return this.keypair.publicKey;
  }

  // ─── Priority fee estimation ──────────────────────────────────────────

  /**
   * 優先手数料 (micro-lamports per CU) を見積もる。
   * Helius RPCならgetPriorityFeeEstimate、それ以外はgetRecentPrioritizationFeesを使用。
   * 失敗時は minMicroLamports を返す (握りつぶしてTX送信を止めない)。
   */
  async estimatePriorityFee(
    writableAccounts: PublicKey[] = [],
    opts: PriorityFeeOptions = {},
  ): Promise<number> {
    const min = opts.minMicroLamports ?? MIN_PRIORITY_FEE_MICRO_LAMPORTS;
    const max = opts.maxMicroLamports ?? MAX_PRIORITY_FEE_MICRO_LAMPORTS;

    try {
      const isHelius = this.rpcUrl.includes('helius');
      const fee = isHelius
        ? await this.fetchHeliusPriorityFee(writableAccounts)
        : await this.fetchRecentPrioritizationFee(writableAccounts);

      const clamped = Math.max(min, Math.min(max, Math.ceil(fee)));
      log.debug({ raw: fee, clamped, source: isHelius ? 'helius' : 'recent' }, 'priority fee estimated');
      return clamped;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'priority fee estimation failed, using min');
      return min;
    }
  }

  /** Helius専用 getPriorityFeeEstimate (recommended を返す) */
  private async fetchHeliusPriorityFee(accounts: PublicKey[]): Promise<number> {
    const body = {
      jsonrpc: '2.0',
      id: 'pri-fee',
      method: 'getPriorityFeeEstimate',
      params: [
        {
          accountKeys: accounts.map((a) => a.toBase58()),
          options: { recommended: true },
        },
      ],
    };
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`Helius HTTP ${res.status}`);
    const json = (await res.json()) as {
      result?: { priorityFeeEstimate?: number };
      error?: { message: string };
    };
    if (json.error) throw new Error(json.error.message);
    const fee = json.result?.priorityFeeEstimate;
    if (typeof fee !== 'number') throw new Error('no priorityFeeEstimate in response');
    return fee;
  }

  /** 標準RPC getRecentPrioritizationFees — 上位75%パーセンタイルを採用 */
  private async fetchRecentPrioritizationFee(accounts: PublicKey[]): Promise<number> {
    const fees = await this.connection.getRecentPrioritizationFees({
      lockedWritableAccounts: accounts,
    });
    if (fees.length === 0) return MIN_PRIORITY_FEE_MICRO_LAMPORTS;
    const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.75);
    return sorted[idx] ?? sorted[sorted.length - 1] ?? MIN_PRIORITY_FEE_MICRO_LAMPORTS;
  }

  // ─── Legacy Transaction helpers ──────────────────────────────────────

  /**
   * legacy Transactionの先頭から既存のComputeBudget命令を除去し、
   * 指定の priority fee / CU limit を前置する。
   */
  private applyComputeBudget(
    tx: Transaction,
    microLamports: number,
    computeUnitLimit: number,
  ): void {
    const CB_PROGRAM = ComputeBudgetProgram.programId.toBase58();
    tx.instructions = tx.instructions.filter(
      (ix) => ix.programId.toBase58() !== CB_PROGRAM,
    );
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(microLamports) }),
    );
  }

  /** txから書き込み対象のアカウントを抽出 (priority fee推定用) */
  private extractWritableAccounts(tx: Transaction): PublicKey[] {
    const seen = new Set<string>();
    const result: PublicKey[] = [];
    for (const ix of tx.instructions) {
      for (const key of ix.keys) {
        if (key.isWritable && !seen.has(key.pubkey.toBase58())) {
          seen.add(key.pubkey.toBase58());
          result.push(key.pubkey);
        }
      }
    }
    return result;
  }

  // ─── Send / confirm primitives ───────────────────────────────────────

  /**
   * Sign and send a versioned transaction (base64 encoded from an API).
   * Jupiterなど外部APIが手数料を組み込んだ既製txを想定。
   */
  async signAndSendBase64(base64Tx: string): Promise<string> {
    const txBuf = Buffer.from(base64Tx, 'base64');

    try {
      const vTx = VersionedTransaction.deserialize(txBuf);
      vTx.sign([this.keypair]);
      const signature = await this.connection.sendTransaction(vTx, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      } as SendOptions);
      log.info({ signature }, 'VersionedTransaction sent');
      return signature;
    } catch {
      const legacyTx = Transaction.from(txBuf);
      legacyTx.partialSign(this.keypair);
      const rawTx = legacyTx.serialize();
      const signature = await this.connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      });
      log.info({ signature }, 'Legacy Transaction sent (from base64)');
      return signature;
    }
  }

  /**
   * base64 tx を送信 → confirm をリトライ付きで実行。
   * Jupiterなど外部APIのtxは手数料を事後に変更できないため、同じtxを再送する。
   * blockhash期限切れで失敗した場合は再送しても無意味なのでthrowする。
   */
  async signAndSendBase64Confirm(
    base64Tx: string,
    opts: SendRetryOptions = {},
  ): Promise<string> {
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const timeoutMs = opts.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;

    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const sig = await this.signAndSendBase64(base64Tx);
        const confirmed = await this.confirm(sig, timeoutMs);
        if (confirmed) return sig;
        lastErr = new Error(`tx ${sig} not confirmed within ${timeoutMs}ms`);
        log.warn({ attempt, maxAttempts, sig }, 'confirm failed, retrying send');
      } catch (err) {
        lastErr = err as Error;
        log.warn({ attempt, maxAttempts, err: lastErr.message }, 'send failed, retrying');
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
    throw lastErr ?? new Error('signAndSendBase64Confirm: exhausted retries');
  }

  /**
   * legacy Transactionを priority fee注入 + リトライで送信・確定する。
   * 失敗時は blockhash更新 + 手数料増額して再試行。
   */
  async signSendConfirm(
    tx: Transaction | VersionedTransaction,
    timeoutMsOrOpts: number | SendRetryOptions = DEFAULT_CONFIRM_TIMEOUT_MS,
  ): Promise<string> {
    const opts: SendRetryOptions =
      typeof timeoutMsOrOpts === 'number'
        ? { confirmTimeoutMs: timeoutMsOrOpts }
        : timeoutMsOrOpts;

    if (tx instanceof VersionedTransaction) {
      // 外部ビルド済みの versioned tx は手数料差し替え不可 — 単純リトライのみ
      return this.signSendConfirmVersioned(tx, opts);
    }
    return this.signSendConfirmLegacy(tx, opts);
  }

  private async signSendConfirmVersioned(
    tx: VersionedTransaction,
    opts: SendRetryOptions,
  ): Promise<string> {
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const timeoutMs = opts.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;

    tx.sign([this.keypair]);

    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const sig = await this.connection.sendTransaction(tx, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 3,
        } as SendOptions);
        log.info({ sig, attempt }, 'VersionedTransaction sent');
        const confirmed = await this.confirm(sig, timeoutMs);
        if (confirmed) return sig;
        lastErr = new Error(`tx ${sig} not confirmed within ${timeoutMs}ms`);
      } catch (err) {
        lastErr = err as Error;
        log.warn({ attempt, maxAttempts, err: lastErr.message }, 'versioned send failed, retrying');
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
    throw lastErr ?? new Error('signSendConfirm(versioned): exhausted retries');
  }

  private async signSendConfirmLegacy(
    tx: Transaction,
    opts: SendRetryOptions,
  ): Promise<string> {
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const timeoutMs = opts.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    const minFee = opts.minMicroLamports ?? MIN_PRIORITY_FEE_MICRO_LAMPORTS;
    const maxFee = opts.maxMicroLamports ?? MAX_PRIORITY_FEE_MICRO_LAMPORTS;
    const cuLimit = opts.computeUnitLimit ?? DEFAULT_CU_LIMIT;
    const bump = opts.feeBumpFactor ?? DEFAULT_FEE_BUMP_FACTOR;

    const writableAccounts = this.extractWritableAccounts(tx);
    let fee = await this.estimatePriorityFee(writableAccounts, {
      minMicroLamports: minFee,
      maxMicroLamports: maxFee,
    });

    if (!tx.feePayer) tx.feePayer = this.keypair.publicKey;

    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.applyComputeBudget(tx, fee, cuLimit);

        // 毎回 blockhash を更新し、前回の署名はクリアして再署名する
        const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.signatures = [];
        tx.partialSign(this.keypair);

        const rawTx = tx.serialize();
        const sig = await this.connection.sendRawTransaction(rawTx, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 3,
        });
        log.info({ sig, attempt, fee, cuLimit }, 'legacy tx sent');

        const confirmed = await this.confirm(sig, timeoutMs);
        if (confirmed) return sig;
        lastErr = new Error(`tx ${sig} not confirmed within ${timeoutMs}ms`);
      } catch (err) {
        lastErr = err as Error;
        log.warn(
          { attempt, maxAttempts, fee, err: lastErr.message },
          'legacy send/confirm failed',
        );
      }

      // 次の試行に向けて手数料を増額
      fee = Math.min(maxFee, Math.ceil(fee * bump));
    }
    throw lastErr ?? new Error('signSendConfirm(legacy): exhausted retries');
  }

  /**
   * Sign and send without confirmation. Kept for callers that manage confirm separately.
   */
  async signAndSend(tx: Transaction | VersionedTransaction): Promise<string> {
    if (tx instanceof VersionedTransaction) {
      tx.sign([this.keypair]);
      const signature = await this.connection.sendTransaction(tx, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      } as SendOptions);
      log.info({ signature }, 'VersionedTransaction sent');
      return signature;
    }

    tx.partialSign(this.keypair);
    const rawTx = tx.serialize();
    const signature = await this.connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    });
    log.info({ signature }, 'Legacy Transaction sent');
    return signature;
  }

  /**
   * Confirm a transaction with timeout.
   */
  async confirm(signature: string, timeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS): Promise<boolean> {
    const start = Date.now();
    const pollInterval = 2_000;

    while (Date.now() - start < timeoutMs) {
      const status = await this.connection.getSignatureStatus(signature);
      if (status?.value) {
        if (status.value.err) {
          log.error({ signature, err: status.value.err }, 'Transaction failed');
          return false;
        }
        if (
          status.value.confirmationStatus === 'confirmed' ||
          status.value.confirmationStatus === 'finalized'
        ) {
          log.info({ signature, status: status.value.confirmationStatus }, 'Confirmed');
          return true;
        }
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    log.warn({ signature, timeoutMs }, 'Confirmation timed out');
    return false;
  }
}

// TransactionMessage は将来の versioned tx 構築で使う可能性があるため re-export しておく
export { TransactionMessage };
