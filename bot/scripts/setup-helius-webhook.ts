/**
 * Set up (or update) the Helius webhook used by the AnomalyMonitor.
 *
 * Idempotent: re-running picks up the existing webhook by URL and updates
 * its accountAddresses + auth instead of creating a duplicate.
 *
 * Required env:
 *   HELIUS_API_KEY        — main API key (also used by HELIUS_RPC_URL)
 *   HELIUS_WEBHOOK_AUTH   — secret value Helius will send in `Authorization`
 *   WEBHOOK_BASE_URL      — public URL of the bot's API server (e.g. https://vault.example.com)
 *
 * Usage:
 *   cd bot && npx tsx scripts/setup-helius-webhook.ts
 */
import dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(process.cwd(), '../.env') });
dotenv.config();

import { createDefaultHandlers } from '../src/risk/anomaly-monitor.js';

interface HeliusWebhook {
  webhookID: string;
  webhookURL: string;
  transactionTypes: string[];
  accountAddresses: string[];
  webhookType: string;
  authHeader?: string;
}

const HELIUS_API_BASE = 'https://api.helius.xyz/v0/webhooks';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

async function listWebhooks(apiKey: string): Promise<HeliusWebhook[]> {
  const res = await fetch(`${HELIUS_API_BASE}?api-key=${apiKey}`);
  if (!res.ok) {
    throw new Error(`Helius listWebhooks failed: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as HeliusWebhook[];
}

async function createWebhook(apiKey: string, body: object): Promise<HeliusWebhook> {
  const res = await fetch(`${HELIUS_API_BASE}?api-key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Helius createWebhook failed: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as HeliusWebhook;
}

async function updateWebhook(apiKey: string, id: string, body: object): Promise<HeliusWebhook> {
  const res = await fetch(`${HELIUS_API_BASE}/${id}?api-key=${apiKey}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Helius updateWebhook failed: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as HeliusWebhook;
}

async function main(): Promise<void> {
  const apiKey = requireEnv('HELIUS_API_KEY');
  const authHeader = requireEnv('HELIUS_WEBHOOK_AUTH');
  const baseUrl = requireEnv('WEBHOOK_BASE_URL').replace(/\/+$/, '');
  const webhookURL = `${baseUrl}/webhook/helius`;

  // Collect addresses from all default anomaly handlers
  const addresses = new Set<string>();
  for (const handler of createDefaultHandlers()) {
    for (const addr of handler.watchedAddresses()) addresses.add(addr);
  }
  const accountAddresses = [...addresses];

  if (accountAddresses.length === 0) {
    console.error('No watched addresses to register. Aborting.');
    process.exit(1);
  }

  console.log('Helius webhook config:');
  console.log(`  URL:       ${webhookURL}`);
  console.log(`  addresses: ${accountAddresses.join(', ')}`);

  const existing = await listWebhooks(apiKey);
  const match = existing.find((w) => w.webhookURL === webhookURL);

  const payload = {
    webhookURL,
    transactionTypes: ['Any'],
    accountAddresses,
    webhookType: 'enhanced',
    authHeader,
  };

  if (match) {
    console.log(`Updating existing webhook ${match.webhookID}`);
    const updated = await updateWebhook(apiKey, match.webhookID, payload);
    console.log(`Updated: ${updated.webhookID}`);
  } else {
    console.log('Creating new webhook');
    const created = await createWebhook(apiKey, payload);
    console.log(`Created: ${created.webhookID}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
