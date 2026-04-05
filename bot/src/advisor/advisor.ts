import Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { buildAdvisorContext, contextToPromptText, type ContextBuilderDeps } from './context-builder.js';
import { AdvisorStore } from './store.js';
import type { AdvisorConfig, AdvisorRecommendation } from './types.js';
import type { BotState, VaultConfig } from '../types.js';
import { sendAlert } from '../utils/notify.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('advisor');

const DEFAULT_CONFIG: AdvisorConfig = {
  intervalMs: 21_600_000, // 6h
  priceChangeThresholdPct: 0.05,
  maxCallsPerDay: 20,
  model: 'claude-sonnet-4-6-20250514',
  maxTokens: 1024,
  notifyEnabled: true,
};

const SYSTEM_PROMPT = `You are an AI advisor for a DeFi vault strategy bot operating on Solana.
Your role is to analyze the bot's current state and market conditions, then provide actionable recommendations.

## Bot Overview
The vault runs two layers:
1. **Base Layer (always-on)**: Kamino Multiply leveraged yield + lending overflow (Kamino/Jupiter)
2. **Alpha Layer (conditional)**: SOL delta-neutral position (dawnSOL long + Binance SOL-PERP short) during positive funding rate regimes

The bot uses rule-based thresholds for decisions. Your job is to evaluate whether those rules are making optimal decisions given the broader context.

## Your Judgment Areas

### 1. Rebalance Timing
The bot rebalances lending allocations when APY spread exceeds a threshold.
Consider: Is the APY difference likely to persist or is it transient? Is market volatility high enough that rebalancing now could result in slippage or missed opportunity?

### 2. DN Entry/Exit
The bot enters DN when funding rate averages above threshold for N days, exits when below.
Consider: Is the funding rate trend likely to continue? Are there signs of OI shifts, liquidation cascades, or macro events that could reverse the trend?

### 3. Risk Assessment
The bot uses quantitative risk scores (depeg, liquidation proximity, exit liquidity, reserve pressure).
Consider: Are there qualitative risks not captured by the scores? Protocol governance changes, oracle issues, ecosystem-wide risks?

### 4. Parameter Adjustment
Consider: Given recent market behavior, should any thresholds be adjusted? Are confirmation periods too long/short for the current volatility regime?

## Response Format
Respond with a JSON array of recommendations. Each element:
{
  "category": "rebalance" | "dn_entry" | "dn_exit" | "risk_alert" | "param_adjust",
  "action": "brief description of recommended action",
  "reasoning": "1-2 sentence explanation of why",
  "confidence": "high" | "medium" | "low",
  "urgency": "immediate" | "next_cycle" | "informational",
  "currentRule": "what the existing rule-based system would do",
  "override": true/false (true if your recommendation differs from the rule)
}

If no recommendations are warranted, return an empty array: []

## Guidelines
- Be conservative. Only recommend overrides when you have high confidence.
- Never recommend actions that violate risk limits (daily loss limit, max position cap).
- Prefer "informational" urgency unless there's a clear time-sensitive opportunity or threat.
- Keep reasoning concise but specific — reference the actual numbers from the context.
- If risk scores are elevated (>75), prioritize risk management recommendations.`;

export class Advisor {
  private client: Anthropic;
  private store: AdvisorStore;
  private config: AdvisorConfig;
  private deps: ContextBuilderDeps;
  private callsToday = 0;
  private callCountResetAt = 0;

  constructor(deps: ContextBuilderDeps, db: Database.Database, config?: Partial<AdvisorConfig>) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not set');
    }

    this.client = new Anthropic({ apiKey });
    this.store = new AdvisorStore(db);
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.deps = deps;

    log.info({ model: this.config.model, intervalMs: this.config.intervalMs }, 'Advisor initialized');
  }

  /**
   * Run a full evaluation cycle: build context → call LLM → parse → store → notify.
   */
  async evaluate(botState: BotState, vaultConfig: VaultConfig): Promise<AdvisorRecommendation[]> {
    // Rate limit: reset counter daily
    const now = Date.now();
    if (now - this.callCountResetAt > 86_400_000) {
      this.callsToday = 0;
      this.callCountResetAt = now;
    }

    if (this.callsToday >= this.config.maxCallsPerDay) {
      log.warn({ callsToday: this.callsToday }, 'Daily API call limit reached, skipping');
      return [];
    }

    try {
      // Build context
      const context = await buildAdvisorContext(this.deps, botState, vaultConfig);
      const contextText = contextToPromptText(context);
      const contextJson = JSON.stringify(context);

      log.debug({ contextLength: contextText.length }, 'Context built for advisor');

      // Call Claude API
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Analyze the following vault state and provide recommendations:\n\n${contextText}`,
          },
        ],
      });

      this.callsToday++;

      // Parse response
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      const recommendations = this.parseRecommendations(text);

      log.info(
        { count: recommendations.length, callsToday: this.callsToday },
        'Advisor evaluation complete',
      );

      // Store and notify
      for (const rec of recommendations) {
        this.store.save(rec, contextJson);

        if (this.config.notifyEnabled) {
          await this.notifyRecommendation(rec);
        }
      }

      return recommendations;
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Advisor evaluation failed');
      return [];
    }
  }

  private parseRecommendations(text: string): AdvisorRecommendation[] {
    try {
      // Extract JSON array from response (may be wrapped in markdown code fence)
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        if (text.includes('[]')) return [];
        log.warn({ text: text.slice(0, 200) }, 'No JSON array found in response');
        return [];
      }

      const parsed = JSON.parse(jsonMatch[0]) as Array<Record<string, unknown>>;
      const now = Date.now();

      return parsed.map((item) => ({
        timestamp: now,
        category: item['category'] as AdvisorRecommendation['category'],
        action: String(item['action'] ?? ''),
        reasoning: String(item['reasoning'] ?? ''),
        confidence: (item['confidence'] as AdvisorRecommendation['confidence']) ?? 'low',
        urgency: (item['urgency'] as AdvisorRecommendation['urgency']) ?? 'informational',
        currentRule: String(item['currentRule'] ?? ''),
        override: Boolean(item['override']),
      }));
    } catch (err) {
      log.error({ error: (err as Error).message, text: text.slice(0, 300) }, 'Failed to parse recommendations');
      return [];
    }
  }

  private async notifyRecommendation(rec: AdvisorRecommendation): Promise<void> {
    const icon = rec.override ? '\u{1F534}' : '\u{1F7E2}';
    const urgencyIcon = rec.urgency === 'immediate' ? '\u26A1' : rec.urgency === 'next_cycle' ? '\u23F0' : '\u{1F4CB}';

    const msg = [
      `${icon} *AI Advisor* ${urgencyIcon}`,
      `*${rec.category}* (${rec.confidence} confidence)`,
      `Action: ${rec.action}`,
      `Reasoning: ${rec.reasoning}`,
      rec.override ? `\u26A0\uFE0F Override: Rule says "${rec.currentRule}"` : '',
    ]
      .filter(Boolean)
      .join('\n');

    await sendAlert(msg, rec.urgency === 'immediate' ? 'warning' : 'info');
  }

  /** Get the store for external queries (API, etc.) */
  getStore(): AdvisorStore {
    return this.store;
  }

  /** Get the advisor config */
  getConfig(): AdvisorConfig {
    return this.config;
  }
}
