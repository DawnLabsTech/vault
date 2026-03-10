import { createChildLogger } from './logger.js';

const log = createChildLogger('retry');

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    jitter = true,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (attempt === maxAttempts) break;

      let delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      if (jitter) delay = delay * (0.5 + Math.random() * 0.5);

      log.warn({ attempt, maxAttempts, delay, error: lastError.message }, `${label}: retrying`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
