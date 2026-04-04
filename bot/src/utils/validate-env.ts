import { createChildLogger } from './logger.js';
import type { PerpExchange } from '../types.js';

const log = createChildLogger('env');

export function getPerpExchange(): PerpExchange {
  const val = (process.env.PERP_EXCHANGE || 'binance').toLowerCase();
  if (val !== 'binance') {
    throw new Error(`PERP_EXCHANGE must be "binance", got "${val}"`);
  }
  return val;
}

interface EnvVar {
  name: string;
  required: boolean | (() => boolean);
  sensitive?: boolean;
  validate?: (value: string) => string | null; // returns error message or null
}

const isBinance = () => getPerpExchange() === 'binance';

const ENV_VARS: EnvVar[] = [
  {
    name: 'PERP_EXCHANGE',
    required: false,
    validate: (v) => ['binance', 'drift'].includes(v.toLowerCase()) ? null : 'Must be "binance" or "drift"',
  },
  {
    name: 'BINANCE_API_KEY',
    required: isBinance,
    sensitive: true,
  },
  {
    name: 'BINANCE_API_SECRET',
    required: isBinance,
    sensitive: true,
  },
  {
    name: 'HELIUS_RPC_URL',
    required: true,
    sensitive: true,
    validate: (v) => v.startsWith('http') ? null : 'Must be a valid URL',
  },
  {
    name: 'SOLANA_PRIVATE_KEY',
    required: true,
    sensitive: true,
    validate: (v) => v.length >= 64 ? null : 'Key appears too short — expected base58-encoded Ed25519 keypair',
  },
  {
    name: 'SOLANA_WALLET_ADDRESS',
    required: true,
    validate: (v) => v.length >= 32 ? null : 'Address appears too short',
  },
  {
    name: 'TELEGRAM_BOT_TOKEN',
    required: false,
    sensitive: true,
  },
  {
    name: 'TELEGRAM_CHAT_ID',
    required: false,
  },
  {
    name: 'API_AUTH_TOKEN',
    required: false,
    sensitive: true,
  },
  {
    name: 'JUPITER_API_KEY',
    required: false,
    sensitive: true,
  },
  // BINANCE_USDC_DEPOSIT_ADDRESS removed — now fetched dynamically via Binance API
];

/**
 * Validate all required environment variables at startup.
 * Throws if any required variable is missing or invalid.
 */
export function validateEnv(): void {
  const errors: string[] = [];

  for (const v of ENV_VARS) {
    const value = process.env[v.name];

    const isRequired = typeof v.required === 'function' ? v.required() : v.required;

    if (!value || value.trim() === '') {
      if (isRequired) {
        errors.push(`${v.name} is required but not set`);
      } else {
        log.warn({ var: v.name }, 'Optional env var not set');
      }
      continue;
    }

    if (v.validate) {
      const err = v.validate(value);
      if (err) {
        errors.push(`${v.name}: ${err}`);
      }
    }
  }

  // Security warnings
  if (!process.env.API_AUTH_TOKEN) {
    log.warn('API_AUTH_TOKEN not set — monitoring API will be publicly accessible');
  }

  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    log.warn('Telegram not configured — critical alerts will only appear in logs');
  }

  if (errors.length > 0) {
    const msg = `Environment validation failed:\n  - ${errors.join('\n  - ')}`;
    log.fatal(msg);
    throw new Error(msg);
  }

  log.info('Environment variables validated');
}
