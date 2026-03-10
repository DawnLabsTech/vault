import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('wallet');

// Base58 alphabet used by Bitcoin/Solana
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Decode a base58-encoded string to Uint8Array.
 * Implements the standard Bitcoin base58 decoding (no checksum).
 */
function base58Decode(encoded: string): Uint8Array {
  if (encoded.length === 0) return new Uint8Array(0);

  // Build the character-to-index map
  const indexMap = new Map<string, number>();
  for (let i = 0; i < BASE58_ALPHABET.length; i++) {
    indexMap.set(BASE58_ALPHABET[i]!, i);
  }

  // Count leading '1's (which map to leading zero bytes)
  let leadingZeros = 0;
  for (const char of encoded) {
    if (char === '1') {
      leadingZeros++;
    } else {
      break;
    }
  }

  // Decode: treat the base58 string as a big-endian base-58 number
  // and convert to base-256 (bytes)
  const size = Math.ceil(encoded.length * (Math.log(58) / Math.log(256)));
  const bytes = new Uint8Array(size);

  for (const char of encoded) {
    const value = indexMap.get(char);
    if (value === undefined) {
      throw new Error(`Invalid base58 character: '${char}'`);
    }

    let carry = value;
    for (let j = bytes.length - 1; j >= 0; j--) {
      carry += 58 * (bytes[j] ?? 0);
      bytes[j] = carry % 256;
      carry = Math.floor(carry / 256);
    }

    if (carry !== 0) {
      throw new Error('Base58 decode: number too large');
    }
  }

  // Find the first non-zero byte in the decoded result
  let firstNonZero = 0;
  while (firstNonZero < bytes.length && (bytes[firstNonZero] ?? 0) === 0) {
    firstNonZero++;
  }

  // Prepend leading zero bytes from the leading '1' characters
  const result = new Uint8Array(leadingZeros + (bytes.length - firstNonZero));
  // Leading zeros are already 0 in the Uint8Array
  result.set(bytes.subarray(firstNonZero), leadingZeros);

  return result;
}

/**
 * Encode a Uint8Array to base58 string.
 */
function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';

  // Count leading zero bytes
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      leadingZeros++;
    } else {
      break;
    }
  }

  // Convert to base58
  const size = Math.ceil(bytes.length * (Math.log(256) / Math.log(58)));
  const digits = new Uint8Array(size);

  for (const byte of bytes) {
    let carry = byte;
    for (let j = digits.length - 1; j >= 0; j--) {
      carry += 256 * (digits[j] ?? 0);
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
  }

  // Find first non-zero digit
  let firstNonZero = 0;
  while (firstNonZero < digits.length && (digits[firstNonZero] ?? 0) === 0) {
    firstNonZero++;
  }

  // Build result string
  let result = '1'.repeat(leadingZeros);
  for (let i = firstNonZero; i < digits.length; i++) {
    result += BASE58_ALPHABET[digits[i]!];
  }

  return result;
}

export interface WalletKeys {
  publicKey: string;
  secretKey: Uint8Array;
}

/**
 * Load wallet keypair from SOLANA_PRIVATE_KEY environment variable.
 * The env var should contain a base58-encoded secret key (64 bytes: 32 secret + 32 public).
 *
 * For Ed25519 keypairs used by Solana, the 64-byte secret key contains:
 * - bytes 0-31: the actual secret key seed
 * - bytes 32-63: the public key
 */
export function loadWalletFromEnv(): WalletKeys {
  const privateKeyBase58 = process.env.SOLANA_PRIVATE_KEY;
  if (!privateKeyBase58) {
    throw new Error(
      'SOLANA_PRIVATE_KEY not set. Provide a base58-encoded secret key in the environment.',
    );
  }

  const secretKey = base58Decode(privateKeyBase58);

  // Solana keypairs are 64 bytes (32-byte secret seed + 32-byte public key)
  if (secretKey.length !== 64) {
    throw new Error(
      `Invalid secret key length: expected 64 bytes, got ${secretKey.length}. ` +
      'Ensure SOLANA_PRIVATE_KEY is a valid base58-encoded Solana keypair.',
    );
  }

  // The public key is the last 32 bytes of the 64-byte keypair
  const publicKeyBytes = secretKey.slice(32, 64);
  const publicKey = base58Encode(publicKeyBytes);

  log.info({ publicKey }, 'Wallet loaded from environment');

  return { publicKey, secretKey };
}

/**
 * Get the wallet public key (address) without exposing the secret key.
 * Returns the base58-encoded public key string.
 */
export function getWalletAddress(): string {
  const { publicKey } = loadWalletFromEnv();
  return publicKey;
}

// Re-export utilities for use by other modules that may need base58
export { base58Decode, base58Encode };
