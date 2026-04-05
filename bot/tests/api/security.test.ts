import { describe, expect, it } from 'vitest';
import {
  clampInteger,
  getClientIdentifier,
  getCorsOrigin,
  isValidBearerToken,
  normalizeSessionId,
} from '../../src/api/security.js';

describe('api/security', () => {
  it('accepts only exact bearer tokens', () => {
    expect(isValidBearerToken('Bearer secret-token', 'secret-token')).toBe(true);
    expect(isValidBearerToken('Bearer wrong-token', 'secret-token')).toBe(false);
    expect(isValidBearerToken('Basic vault:secret-token', 'secret-token')).toBe(false);
    expect(isValidBearerToken(undefined, 'secret-token')).toBe(false);
  });

  it('returns a CORS origin only when it matches exactly', () => {
    expect(getCorsOrigin({ origin: 'https://vault.example' }, 'https://vault.example')).toBe(
      'https://vault.example',
    );
    expect(getCorsOrigin({ origin: 'https://evil.example' }, 'https://vault.example')).toBeNull();
    expect(getCorsOrigin({}, 'https://vault.example')).toBeNull();
  });

  it('clamps integer query parameters', () => {
    expect(clampInteger('250', 100, 1, 500)).toBe(250);
    expect(clampInteger('999', 100, 1, 500)).toBe(500);
    expect(clampInteger('-10', 100, 1, 500)).toBe(1);
    expect(clampInteger('abc', 100, 1, 500)).toBe(100);
  });

  it('normalizes only safe session identifiers', () => {
    expect(normalizeSessionId('session_123-abc')).toBe('session_123-abc');
    expect(normalizeSessionId(' default ')).toBe('default');
    expect(normalizeSessionId('../etc/passwd')).toBeNull();
    expect(normalizeSessionId('')).toBeNull();
    expect(normalizeSessionId(123)).toBeNull();
  });

  it('prefers forwarded client IPs', () => {
    expect(getClientIdentifier({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, '127.0.0.1')).toBe(
      '203.0.113.7',
    );
    expect(getClientIdentifier({}, '127.0.0.1')).toBe('127.0.0.1');
    expect(getClientIdentifier({}, undefined)).toBe('anonymous');
  });
});
