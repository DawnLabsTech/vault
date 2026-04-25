import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { PublicKey } from '@solana/web3.js';
import {
  AnomalyMonitor,
  createUpgradeAuthorityHandler,
  deriveProgramDataAddress,
  parseUpgradeAuthority,
} from '../../src/risk/anomaly-monitor.js';

vi.mock('../../src/utils/notify.js', () => ({
  sendAlert: vi.fn(),
}));

vi.mock('../../src/measurement/events.js', () => ({
  recordEvent: vi.fn(),
}));

import { sendAlert } from '../../src/utils/notify.js';
import { recordEvent } from '../../src/measurement/events.js';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS anomaly_baseline (
    target_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (target_id, key)
  );
`;

const KAMINO_PROGRAM_ID = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const ORIGINAL_AUTHORITY = new PublicKey('11111111111111111111111111111112');
const NEW_AUTHORITY = new PublicKey('11111111111111111111111111111113');

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  vi.clearAllMocks();
});

afterEach(() => {
  db.close();
});

/** Build a fake ProgramData account buffer with the given upgrade_authority. */
function makeProgramDataBuffer(authority: PublicKey | null): Buffer {
  // Layout: [u32 variant=3][u64 slot][u8 option][32 pubkey]
  const slot = 12345n;
  if (!authority) {
    const buf = Buffer.alloc(13);
    buf.writeUInt32LE(3, 0);
    buf.writeBigUInt64LE(slot, 4);
    buf.writeUInt8(0, 12);
    return buf;
  }
  const buf = Buffer.alloc(45);
  buf.writeUInt32LE(3, 0);
  buf.writeBigUInt64LE(slot, 4);
  buf.writeUInt8(1, 12);
  authority.toBuffer().copy(buf, 13);
  return buf;
}

describe('parseUpgradeAuthority', () => {
  it('returns the pubkey when option byte = 1', () => {
    const buf = makeProgramDataBuffer(ORIGINAL_AUTHORITY);
    expect(parseUpgradeAuthority(buf)).toBe(ORIGINAL_AUTHORITY.toBase58());
  });

  it('returns null when program is frozen (option byte = 0)', () => {
    const buf = makeProgramDataBuffer(null);
    expect(parseUpgradeAuthority(buf)).toBeNull();
  });

  it('throws on too-short buffer', () => {
    expect(() => parseUpgradeAuthority(Buffer.alloc(8))).toThrow(/too short/);
  });

  it('throws on wrong variant tag', () => {
    const buf = Buffer.alloc(45);
    buf.writeUInt32LE(2, 0); // variant 2 = Program (not ProgramData)
    expect(() => parseUpgradeAuthority(buf)).toThrow(/variant/);
  });

  it('throws on invalid option byte', () => {
    const buf = Buffer.alloc(45);
    buf.writeUInt32LE(3, 0);
    buf.writeUInt8(2, 12);
    expect(() => parseUpgradeAuthority(buf)).toThrow(/Option byte/);
  });
});

describe('deriveProgramDataAddress', () => {
  it('produces a deterministic PDA for a given program id', () => {
    const a = deriveProgramDataAddress(KAMINO_PROGRAM_ID);
    const b = deriveProgramDataAddress(KAMINO_PROGRAM_ID);
    expect(a.toBase58()).toBe(b.toBase58());
    expect(a.toBase58()).not.toBe(KAMINO_PROGRAM_ID.toBase58());
  });
});

describe('AnomalyMonitor baseline persistence', () => {
  it('returns null when no baseline exists', () => {
    const m = new AnomalyMonitor(db, 'http://localhost');
    expect(m.hasBaseline('foo', 'bar')).toBe(false);
    expect(m.getBaseline('foo', 'bar')).toBeNull();
  });

  it('persists and retrieves baseline values', () => {
    const m = new AnomalyMonitor(db, 'http://localhost');
    m.setBaseline('foo', 'bar', 'baz');
    expect(m.hasBaseline('foo', 'bar')).toBe(true);
    expect(m.getBaseline('foo', 'bar')).toBe('baz');
  });

  it('overwrites existing baseline on repeat set', () => {
    const m = new AnomalyMonitor(db, 'http://localhost');
    m.setBaseline('foo', 'bar', 'one');
    m.setBaseline('foo', 'bar', 'two');
    expect(m.getBaseline('foo', 'bar')).toBe('two');
  });

  it('persists null values (frozen program)', () => {
    const m = new AnomalyMonitor(db, 'http://localhost');
    m.setBaseline('foo', 'bar', null);
    expect(m.hasBaseline('foo', 'bar')).toBe(true);
    expect(m.getBaseline('foo', 'bar')).toBeNull();
  });

  it('rejects duplicate handler registration', () => {
    const m = new AnomalyMonitor(db, 'http://localhost');
    const h1 = createUpgradeAuthorityHandler({
      programId: KAMINO_PROGRAM_ID,
      id: 'kamino-lending',
      label: 'Kamino',
    });
    const h2 = createUpgradeAuthorityHandler({
      programId: KAMINO_PROGRAM_ID,
      id: 'kamino-lending',
      label: 'Kamino dup',
    });
    m.register(h1);
    expect(() => m.register(h2)).toThrow(/already registered/);
  });
});

describe('UpgradeAuthorityHandler.check', () => {
  function setupMonitor(authority: PublicKey | null) {
    const m = new AnomalyMonitor(db, 'http://localhost');
    const handler = createUpgradeAuthorityHandler({
      programId: KAMINO_PROGRAM_ID,
      id: 'kamino-lending',
      label: 'Kamino Lending',
    });
    m.register(handler);

    const buf = authority ? makeProgramDataBuffer(authority) : makeProgramDataBuffer(null);
    const stub = vi.fn().mockResolvedValue({ data: buf });
    (m.connection as unknown as { getAccountInfo: typeof stub }).getAccountInfo = stub;

    return { monitor: m, handler, stub };
  }

  it('seeds baseline on first observation and does not alert', async () => {
    const { monitor, handler } = setupMonitor(ORIGINAL_AUTHORITY);
    await handler.check(monitor);

    const baselineKey = `upgrade_authority:kamino-lending`;
    expect(monitor.getBaseline(baselineKey, 'upgrade_authority')).toBe(ORIGINAL_AUTHORITY.toBase58());
    expect(sendAlert).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('does not re-alert when authority is unchanged', async () => {
    const { monitor, handler } = setupMonitor(ORIGINAL_AUTHORITY);
    await handler.seed(monitor);
    await handler.check(monitor);
    expect(sendAlert).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('fires critical alert and records event when authority changes', async () => {
    const { monitor, handler, stub } = setupMonitor(ORIGINAL_AUTHORITY);
    await handler.seed(monitor);

    // Simulate the authority changing on chain
    stub.mockResolvedValue({ data: makeProgramDataBuffer(NEW_AUTHORITY) });
    await handler.check(monitor);

    expect(sendAlert).toHaveBeenCalledTimes(1);
    const [msg, level] = (sendAlert as unknown as { mock: { calls: [string, string][] } }).mock.calls[0]!;
    expect(level).toBe('critical');
    expect(msg).toContain('Upgrade authority changed for Kamino Lending');
    expect(msg).toContain(ORIGINAL_AUTHORITY.toBase58());
    expect(msg).toContain(NEW_AUTHORITY.toBase58());

    expect(recordEvent).toHaveBeenCalledTimes(1);
    const recorded = (recordEvent as unknown as { mock: { calls: [{ eventType: string; metadata: Record<string, unknown> }][] } })
      .mock.calls[0]![0];
    expect(recorded.eventType).toBe('anomaly');
    expect(recorded.metadata['action']).toBe('anomaly_upgrade_authority_change');
    expect(recorded.metadata['before']).toBe(ORIGINAL_AUTHORITY.toBase58());
    expect(recorded.metadata['after']).toBe(NEW_AUTHORITY.toBase58());
  });

  it('updates baseline after detecting a change so it does not re-alert', async () => {
    const { monitor, handler, stub } = setupMonitor(ORIGINAL_AUTHORITY);
    await handler.seed(monitor);

    stub.mockResolvedValue({ data: makeProgramDataBuffer(NEW_AUTHORITY) });
    await handler.check(monitor);
    await handler.check(monitor); // re-run with same new authority

    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledTimes(1);
  });

  it('detects transition from authority to frozen', async () => {
    const { monitor, handler, stub } = setupMonitor(ORIGINAL_AUTHORITY);
    await handler.seed(monitor);

    stub.mockResolvedValue({ data: makeProgramDataBuffer(null) });
    await handler.check(monitor);

    expect(sendAlert).toHaveBeenCalledTimes(1);
    const [msg] = (sendAlert as unknown as { mock: { calls: [string, string][] } }).mock.calls[0]!;
    expect(msg).toContain('<frozen>');
  });

  it('runChecks dispatches to all handlers and isolates handler errors', async () => {
    const { monitor, stub } = setupMonitor(ORIGINAL_AUTHORITY);
    await monitor.seedBaselines();

    stub.mockRejectedValueOnce(new Error('RPC down'));
    await expect(monitor.runChecks()).resolves.not.toThrow();
  });
});

describe('AnomalyMonitor.processEvent', () => {
  it('triggers runChecks regardless of payload contents', async () => {
    const m = new AnomalyMonitor(db, 'http://localhost');
    const calls = { count: 0 };
    m.register({
      id: 'fake',
      label: 'Fake',
      watchedAddresses: () => [],
      seed: async () => { /* no-op */ },
      check: async () => { calls.count++; },
    });

    await m.processEvent(null);
    await m.processEvent({ random: 'payload' });
    await m.processEvent('not-json');

    expect(calls.count).toBe(3);
  });
});
