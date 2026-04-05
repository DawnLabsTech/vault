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
