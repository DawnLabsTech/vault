/**
 * Check Multiply risk scores for configured candidate pairs.
 * Run: npx tsx scripts/check-multiply-risk.ts
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import path from 'path';
import { MultiplyRiskScorer } from '../src/risk/multiply-risk-scorer.js';
import type { MultiplyCandidate, RiskScorerConfig } from '../src/types.js';

const RPC_URL = process.env.HELIUS_RPC_URL || '';
if (!RPC_URL) {
  console.error('HELIUS_RPC_URL not set');
  process.exit(1);
}

const CANDIDATES: MultiplyCandidate[] = [
  {
    market: '47tfyEG9SsdEnUm9cw5kY9BXngQGqu3LBoop9j5uTAv8',
    collToken: '5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5',
    debtToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    label: 'ONyc/USDC',
    riskTier: 2,
    collDecimals: 9,
    debtDecimals: 6,
    collNativeYield: 0.045,
    minTvlUsdc: 500_000,
  },
  {
    market: '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF',
    collToken: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH',
    debtToken: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
    label: 'USDG/PYUSD',
    riskTier: 1,
    collDecimals: 6,
    debtDecimals: 6,
    collNativeYield: 0,
    minTvlUsdc: 1_000_000,
    inputToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    inputDecimals: 6,
  },
];

const RISK_CONFIG: RiskScorerConfig = {
  weights: {
    depegRisk: 0.30,
    liquidationProximity: 0.30,
    exitLiquidity: 0.20,
    reservePressure: 0.20,
  },
  maxDeviationBps: 200,
  maxSlippageBps: 100,
  criticalUtilization: 0.90,
  tvlSafeThreshold: 10_000_000,
  rejectThreshold: 90,
  emergencyThreshold: 85,
  emaSmoothingAlpha: 0.3,
};

async function main() {
  const dbPath = path.resolve(import.meta.dirname, '../data/vault.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const scorer = new MultiplyRiskScorer(RPC_URL, RISK_CONFIG, db);
  const maxPositionCap = 10_000;

  console.log('=== Multiply Risk Assessment ===\n');
  console.log(`Max position cap: $${maxPositionCap.toLocaleString()}`);
  console.log(`EMA smoothing alpha: ${RISK_CONFIG.emaSmoothingAlpha}`);
  console.log('');

  for (const candidate of CANDIDATES) {
    try {
      console.log(`--- ${candidate.label} ---`);
      const assessment = await scorer.assessCandidate(candidate, maxPositionCap);
      const d = assessment.dimensions;

      console.log(`  Composite Score: ${assessment.compositeScore.toFixed(1)} / 100`);
      console.log(`  Alert Level:     ${assessment.alertLevel}`);
      console.log('');
      console.log('  Dimensions:');
      console.log(`    D1 Depeg Risk:             ${d.depegRisk.toFixed(1)} (weight 30%)`);
      console.log(`    D2 Liquidation Proximity:  ${d.liquidationProximity.toFixed(1)} (weight 30%)`);
      console.log(`    D3 Exit Liquidity:         ${d.exitLiquidity.toFixed(1)} (weight 20%)`);
      console.log(`    D4 Reserve Pressure:       ${d.reservePressure.toFixed(1)} (weight 20%)`);
      console.log('');
      console.log('  Derived Parameters:');
      console.log(`    Risk Penalty:          ${(assessment.riskPenalty * 100).toFixed(2)}%`);
      console.log(`    Target Health Rate:    ${assessment.targetHealthRate.toFixed(2)}`);
      console.log(`    Max Position Cap:      $${assessment.maxPositionCap.toLocaleString()}`);
      console.log('');
    } catch (err) {
      console.error(`  ERROR: ${(err as Error).message}`);
      console.log('');
    }
  }

  // Summary table
  console.log('=== Summary ===\n');
  console.log('Pair          | Score | Penalty | Health | MaxPos  | Alert');
  console.log('------------- | ----- | ------- | ------ | ------- | --------');

  const assessments = await scorer.assessAll(CANDIDATES, maxPositionCap);
  for (const a of assessments) {
    const label = a.label.padEnd(13);
    const score = a.compositeScore.toFixed(1).padStart(5);
    const penalty = `${(a.riskPenalty * 100).toFixed(2)}%`.padStart(7);
    const health = a.targetHealthRate.toFixed(2).padStart(6);
    const cap = `$${a.maxPositionCap.toLocaleString()}`.padStart(7);
    const alert = a.alertLevel.padStart(8);
    console.log(`${label} | ${score} | ${penalty} | ${health} | ${cap} | ${alert}`);
  }

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
