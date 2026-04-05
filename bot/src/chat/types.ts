export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  metadata?: {
    backtestTriggered?: boolean;
    toolsUsed?: string[];
  };
}

export interface ChatRequest {
  message: string;
  sessionId?: string;
}

export interface ChatConfig {
  model: string;
  maxTokens: number;
  maxMessagesPerHour: number;
  maxMessagesPerDay: number;
  maxHistoryMessages: number;
}
