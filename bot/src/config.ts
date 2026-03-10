import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { EventEmitter } from 'events';
import { watch } from 'chokidar';
import type { VaultConfig } from './types.js';

const CONFIG_DIR = join(process.cwd(), 'config');
const CONFIG_PATH = join(CONFIG_DIR, 'default.json');
const ENV_CONFIG_PATH = join(CONFIG_DIR, `${process.env.NODE_ENV || 'development'}.json`);

const DEFAULT_CONFIG: VaultConfig = {
  general: {
    dryRun: true,
    logLevel: 'info',
    tickIntervalMs: 30_000,
    snapshotIntervalMs: 300_000, // 5min
    lendingRebalanceIntervalMs: 21_600_000, // 6h
    dailyPnlTimeUtc: '00:00',
  },
  binance: {
    symbol: 'SOLUSDT',
    leverage: 1,
    testnet: true,
  },
  solana: {
    network: 'devnet',
  },
  thresholds: {
    frEntryAnnualized: 10,
    frEntryConfirmationDays: 3,
    frExitAnnualized: 0,
    frExitConfirmationDays: 3,
    frEmergencyAnnualized: -10,
    dnAllocationMax: 0.7,
    lendingRebalanceMinDiffBps: 50,
  },
  risk: {
    dailyLossLimitPct: 2,
    maxPositionCapUsd: 10_000,
    maxTransferSizeUsd: 5_000,
    positionDivergenceThresholdPct: 3,
  },
  lending: {
    protocols: ['kamino', 'drift', 'jupiter'],
    bufferPct: 5,
  },
};

class ConfigManager extends EventEmitter {
  private config: VaultConfig;
  private watcher: ReturnType<typeof watch> | null = null;

  constructor() {
    super();
    this.config = this.loadConfig();
  }

  private loadConfig(): VaultConfig {
    let config = { ...DEFAULT_CONFIG };

    // Load default.json
    if (existsSync(CONFIG_PATH)) {
      try {
        const raw = readFileSync(CONFIG_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<VaultConfig>;
        config = this.mergeConfig(config, parsed);
      } catch (err) {
        console.error('Failed to load default config:', err);
      }
    }

    // Overlay environment-specific config (e.g. production.json)
    if (existsSync(ENV_CONFIG_PATH) && ENV_CONFIG_PATH !== CONFIG_PATH) {
      try {
        const raw = readFileSync(ENV_CONFIG_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<VaultConfig>;
        config = this.mergeConfig(config, parsed);
        console.log(`Loaded environment config: ${ENV_CONFIG_PATH}`);
      } catch (err) {
        console.error(`Failed to load environment config ${ENV_CONFIG_PATH}:`, err);
      }
    }

    return config;
  }

  private mergeConfig(defaults: VaultConfig, overrides: Partial<VaultConfig>): VaultConfig {
    return {
      general: { ...defaults.general, ...overrides.general },
      binance: { ...defaults.binance, ...overrides.binance },
      solana: { ...defaults.solana, ...overrides.solana },
      thresholds: { ...defaults.thresholds, ...overrides.thresholds },
      risk: { ...defaults.risk, ...overrides.risk },
      lending: { ...defaults.lending, ...overrides.lending },
    };
  }

  get(): VaultConfig {
    return this.config;
  }

  startWatching(): void {
    this.watcher = watch(CONFIG_PATH, { ignoreInitial: true });
    this.watcher.on('change', () => {
      const oldConfig = this.config;
      this.config = this.loadConfig();
      this.emit('change', this.config, oldConfig);
    });
  }

  stopWatching(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}

export const configManager = new ConfigManager();
export const getConfig = () => configManager.get();
