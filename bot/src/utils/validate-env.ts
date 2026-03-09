import { createChildLogger } from './logger.js';

const log = createChildLogger('env');

interface EnvVar {
  name: string;
  required: boolean;
  sensitive?: boolean;
  validate?: (value: string) => string | null; // returns error message or null
}

const ENV_VARS: EnvVar[] = [
  {
    name: 'BINANCE_API_KEY',
    required: true,
    sensitive: true,
  },
  {
    name: 'BINANCE_API_SECRET',
    required: true,
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
];

/**
 * Validate all required environment variables at startup.
 * Throws if any required variable is missing or invalid.
 */
export function validateEnv(): void {
  const errors: string[] = [];

  for (const v of ENV_VARS) {
    const value = process.env[v.name];

    if (!value || value.trim() === '') {
      if (v.required) {
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
