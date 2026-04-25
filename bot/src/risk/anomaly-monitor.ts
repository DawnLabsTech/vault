import type Database from 'better-sqlite3';
import { Connection, PublicKey } from '@solana/web3.js';
import { recordEvent } from '../measurement/events.js';
import { sendAlert } from '../utils/notify.js';
import { createChildLogger } from '../utils/logger.js';
import { EventType } from '../types.js';

const log = createChildLogger('anomaly-monitor');

const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  'BPFLoaderUpgradeab1e11111111111111111111111',
);

const KAMINO_LENDING_PROGRAM_ID = new PublicKey(
  'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD',
);

export interface AnomalyHandler {
  /** Stable id used in DB target_id, log context, and Helius webhook setup */
  id: string;
  /** Human-readable label for alerts */
  label: string;
  /** Addresses Helius should monitor for this handler (used by setup-helius-webhook) */
  watchedAddresses(): string[];
  /** Fetch current on-chain state and persist as baseline. No-op if baseline already exists. */
  seed(monitor: AnomalyMonitor): Promise<void>;
  /** Fetch current state, compare with baseline, alert + update on divergence */
  check(monitor: AnomalyMonitor): Promise<void>;
}

/**
 * Coordinates anomaly detection handlers and shared baseline persistence.
 *
 * Detection strategy: Helius webhooks fire `processEvent()` whenever a watched
 * account is touched. The webhook payload is intentionally NOT parsed —
 * instead, every handler re-fetches on-chain state and compares against its
 * persisted baseline. This makes the system robust to changes in Helius's
 * payload format and easy to reason about.
 */
export class AnomalyMonitor {
  private handlers = new Map<string, AnomalyHandler>();
  private db: Database.Database;
  readonly connection: Connection;

  constructor(db: Database.Database, rpcUrl: string) {
    this.db = db;
    if (!rpcUrl) {
      throw new Error('AnomalyMonitor requires an RPC URL');
    }
    this.connection = new Connection(rpcUrl, 'confirmed');
  }

  register(handler: AnomalyHandler): void {
    if (this.handlers.has(handler.id)) {
      throw new Error(`Anomaly handler already registered: ${handler.id}`);
    }
    this.handlers.set(handler.id, handler);
    log.info({ handler: handler.id }, 'Anomaly handler registered');
  }

  getHandlers(): AnomalyHandler[] {
    return [...this.handlers.values()];
  }

  /** Seed baselines for all handlers that have no baseline yet. */
  async seedBaselines(): Promise<void> {
    for (const handler of this.handlers.values()) {
      try {
        await handler.seed(this);
      } catch (err) {
        log.error(
          { handler: handler.id, error: (err as Error).message },
          'Failed to seed baseline',
        );
      }
    }
  }

  /** Run check() on all handlers (used by webhook + scheduled polling). */
  async runChecks(): Promise<void> {
    for (const handler of this.handlers.values()) {
      try {
        await handler.check(this);
      } catch (err) {
        log.error(
          { handler: handler.id, error: (err as Error).message },
          'Anomaly check failed',
        );
      }
    }
  }

  /** Webhook entrypoint — payload is ignored; we re-fetch on-chain state. */
  async processEvent(_payload: unknown): Promise<void> {
    log.debug('Webhook event received, running checks');
    await this.runChecks();
  }

  // ── Baseline persistence ─────────────────────────────────────

  hasBaseline(targetId: string, key: string): boolean {
    const row = this.db
      .prepare(
        'SELECT 1 AS hit FROM anomaly_baseline WHERE target_id = ? AND key = ? LIMIT 1',
      )
      .get(targetId, key) as { hit: number } | undefined;
    return row !== undefined;
  }

  getBaseline(targetId: string, key: string): string | null {
    const row = this.db
      .prepare(
        'SELECT value FROM anomaly_baseline WHERE target_id = ? AND key = ? LIMIT 1',
      )
      .get(targetId, key) as { value: string | null } | undefined;
    return row ? row.value : null;
  }

