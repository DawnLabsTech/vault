import { timingSafeEqual } from 'crypto';
import type { IncomingHttpHeaders } from 'http';

const BEARER_PREFIX = 'Bearer ';
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function safeStringEqual(a: string, b: string): boolean {
  const aBytes = Buffer.from(a, 'utf8');
  const bBytes = Buffer.from(b, 'utf8');
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  return timingSafeEqual(aBytes, bBytes);
}

export function isValidBearerToken(
  authHeader: string | undefined,
  expectedToken: string,
): boolean {
  if (!authHeader?.startsWith(BEARER_PREFIX)) {
    return false;
  }
  const providedToken = authHeader.slice(BEARER_PREFIX.length);
  return safeStringEqual(providedToken, expectedToken);
}

export function getCorsOrigin(
  headers: IncomingHttpHeaders,
  allowedOrigin: string,
): string | null {
  const requestOrigin = headers.origin;
  if (!allowedOrigin || typeof requestOrigin !== 'string') {
    return null;
  }
  return requestOrigin === allowedOrigin ? requestOrigin : null;
}

export function clampInteger(
  rawValue: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(rawValue ?? '', 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

export function normalizeSessionId(sessionId: unknown): string | null {
  if (typeof sessionId !== 'string') {
    return null;
  }
  const normalized = sessionId.trim();
  return SESSION_ID_PATTERN.test(normalized) ? normalized : null;
}

export function getClientIdentifier(
  headers: IncomingHttpHeaders,
  remoteAddress: string | undefined,
): string {
  const forwardedFor = headers['x-forwarded-for'];
  const rawForwarded = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const forwardedIp = rawForwarded?.split(',')[0]?.trim();
  return forwardedIp || remoteAddress?.trim() || 'anonymous';
}

// ── Rate Limiter ────────────────────────────────────────────────

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  private buckets = new Map<string, RateLimitEntry>();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(windowMs: number, maxRequests: number) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  /**
   * Returns true if the request is allowed, false if rate-limited.
   */
  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.buckets.get(key);

    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return true;
    }

    entry.count++;
    return entry.count <= this.maxRequests;
  }

  /** Seconds until the current window resets for the given key. */
  retryAfter(key: string): number {
    const entry = this.buckets.get(key);
    if (!entry) return 0;
    return Math.max(0, Math.ceil((entry.windowStart + this.windowMs - Date.now()) / 1000));
  }

  /** Periodically evict expired entries to prevent memory growth. */
  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.buckets) {
      if (now - entry.windowStart >= this.windowMs) {
        this.buckets.delete(key);
      }
    }
  }
}

// ── Input Validation ────────────────────────────────────────────

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateString(s: string): boolean {
  return ISO_DATE_PATTERN.test(s) && !Number.isNaN(Date.parse(s));
}

const VALID_EVENT_TYPES = new Set([
  'deposit', 'withdraw', 'swap', 'perp_open', 'perp_close',
  'fr_payment', 'lending_interest', 'rebalance', 'alert',
  'state_change', 'transfer',
]);

export function isValidEventType(s: string): boolean {
  return VALID_EVENT_TYPES.has(s);
}

const ADVISOR_CATEGORY_PATTERN = /^[a-z_]{1,40}$/;

export function isValidAdvisorCategory(s: string): boolean {
  return ADVISOR_CATEGORY_PATTERN.test(s);
}
