import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { buildAdvisorContext, contextToPromptText, type ContextBuilderDeps } from '../advisor/context-builder.js';
import type { AdvisorStore } from '../advisor/store.js';
import type { VaultConfig } from '../types.js';
import { getStateJson } from '../measurement/state-store.js';
import { getConfig } from '../config.js';
import { ChatStore } from './store.js';
import { CHAT_SYSTEM_PROMPT } from './prompt.js';
import { CHAT_TOOLS } from './tools.js';
import type { ChatConfig, ChatMessage } from './types.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('chat');

const DEFAULT_CONFIG: ChatConfig = {
  model: 'claude-haiku-4-5-20251001',
  maxTokens: 2048,
  maxMessagesPerHour: 30,
  maxHistoryMessages: 10,
};

export interface ChatServiceDeps extends ContextBuilderDeps {
  advisorStore: AdvisorStore | null;
}

export type BacktestRunner = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

export class ChatService {
  private client: Anthropic;
  private store: ChatStore;
  private config: ChatConfig;
  private deps: ChatServiceDeps;
  private backtestRunner: BacktestRunner | null = null;

  constructor(deps: ChatServiceDeps, db: Database.Database, config?: Partial<ChatConfig>) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not set');
    }

    this.client = new Anthropic({ apiKey });
    this.store = new ChatStore(db);
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.deps = deps;

    log.info({ model: this.config.model }, 'Chat service initialized');
  }

  setBacktestRunner(runner: BacktestRunner): void {
    this.backtestRunner = runner;
  }

  async *streamChat(message: string, sessionId: string = 'default'): AsyncGenerator<string> {
    // Rate limit
    const oneHourAgo = Date.now() - 3_600_000;
    const recentCount = this.store.countRecent(sessionId, oneHourAgo);
    if (recentCount >= this.config.maxMessagesPerHour) {
      yield 'Rate limit reached. Please wait before sending more messages.';
      return;
    }

    // Save user message
    const userMsg: ChatMessage = {
      id: randomUUID(),
      sessionId,
      role: 'user',
      content: message,
      timestamp: Date.now(),
    };
    this.store.save(userMsg);

    // Build context
    let contextText = '';
    try {
      const state = getStateJson<{ botState: string }>('orchestrator');
      const botState = (state?.botState ?? 'UNKNOWN') as any;
      const vaultConfig = getConfig() as VaultConfig;
      const ctx = await buildAdvisorContext(this.deps, botState, vaultConfig);
      contextText = contextToPromptText(ctx);
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Failed to build context for chat');
      contextText = '(Vault context unavailable)';
    }

    // Build message history
    const history = this.store.getHistory(sessionId, this.config.maxHistoryMessages);
    const messages: Anthropic.MessageParam[] = [];

    // Inject context as first user message
    if (history.length <= 1) {
      // First message in session — include context
      messages.push({
        role: 'user',
        content: `Current vault state:\n\n${contextText}\n\nUser question: ${message}`,
      });
    } else {
      // Multi-turn: include context at start, then history
      messages.push({
        role: 'user',
        content: `Current vault state:\n\n${contextText}`,
      });
      messages.push({
        role: 'assistant',
        content: 'Understood. I have the current vault state. How can I help?',
      });
      // Add history (skip the user message we just saved — it's in history.slice(-1))
      for (const msg of history.slice(0, -1)) {
        messages.push({ role: msg.role, content: msg.content });
      }
      messages.push({ role: 'user', content: message });
    }

    // Advisor history context
    let advisorContext = '';
    if (this.deps.advisorStore) {
      try {
        const recent = this.deps.advisorStore.getRecent(5);
        if (recent.length > 0) {
          advisorContext = '\n\nRecent AI Advisor recommendations:\n' +
            recent.map((r) =>
              `- [${r.category}] ${r.action} (${r.confidence} confidence, ${new Date(r.timestamp).toISOString()})`,
            ).join('\n');
        }
      } catch {
        // ignore
      }
    }

    const systemPrompt = CHAT_SYSTEM_PROMPT + advisorContext;

    // Stream response with tool-use loop
    let fullResponse = '';
    const metadata: ChatMessage['metadata'] = {};

    try {
      yield* this.runConversation(systemPrompt, messages, metadata, sessionId);
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Chat stream error');
      yield '\n\n[Error generating response]';
    }
  }

  private async *runConversation(
    systemPrompt: string,
    messages: Anthropic.MessageParam[],
    metadata: ChatMessage['metadata'],
    sessionId: string = 'default',
  ): AsyncGenerator<string> {
    let fullResponse = '';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const stream = this.client.messages.stream({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        system: systemPrompt,
        messages,
        tools: CHAT_TOOLS,
      });

      let currentToolUse: { id: string; name: string; input: string } | null = null;
      let stopReason: string | null = null;

      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            fullResponse += event.delta.text;
            yield event.delta.text;
          } else if (event.delta.type === 'input_json_delta') {
            if (currentToolUse) {
              currentToolUse.input += event.delta.partial_json;
            }
          }
        } else if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            currentToolUse = {
              id: event.content_block.id,
              name: event.content_block.name,
              input: '',
            };
          }
        } else if (event.type === 'message_delta') {
          stopReason = event.delta.stop_reason;
        }
      }

      // If the model stopped for tool_use, execute it and continue
      if (stopReason === 'tool_use' && currentToolUse) {
        const toolInput = currentToolUse.input
          ? (JSON.parse(currentToolUse.input) as Record<string, unknown>)
          : {};
        const toolResult = await this.executeTool(currentToolUse.name, toolInput, metadata);

        // Append assistant message with tool_use block + tool result
        messages.push({
          role: 'assistant',
          content: [
            ...(fullResponse ? [{ type: 'text' as const, text: fullResponse }] : []),
            {
              type: 'tool_use' as const,
              id: currentToolUse.id,
              name: currentToolUse.name,
              input: toolInput,
            },
          ],
        });
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: currentToolUse.id,
              content: JSON.stringify(toolResult),
            },
          ],
        });

        fullResponse = '';
        currentToolUse = null;
        // Continue the loop to get the model's response after tool execution
        continue;
      }

      // Normal end — save assistant message and break
      if (fullResponse) {
        const assistantMsg: ChatMessage = {
          id: randomUUID(),
          sessionId,
          role: 'assistant',
          content: fullResponse,
          timestamp: Date.now(),
          metadata: Object.keys(metadata ?? {}).length > 0 ? metadata : undefined,
        };
        // Extract sessionId from the user message we saved earlier
        // The store save here is best-effort
        try {
          this.store.save(assistantMsg);
        } catch {
          // ignore save errors for assistant messages
        }
      }

      break;
    }
  }

  private async executeTool(
    name: string,
    input: Record<string, unknown>,
    metadata: ChatMessage['metadata'],
  ): Promise<Record<string, unknown>> {
    if (!metadata!.toolsUsed) metadata!.toolsUsed = [];
    metadata!.toolsUsed.push(name);

    switch (name) {
      case 'run_backtest': {
        metadata!.backtestTriggered = true;
        if (!this.backtestRunner) {
          return { error: 'Backtest runner not available' };
        }
        try {
          return await this.backtestRunner(input);
        } catch (err) {
          log.error({ error: (err as Error).message }, 'Backtest execution failed');
          return { error: `Backtest failed: ${(err as Error).message}` };
        }
      }

      case 'get_advisor_history': {
        if (!this.deps.advisorStore) {
          return { recommendations: [], stats: null, enabled: false };
        }
        const limit = (input['limit'] as number) ?? 10;
        const category = input['category'] as string | undefined;
        const recs = category
          ? this.deps.advisorStore.getByCategory(category, limit)
          : this.deps.advisorStore.getRecent(limit);
        const weekAgo = Date.now() - 7 * 86_400_000;
        const stats = this.deps.advisorStore.getAccuracyStats(weekAgo);
        return { recommendations: recs, stats, enabled: true };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  }
}
