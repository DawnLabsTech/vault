import { timingSafeEqual } from 'crypto';

export const FRONTEND_BASIC_AUTH_USER = 'vault';
export const FRONTEND_AUTH_REALM = 'Dawn Vault Dashboard';

function safeStringEqual(a: string, b: string): boolean {
  const aBytes = Buffer.from(a, 'utf8');
  const bBytes = Buffer.from(b, 'utf8');
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  return timingSafeEqual(aBytes, bBytes);
}

export function isAuthorizedRequest(
  authHeader: string | null,
  secret: string,
): boolean {
  if (!secret) {
    return true;
  }

  if (!authHeader) {
    return false;
  }

  if (authHeader.startsWith('Bearer ') && safeStringEqual(authHeader, `Bearer ${secret}`)) {
    return true;
  }

  if (!authHeader.startsWith('Basic ')) {
    return false;
  }

  try {
    const decoded = atob(authHeader.slice('Basic '.length).trim());
    return safeStringEqual(decoded, `${FRONTEND_BASIC_AUTH_USER}:${secret}`);
  } catch {
    return false;
  }
}

export function getAuthChallengeHeaders(): HeadersInit {
  return {
    'WWW-Authenticate': `Basic realm="${FRONTEND_AUTH_REALM}", charset="UTF-8"`,
    'Cache-Control': 'no-store',
  };
}
