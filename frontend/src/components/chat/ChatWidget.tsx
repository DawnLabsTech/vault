'use client';

import { useState, useRef, useEffect } from 'react';
import { useChat } from '@/hooks/useChat';
import type { ChatMessage as ChatMessageType } from '@/types/chat';

function ChatMessage({ msg }: { msg: ChatMessageType }) {
  const isUser = msg.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-2`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words ${
          isUser
            ? 'bg-vault-accent/20 text-vault-text'
            : 'bg-vault-card border border-vault-border text-vault-text'
        }`}
      >
        {msg.content}
        {msg.isStreaming && !msg.content && (
          <span className="inline-flex gap-0.5">
            <span className="w-1.5 h-1.5 rounded-full bg-vault-muted animate-pulse" />
            <span className="w-1.5 h-1.5 rounded-full bg-vault-muted animate-pulse [animation-delay:150ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-vault-muted animate-pulse [animation-delay:300ms]" />
          </span>
        )}
        {msg.isStreaming && msg.content && (
          <span className="inline-block w-1.5 h-3.5 bg-vault-accent/60 animate-pulse ml-0.5 align-text-bottom" />
        )}
      </div>
    </div>
  );
}

export function ChatWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState('');
  const { messages, isStreaming, sendMessage, clearMessages } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    setInput('');
    sendMessage(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current) {
      e.preventDefault();
      handleSend();
    }
  };

  // Collapsed state — floating button
  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 z-50 w-12 h-12 rounded-full bg-vault-accent text-black flex items-center justify-center shadow-lg hover:bg-vault-accent/80 transition-colors"
        title="Chat with Vault AI"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>
    );
  }

  // Open state — chat panel
  return (
    <div className="fixed bottom-6 right-6 z-50 w-[400px] max-w-[calc(100vw-2rem)] h-[60vh] max-h-[600px] flex flex-col bg-vault-bg border border-vault-border rounded-lg shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-vault-border shrink-0">
        <h3 className="text-vault-accent text-xs font-bold uppercase tracking-wider">
          Vault AI Chat
        </h3>
        <div className="flex gap-1">
          <button
            onClick={clearMessages}
            className="text-vault-muted hover:text-vault-text text-xs px-1.5 py-0.5 rounded hover:bg-vault-border/30 transition-colors"
            title="Clear chat"
          >
            Clear
          </button>
          <button
            onClick={() => setIsOpen(false)}
            className="text-vault-muted hover:text-vault-text text-lg leading-none px-1"
            title="Close"
          >
            &times;
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-3 space-y-1"
      >
        {messages.length === 0 && (
          <div className="text-vault-muted text-xs text-center mt-8">
            <p className="mb-2">Vault AI Assistant</p>
            <p className="text-[10px]">Ask about positions, risk, performance, or run &ldquo;what if&rdquo; backtests</p>
          </div>
        )}
        {messages.map((msg) => (
          <ChatMessage key={msg.id} msg={msg} />
        ))}
      </div>

      {/* Input */}
      <div className="border-t border-vault-border p-2 shrink-0">
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => { isComposingRef.current = true; }}
            onCompositionEnd={() => { isComposingRef.current = false; }}
            placeholder="Ask about your vault..."
            disabled={isStreaming}
            rows={1}
            className="flex-1 bg-vault-card border border-vault-border rounded px-2 py-1.5 text-sm text-vault-text placeholder-vault-muted resize-none focus:outline-none focus:border-vault-accent/50 disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={isStreaming || !input.trim()}
            className="px-3 py-1.5 bg-vault-accent text-black text-sm font-medium rounded hover:bg-vault-accent/80 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
