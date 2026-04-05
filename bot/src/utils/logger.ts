import pino from 'pino';
import { getConfig } from '../config.js';

export const logger = pino({
  level: process.env.LOG_LEVEL || getConfig().general.logLevel || 'info',
  redact: {
    paths: [
      'apiKey', 'apiSecret', 'secret', 'privateKey',
      'token', 'authorization', 'password',
      'rpcUrl', 'rpcEndpoint', 'botToken',
      '*.apiKey', '*.apiSecret', '*.secret', '*.privateKey',
      '*.token', '*.authorization', '*.password',
      '*.rpcUrl', '*.rpcEndpoint', '*.botToken',
    ],
    censor: '[REDACTED]',
  },
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'UTC:yyyy-mm-dd HH:MM:ss.l' } }
    : undefined,
});

export const createChildLogger = (module: string) => logger.child({ module });