  setBaseline(targetId: string, key: string, value: string | null): void {
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO anomaly_baseline (target_id, key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(target_id, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(targetId, key, value, updatedAt);
  }
}

// ── BPF Loader Upgradeable helpers ──────────────────────────────

/**
 * Derive the BPF Loader Upgradeable ProgramData PDA for a given program id.
 * Seeds: [programId.toBuffer()] under the BPF Loader Upgradeable program.
 */
export function deriveProgramDataAddress(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  );
  return pda;
}

/**
 * Parse upgrade_authority from a BPF Loader Upgradeable ProgramData account.
 *
 * Bincode layout (UpgradeableLoaderState::ProgramData):
 *   [0..4]   variant tag (u32 LE = 3 for ProgramData)
 *   [4..12]  slot (u64 LE)
 *   [12]     Option<Pubkey> tag (0 = None, 1 = Some)
 *   [13..45] Pubkey bytes (only when option tag = 1)
 *
 * Returns null when the program is frozen (no upgrade authority).
 */
export function parseUpgradeAuthority(data: Buffer): string | null {
  if (data.length < 13) {
    throw new Error(`ProgramData account too short: ${data.length} bytes`);
  }
  const variant = data.readUInt32LE(0);
  if (variant !== 3) {
    throw new Error(`Unexpected ProgramData variant: ${variant} (expected 3)`);
  }
  const optionByte = data.readUInt8(12);
  if (optionByte === 0) return null;
  if (optionByte !== 1) {
    throw new Error(`Invalid Option byte for upgrade_authority: ${optionByte}`);
  }
  if (data.length < 45) {
    throw new Error('ProgramData truncated before upgrade_authority pubkey');
  }
  return new PublicKey(data.subarray(13, 45)).toBase58();
}

// ── Handlers ────────────────────────────────────────────────────

interface UpgradeAuthorityHandlerOptions {
  programId: PublicKey;
  /** Stable handler id (used in DB target_id and logs) */
  id: string;
  /** Human-readable label for alerts */
  label: string;
}

/**
 * Watch a program's upgrade_authority and alert on any change.
 *
 * `seed()` records the current authority. `check()` re-fetches and compares;
 * on divergence it fires a critical alert, records an ANOMALY event, and
 * updates the baseline so subsequent checks don't re-fire on the same change.
 */
export function createUpgradeAuthorityHandler(
  opts: UpgradeAuthorityHandlerOptions,
): AnomalyHandler {
  const programDataAddress = deriveProgramDataAddress(opts.programId);
  const targetId = `upgrade_authority:${opts.id}`;
  const key = 'upgrade_authority';

  async function fetchCurrent(monitor: AnomalyMonitor): Promise<string | null> {
    const info = await monitor.connection.getAccountInfo(programDataAddress, 'confirmed');
    if (!info) {
      throw new Error(`ProgramData account not found: ${programDataAddress.toBase58()}`);
    }
    return parseUpgradeAuthority(info.data);
  }

  return {
    id: opts.id,
    label: opts.label,

    watchedAddresses(): string[] {
      return [programDataAddress.toBase58()];
    },

    async seed(monitor): Promise<void> {
      if (monitor.hasBaseline(targetId, key)) {
        log.debug({ id: opts.id }, 'Baseline already present, skipping seed');
        return;
      }
      const authority = await fetchCurrent(monitor);
      monitor.setBaseline(targetId, key, authority);
      log.info(
        {
          id: opts.id,
          programDataAddress: programDataAddress.toBase58(),
          authority,
        },
        'Seeded upgrade authority baseline',
      );
    },

    async check(monitor): Promise<void> {
      if (!monitor.hasBaseline(targetId, key)) {
        await this.seed(monitor);
        return;
      }

      const baseline = monitor.getBaseline(targetId, key);
      const current = await fetchCurrent(monitor);
      if (current === baseline) {
        log.debug({ id: opts.id, authority: current }, 'Upgrade authority unchanged');
        return;
      }

      const message =
        `Upgrade authority changed for ${opts.label}\n` +
        `  Program: ${opts.programId.toBase58()}\n` +
        `  ProgramData: ${programDataAddress.toBase58()}\n` +
        `  Before: ${baseline ?? '<frozen>'}\n` +
        `  After:  ${current ?? '<frozen>'}`;
      log.error(
        { id: opts.id, before: baseline, after: current },
        'UPGRADE AUTHORITY CHANGED',
      );

      recordEvent({
        timestamp: new Date().toISOString(),
        eventType: EventType.ANOMALY,
        amount: 0,
        asset: 'N/A',
        sourceProtocol: opts.id,
        metadata: {
          action: 'anomaly_upgrade_authority_change',
          programId: opts.programId.toBase58(),
          programDataAddress: programDataAddress.toBase58(),
          before: baseline,
          after: current,
        },
      });

      await sendAlert(message, 'critical');

      // Update baseline so we don't re-alert; operator investigates the change.
      monitor.setBaseline(targetId, key, current);
    },
  };
}

/** Default handler set for Phase 1. */
export function createDefaultHandlers(): AnomalyHandler[] {
  return [
    createUpgradeAuthorityHandler({
      programId: KAMINO_LENDING_PROGRAM_ID,
      id: 'kamino-lending',
      label: 'Kamino Lending program',
    }),
  ];
}

export const KAMINO_LENDING_PROGRAM = KAMINO_LENDING_PROGRAM_ID;
