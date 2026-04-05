#!/usr/bin/env tsx
/**
 * Local AI Advisor test runner.
 *
 * Fetches current vault state from the remote bot API and runs the
 * advisor evaluation locally using your ANTHROPIC_API_KEY.
 *
 * Usage:
 *   # Against remote bot
 *   BOT_API_URL=https://your-bot:3000 BOT_API_TOKEN=xxx tsx scripts/run-advisor.ts
 *
 *   # Against local bot (default)
 *   tsx scripts/run-advisor.ts
 *
 *   # Dry-run: just print context without calling Claude
 *   tsx scripts/run-advisor.ts --dry-run
 */
import dotenv from 'dotenv';
import { resolve } from 'path';
import Anthropic from '@anthropic-ai/sdk';

// Load .env from vault root first, then bot dir (bot overrides vault root)
dotenv.config({ path: resolve(process.cwd(), '../.env') });
dotenv.config();

const BOT_API_URL = process.env.BOT_API_URL || 'http://localhost:3000';
const BOT_API_TOKEN = process.env.BOT_API_TOKEN || process.env.API_AUTH_TOKEN || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DRY_RUN = process.argv.includes('--dry-run');
const MODEL = process.env.ADVISOR_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = 2048;
const SAVE_TO_DB = process.argv.includes('--save');

// ── Fetch from bot API ──────────────────────────────────────

