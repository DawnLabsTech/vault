import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { EventEmitter } from 'events';
import { watch } from 'chokidar';
import type { PerpExchange, VaultConfig, MultiplyRebalanceConfig, BorrowRateSpikeConfig } from './types.js';

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
  perp: {
    exchange: 'binance',
    symbol: 'SOLUSDC',
    leverage: 1,
    swapSlippageBps: 50,
  },
  binance: {
    symbol: 'SOLUSDC',
    leverage: 1,
    testnet: true,
    swapSlippageBps: 50,
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
    protocols: ['kamino', 'jupiter'],
    bufferPct: 5,
  },
  borrowRateSpike: {
    absoluteThresholdAnnualized: 0.20,  // 20% annualized
    rateChangeThresholdBps: 500,        // +5% per hour
    negativeSpreadThreshold: 0,         // effective APY < 0
    sampleRetentionDays: 7,
  },
  multiplyRebalance: {
    minDiffBps: 100,
    minHoldingDays: 3,
    scanIntervalMs: 21_600_000, // 6h
    paybackWindowDays: 7,
    estimatedSwitchCostBps: 20,
    estimatedSwitchCostUsd: 1,
    minNetGainUsd: 0,
    riskPenalty: [0, 0.005, 0.015],
    defaultTargetHealthRate: 1.15,
    defaultAlertHealthRate: 1.10,
    defaultEmergencyHealthRate: 1.05,
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

    // Apply environment variable overrides
    config = this.applyEnvOverrides(config);

    return config;
  }

  private applyEnvOverrides(config: VaultConfig): VaultConfig {
    if (process.env.PERP_EXCHANGE) {
      const exchange = process.env.PERP_EXCHANGE.toLowerCase() as PerpExchange;
      if (exchange === 'binance') {
        config.perp.exchange = exchange;
      }
    }
    return config;
  }

  private mergeConfig(defaults: VaultConfig, overrides: Partial<VaultConfig>): VaultConfig {
    return {
      general: { ...defaults.general, ...overrides.general },
      perp: { ...defaults.perp, ...overrides.perp },
      binance: { ...defaults.binance, ...overrides.binance },
      solana: { ...defaults.solana, ...overrides.solana },
      thresholds: { ...defaults.thresholds, ...overrides.thresholds },
      risk: { ...defaults.risk, ...overrides.risk },
      lending: { ...defaults.lending, ...overrides.lending },
      borrowRateSpike: { ...defaults.borrowRateSpike!, ...overrides.borrowRateSpike },
      oracleMonitor: overrides.oracleMonitor ?? defaults.oracleMonitor,
      kaminoLoop: overrides.kaminoLoop ?? defaults.kaminoLoop,
      kaminoMultiply: overrides.kaminoMultiply ?? defaults.kaminoMultiply,
      kaminoMultiplyCandidates: overrides.kaminoMultiplyCandidates ?? defaults.kaminoMultiplyCandidates,
      multiplyRebalance: { ...defaults.multiplyRebalance!, ...overrides.multiplyRebalance },
      riskScorer: overrides.riskScorer ?? defaults.riskScorer,
    };
  }

  get(): VaultConfig {
    return this.config;
  }

  private validateConfig(config: VaultConfig): string[] {
    const errors: string[] = [];
    if (config.risk.dailyLossLimitPct <= 0 || config.risk.dailyLossLimitPct > 100) {
      errors.push(`risk.dailyLossLimitPct must be in (0, 100], got ${config.risk.dailyLossLimitPct}`);
    }
    if (!Number.isFinite(config.risk.maxPositionCapUsd) || config.risk.maxPositionCapUsd <= 0) {
      errors.push(`risk.maxPositionCapUsd must be a positive finite number, got ${config.risk.maxPositionCapUsd}`);
    }
    if (config.general.tickIntervalMs < 1000) {
      errors.push(`general.tickIntervalMs must be >= 1000, got ${config.general.tickIntervalMs}`);
    }
    if (config.thresholds.dnAllocationMax <= 0 || config.thresholds.dnAllocationMax > 1) {
      errors.push(`thresholds.dnAllocationMax must be in (0, 1], got ${config.thresholds.dnAllocationMax}`);
    }
    return errors;
  }

  startWatching(): void {
    this.watcher = watch(CONFIG_PATH, { ignoreInitial: true });
    this.watcher.on('change', () => {
      const candidate = this.loadConfig();
      const validationErrors = this.validateConfig(candidate);
      if (validationErrors.length > 0) {
        console.error('Config reload rejected — validation errors:', validationErrors);
        return;
      }
      const oldConfig = this.config;
      this.config = candidate;
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
