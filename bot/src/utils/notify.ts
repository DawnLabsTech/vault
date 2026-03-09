import { createChildLogger } from './logger.js';

const log = createChildLogger('notify');

/** Rate limiter state */
const RATE_LIMIT_MAX = 20; // max messages per minute
const RATE_LIMIT_WINDOW_MS = 60_000;
const sendTimestamps: number[] = [];
const messageQueue: Array<{ text: string; resolve: () => void }> = [];
let queueProcessing = false;
let credentialWarningLogged = false;

/**
 * Check if Telegram credentials are configured.
 * Logs a warning only once if not configured.
 */
function getTelegramCredentials(): { token: string; chatId: string } | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    if (!credentialWarningLogged) {
      log.warn('Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing). Notifications disabled.');
      credentialWarningLogged = true;
    }
    return null;
  }

  return { token, chatId };
}

/**
 * Prune old timestamps from the rate limiter window.
 */
function pruneTimestamps(): void {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  while (sendTimestamps.length > 0 && sendTimestamps[0]! < cutoff) {
    sendTimestamps.shift();
  }
}

/**
 * Check if we can send a message right now (within rate limit).
 */
function canSendNow(): boolean {
  pruneTimestamps();
  return sendTimestamps.length < RATE_LIMIT_MAX;
}

/**
 * Get the delay until the next send slot opens up.
 */
function getNextSlotDelay(): number {
  pruneTimestamps();
  if (sendTimestamps.length < RATE_LIMIT_MAX) return 0;
  // Wait until the oldest timestamp in the window expires
  return sendTimestamps[0]! + RATE_LIMIT_WINDOW_MS - Date.now() + 50; // 50ms buffer
}

/**
 * Low-level send function that actually calls the Telegram API.
 */
async function sendRawTelegram(text: string): Promise<void> {
  const creds = getTelegramCredentials();
  if (!creds) return;

  const url = `https://api.telegram.org/bot${creds.token}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: creds.chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => 'unknown');
    throw new Error(`Telegram API error: HTTP ${resp.status} - ${body}`);
  }

  sendTimestamps.push(Date.now());
}

/**
 * Process the message queue, respecting rate limits.
 */
async function processQueue(): Promise<void> {
  if (queueProcessing) return;
  queueProcessing = true;

  try {
    while (messageQueue.length > 0) {
      if (!canSendNow()) {
        const delay = getNextSlotDelay();
        log.debug({ delay, queueSize: messageQueue.length }, 'Rate limited, waiting');
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      const item = messageQueue.shift();
      if (!item) break;

      try {
        await sendRawTelegram(item.text);
        item.resolve();
      } catch (err) {
        log.error({ err }, 'Failed to send queued Telegram message');
        item.resolve(); // resolve anyway to avoid hanging
      }
    }
  } finally {
    queueProcessing = false;
  }
}

/**
 * Enqueue a message, sending immediately if within rate limits.
 */
function enqueueMessage(text: string): Promise<void> {
  return new Promise<void>((resolve) => {
    messageQueue.push({ text, resolve });
    processQueue();
  });
}

/**
 * Send a Telegram message directly (used for backwards compatibility).
 * Respects rate limits and queues excess messages.
 */
export async function sendTelegramMessage(message: string): Promise<void> {
  const creds = getTelegramCredentials();
  if (!creds) return;

  try {
    await enqueueMessage(message);
  } catch (err) {
    log.error({ err }, 'Telegram notification error');
  }
}

/**
 * Send an alert notification with severity level.
 *
 * @param message - Alert message text
 * @param level - Severity: 'info', 'warning', or 'critical'
 */
export async function sendAlert(
  message: string,
  level: 'info' | 'warning' | 'critical' = 'info',
): Promise<void> {
  const emoji = level === 'critical' ? '\u{1F6A8}' : level === 'warning' ? '\u26A0\uFE0F' : '\u2139\uFE0F';
  const formatted = `${emoji} *Vault Bot:* ${message}`;

  // Also log locally
  const logMethod = level === 'critical' ? 'error' : level === 'warning' ? 'warn' : 'info';
  log[logMethod]({ level }, message);

  await sendTelegramMessage(formatted);
}

/**
 * Send a formatted daily PnL report via Telegram.
 * Uses a clean multi-line format suitable for the chat.
 */
export async function sendDailyReport(report: string): Promise<void> {
  const header = '\u{1F4CA} *Vault Bot - Daily Report*';
  const separator = '\u2500'.repeat(24);
  const formatted = `${header}\n${separator}\n\n${report}`;

  log.info('Sending daily report');
  await sendTelegramMessage(formatted);
}