async function apiFetch<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (BOT_API_TOKEN) {
    headers['Authorization'] = `Bearer ${BOT_API_TOKEN}`;
  }
  const res = await fetch(`${BOT_API_URL}${path}`, { headers });
  if (!res.ok) throw new Error(`API ${path}: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

// ── Build context from remote API data ──────────────────────

async function buildRemoteContext(): Promise<string> {
  const [status, apys, multiply, events, fr, pnl] = await Promise.all([
    apiFetch<any>('/api/status'),
    apiFetch<any>('/api/apys'),
    apiFetch<any>('/api/multiply'),
    apiFetch<any>('/api/events?limit=20'),
    apiFetch<any>('/api/fr?limit=9'),
    apiFetch<any>('/api/pnl?from=' + new Date(Date.now() - 7 * 86_400_000).toISOString().split('T')[0]),
  ]);

  const s = status.snapshot || {};
  const lines: string[] = [];

  lines.push('## Current State');
  lines.push(`Bot State: ${status.state}`);
  lines.push(`NAV: $${num(s.totalNavUsdc)}`);
  lines.push(`SOL Price: $${num(s.solPrice)}`);

  lines.push('\n## Positions');
  lines.push(`Multiply: $${num(s.multiplyBalance)}`);
  if (s.multiplyBreakdown) {
    for (const [label, val] of Object.entries(s.multiplyBreakdown)) {
      lines.push(`  - ${label}: $${num(val as number)}`);
    }
  }
  lines.push(`Lending: $${num(s.lendingBalance)}`);
  if (s.lendingBreakdown) {
    for (const [proto, bal] of Object.entries(s.lendingBreakdown)) {
      lines.push(`  - ${proto}: $${num(bal as number)}`);
    }
  }
  lines.push(`Buffer: $${num(s.bufferUsdcBalance)}`);

  // FR
  lines.push('\n## Funding Rate');
  if (fr.length > 0) {
    const latest = fr[0];
    const annualized = latest.fundingRate * 3 * 365 * 100;
    lines.push(`Latest (annualized): ${annualized.toFixed(2)}%`);
    lines.push('Recent:');
    for (const f of fr.slice(0, 6)) {
      const ann = f.fundingRate * 3 * 365 * 100;
      lines.push(`  - ${new Date(f.fundingTime).toISOString()}: ${ann.toFixed(2)}%`);
    }
  }

  // APY
  lines.push('\n## APY');
  lines.push('Lending:');
  for (const item of apys.lending || []) {
    lines.push(`  - ${item.protocol}: ${(item.apy * 100).toFixed(2)}%`);
  }

  // Multiply positions
  if (multiply.positions?.length > 0) {
    lines.push('\nMultiply Positions:');
    for (const p of multiply.positions) {
      lines.push(`  - ${p.label}: APY=${(p.effectiveApy * 100).toFixed(2)}%, HR=${p.healthRate.toFixed(3)}, Lev=${p.leverage.toFixed(2)}x, Bal=$${num(p.balance)}`);
    }
  }

  // Multiply candidates with risk
  if (multiply.candidates?.length > 0) {
    lines.push('\nMultiply Candidates:');
    for (const c of multiply.candidates) {
      const risk = c.riskAssessment;
      const riskStr = risk ? ` risk=${risk.compositeScore} (${risk.alertLevel})` : '';
      lines.push(`  - ${c.label}: APY=${(c.effectiveApy * 100).toFixed(2)}%${riskStr}${c.active ? ' [ACTIVE]' : ''}`);
    }
  }

  // PnL
  if (pnl.length > 0) {
    const latest = pnl[pnl.length - 1];
    lines.push('\n## PnL');
    lines.push(`Latest daily return: ${(latest.dailyReturn * 100).toFixed(4)}%`);
    lines.push(`Cumulative: ${(latest.cumulativeReturn * 100).toFixed(4)}%`);
    lines.push(`Max drawdown: ${(latest.maxDrawdown * 100).toFixed(4)}%`);
  }

  // Recent events
  if (events.length > 0) {
    lines.push('\n## Recent Events (24h)');
    for (const e of events.slice(0, 10)) {
      lines.push(`  ${e.timestamp} ${e.eventType} ${e.amount} ${e.asset}${e.sourceProtocol ? ` (${e.sourceProtocol})` : ''}`);
    }
  }

  return lines.join('\n');
}

function num(v: unknown): string {
  return typeof v === 'number' ? v.toFixed(2) : '-';
}

import { SYSTEM_PROMPT } from '../src/advisor/prompt.js';

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log(`\n📡 Fetching vault state from ${BOT_API_URL}...\n`);

  const contextText = await buildRemoteContext();

  console.log('━'.repeat(60));
  console.log(contextText);
  console.log('━'.repeat(60));

  if (DRY_RUN) {
    console.log('\n🔍 Dry run — context printed above. Pass without --dry-run to call Claude.\n');
    return;
  }

  if (!ANTHROPIC_API_KEY) {
    console.error('\n❌ ANTHROPIC_API_KEY not set. Set it in .env or environment.\n');
    process.exit(1);
  }

  console.log(`\n🤖 Calling ${MODEL}...\n`);

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Analyze the following vault state and provide recommendations:\n\n${contextText}`,
      },
    ],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  console.log('━'.repeat(60));
  console.log('📋 AI Advisor Response:\n');
  console.log(text);
  console.log('━'.repeat(60));

  // Parse and pretty-print
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const recs = JSON.parse(jsonMatch[0]);
      console.log(`\n✅ ${recs.length} recommendation(s):\n`);
      for (const rec of recs) {
        const icon = rec.override ? '🔴' : '🟢';
        const urgIcon = rec.urgency === 'immediate' ? '⚡' : rec.urgency === 'next_cycle' ? '⏰' : '📋';
        console.log(`${icon} ${urgIcon} [${rec.category}] (${rec.confidence})`);
        console.log(`   Action: ${rec.action}`);
        console.log(`   Reason: ${rec.reasoning}`);
        if (rec.override) {
          console.log(`   ⚠️  Override — rule says: ${rec.currentRule}`);
        }
        console.log('');
      }
    }
  } catch {
    // Already printed raw text above
  }

  // Save to DB if --save flag
  const jsonMatch2 = text.match(/\[[\s\S]*\]/);
  if (SAVE_TO_DB && jsonMatch2) {
    try {
      const { initDb } = await import('../src/measurement/db.js');
      const db = initDb();
      const { AdvisorStore } = await import('../src/advisor/store.js');
      const store = new AdvisorStore(db);
      const now = Date.now();
      const parsed = JSON.parse(jsonMatch2[0]) as Array<Record<string, unknown>>;
      for (const item of parsed) {
        store.save({
          timestamp: now,
          category: item['category'] as any,
          action: String(item['action'] ?? ''),
          reasoning: String(item['reasoning'] ?? ''),
          confidence: (item['confidence'] as any) ?? 'low',
          urgency: (item['urgency'] as any) ?? 'informational',
          currentRule: String(item['currentRule'] ?? ''),
          override: Boolean(item['override']),
        });
      }
      console.log(`\n💾 Saved ${parsed.length} recommendations to DB`);
      db.close();
    } catch (err) {
      console.error('Failed to save to DB:', (err as Error).message);
    }
  }

  // Show usage
  console.log(`📊 Usage: ${response.usage.input_tokens} input + ${response.usage.output_tokens} output tokens`);
  const cost = (response.usage.input_tokens * 3 + response.usage.output_tokens * 15) / 1_000_000;
  console.log(`💰 Estimated cost: $${cost.toFixed(4)}\n`);
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
