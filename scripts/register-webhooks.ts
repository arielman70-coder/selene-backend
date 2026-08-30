/**
 * Registers (or re-points) the Shopify webhooks this backend serves.
 *
 *   npm run register-webhooks -- --base https://your-backend.up.railway.app
 *   npm run list-webhooks
 *
 * Idempotent: an existing subscription for a topic is deleted and recreated
 * when its address changed, and left alone when it didn't. Re-running after a
 * redeploy to a new URL is the intended workflow.
 */
import { env } from '../src/config/env';
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
} from '../src/services/shopify';

const TOPICS: Array<{ topic: string; path: string }> = [
  { topic: 'checkouts/create', path: '/webhooks/checkout-create' },
  { topic: 'checkouts/update', path: '/webhooks/checkout-update' },
  { topic: 'orders/create', path: '/webhooks/order-create' },
  { topic: 'orders/paid', path: '/webhooks/order-paid' },
  { topic: 'refunds/create', path: '/webhooks/order-refund' },
];

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const existing = await listWebhooks();

  if (process.argv.includes('--list')) {
    if (existing.length === 0) {
      console.log('No webhooks registered.');
      return;
    }
    for (const w of existing) console.log(`${w.id}\t${w.topic}\t${w.address}`);
    return;
  }

  const base = (arg('base') ?? process.env.WEBHOOK_BASE_URL ?? '').replace(/\/$/, '');

  if (!base) {
    console.error('Missing --base <url> (or WEBHOOK_BASE_URL).');
    process.exit(1);
  }

  if (!base.startsWith('https://')) {
    // Shopify silently refuses plain-http endpoints; catching it here beats
    // debugging why no webhook ever arrives.
    console.error('Webhook base URL must be https.');
    process.exit(1);
  }

  console.log(`Registering webhooks on ${env.SHOPIFY_STORE_DOMAIN} -> ${base}\n`);

  for (const { topic, path } of TOPICS) {
    const address = `${base}${path}`;
    const current = existing.filter((w) => w.topic === topic);

    const alreadyCorrect = current.some((w) => w.address === address);
    if (alreadyCorrect) {
      console.log(`= ${topic.padEnd(18)} already points at ${address}`);
      continue;
    }

    for (const stale of current) {
      await deleteWebhook(stale.id);
      console.log(`- ${topic.padEnd(18)} removed stale ${stale.address}`);
    }

    const created = await createWebhook(topic, address);
    console.log(`+ ${topic.padEnd(18)} -> ${address}  (id ${created.id})`);
  }

  console.log('\nDone. Verify the signing secret in Shopify matches SHOPIFY_WEBHOOK_SECRET.');
}

main().catch((err) => {
  console.error('Webhook registration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
