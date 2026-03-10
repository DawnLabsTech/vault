import {
  Connection,
  Keypair,
  VersionedTransaction,
  Transaction,
  SendOptions,
} from '@solana/web3.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('tx-sender');

export class SolanaTransactionSender {
  readonly connection: Connection;
  readonly keypair: Keypair;

  constructor(rpcUrl: string, secretKey: Uint8Array) {
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

  /**
   * Sign and send a versioned transaction (base64 encoded from an API).
   * Returns the transaction signature.
   */
  async signAndSendBase64(base64Tx: string): Promise<string> {
    const txBuf = Buffer.from(base64Tx, 'base64');

    // Try VersionedTransaction first, fall back to legacy
    let signature: string;
    try {
      const vTx = VersionedTransaction.deserialize(txBuf);
      vTx.sign([this.keypair]);
      signature = await this.connection.sendTransaction(vTx, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      } as SendOptions);
    } catch {
      // Fall back to legacy Transaction
      const legacyTx = Transaction.from(txBuf);
      legacyTx.partialSign(this.keypair);
      const rawTx = legacyTx.serialize();
      signature = await this.connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      });
    }

    log.info({ signature }, 'Transaction sent');
    return signature;
  }

  /**
   * Sign and send a Transaction or VersionedTransaction object.
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

    // Legacy Transaction
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
  async confirm(signature: string, timeoutMs = 60_000): Promise<boolean> {
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

  /**
   * Sign, send, and confirm a transaction. Returns the signature.
   * Throws if confirmation fails.
   */
  async signSendConfirm(
    tx: Transaction | VersionedTransaction,
    timeoutMs = 60_000,
  ): Promise<string> {
    const sig = await this.signAndSend(tx);
    const confirmed = await this.confirm(sig, timeoutMs);
    if (!confirmed) {
      throw new Error(`Transaction ${sig} failed to confirm within ${timeoutMs}ms`);
    }
    return sig;
  }
}
