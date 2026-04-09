/**
 * Local wrapper for the bulk-keychain native module.
 * The published npm package omits index.js, so we load the .node binary directly.
 * This file is the single import point for all bulk-keychain usage.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Load the platform-specific native binary
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const native = require('bulk-keychain/bulk-keychain.darwin-arm64.node') as BulkKeychainNative;

// ── Native module types ─────────────────────────────────────────────────────

interface NativeKeypairInstance {
  /** Base58-encoded public key (Solana-compatible address). */
  pubkey: string;
  secretKey(): Uint8Array;
  toBase58(): string;
  toBytes(): Uint8Array;
  cloneKeypair(): NativeKeypairInstance;
}

interface NativeKeypairConstructor {
  new(secretKey?: Uint8Array): NativeKeypairInstance;
}

export interface SignedEnvelope {
  /** JSON string of the serialized actions array. */
  actions: string;
  nonce: number;
  account: string;
  signer: string;
  signature: string;
  /** Deterministic order ID for the first order action (if applicable). */
  orderId?: string;
}

export type TimeInForce = 'GTC' | 'IOC' | 'ALO';

export interface PlaceOrderInput {
  type: 'order';
  symbol: string;
  isBuy: boolean;
  price: number;
  size: number;
  timeInForce: TimeInForce;
  reduceOnly: boolean;
}

export interface CancelOrderInput {
  type: 'cancel';
  symbol: string;
  orderId: string;
}

export interface CancelAllInput {
  type: 'cancelAll';
  symbol: string;
}

export type OrderInput = PlaceOrderInput | CancelOrderInput | CancelAllInput;

interface NativeSignerInstance {
  pubkey: string;
  signOrder(orders: OrderInput[]): SignedEnvelope;
  signFaucet(nonce: number): SignedEnvelope;
}

interface NativeSignerConstructor {
  new(keypair: NativeKeypairInstance): NativeSignerInstance;
}

interface BulkKeychainNative {
  NativeKeypair: NativeKeypairConstructor;
  NativeSigner: NativeSignerConstructor;
}

// ── Exported wrappers ───────────────────────────────────────────────────────

export type { NativeKeypairInstance as BulkKeypair, NativeSignerInstance as BulkSigner };

/**
 * Create a Bulk keypair from a 32-byte Ed25519 private key seed.
 * Pass `loadWalletFromEnv().secretKey.slice(0, 32)` to reuse the Solana wallet.
 */
export function createKeypair(secretKeySeed?: Uint8Array): NativeKeypairInstance {
  return new native.NativeKeypair(secretKeySeed);
}

/**
 * Create a Bulk signer from a keypair.
 * The signer is used to sign order transactions.
 */
export function createSigner(keypair: NativeKeypairInstance): NativeSignerInstance {
  return new native.NativeSigner(keypair);
}
