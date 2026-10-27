import { StripeSandbox } from './stripe-sandbox';

/**
 * Runs the Stripe stand-in for local development and the browser tests:
 *   STRIPE_SECRET_KEY=sk_test_local STRIPE_WEBHOOK_SECRET=whsec_local \
 *   STRIPE_SANDBOX_WEBHOOK_URL=http://localhost:3000/v1/payments/webhooks/stripe \
 *   pnpm --filter @nexa/api stripe-sandbox
 * Then start the API with PAYMENTS_PROVIDER=stripe, the same key and secret, and
 * STRIPE_API_BASE=http://127.0.0.1:12111.
 */
async function main() {
  if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') throw new Error('The Stripe sandbox is for local development only');
  const secretKey = process.env.STRIPE_SECRET_KEY ?? 'sk_test_local';
  const webhookSecret = (process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_local').split(',')[0]!.trim();
  const sandbox = new StripeSandbox({
    secretKey,
    webhookSecret,
    webhookUrl: process.env.STRIPE_SANDBOX_WEBHOOK_URL ?? 'http://127.0.0.1:3000/v1/payments/webhooks/stripe',
    port: Number(process.env.STRIPE_SANDBOX_PORT ?? 12111),
  });
  const url = await sandbox.start();
  console.log(`Stripe sandbox on ${url}; webhooks to ${sandbox.webhookUrl}`);
  const stop = () => sandbox.stop().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
