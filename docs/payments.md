# Payments, refunds and business plans

Stage 8. Customers can pay for pickup orders by card, businesses get paid out by the payment provider, staff can refund, and businesses can buy a plan that raises their limits. The boundary is ADR 0005: card details only ever go to the provider's hosted pages, and Nexa never holds anyone's money.

Everything here runs and is tested against a **local stand-in for Stripe** (`apps/api/src/dev/stripe-sandbox.ts`). Nothing has been run against a real Stripe account yet; see [What needs real accounts](#what-needs-real-accounts).

## How money moves
- **Provider:** Stripe, with Connect Express accounts for businesses. Razorpay or another regional provider would be a second `PaymentsProvider`; it isn't built.
- **Orders:** a destination charge. The customer pays on Stripe Checkout; Stripe sends the money to the business's own Stripe account (`transfer_data.destination`) and keeps Nexa's fee (`application_fee_amount`, `PAYMENTS_PLATFORM_FEE_BPS`, default 0). The business is the seller.
- **Plans:** Stripe Billing subscriptions on the platform account, bought through Checkout in subscription mode. Card changes and invoices are on Stripe's billing portal.
- Plans are sold to **businesses only**. Selling to individuals inside the iPhone or Android apps would have to go through store billing, which isn't built.

## Paying for an order
1. The owner sets up payouts: `POST /v1/businesses/:id/payments/account` makes a Connect account and returns Stripe's onboarding page. When Stripe says the account can take charges, customers see "Pay now, by card".
2. The customer places the order with `payment: "online"`. It starts as `pending_payment`: stock is held, but staff don't see it yet.
3. `POST /v1/orders/:id/checkout` returns the hosted page. A checkout lasts `PAYMENTS_CHECKOUT_MINUTES` (default 30). Asking again returns the same page while it is open.
4. Stripe calls the webhook with `checkout.session.completed`. The order becomes `placed`, staff are told, and the ledger records the sale.
5. If the checkout expires or the customer cancels, the order is cancelled and its stock is returned.

A business can turn off "Also take payment at pickup" once online payment works; then every order is paid online.

## Refunds
- Staff with `orders.refund` (owners and managers) refund all or part of a paid order: `POST /v1/orders/:id/refunds { clientId, amountMinor?, reason }`. The `clientId` makes a retry safe.
- Refunds reverse the transfer from the business and give back the matching share of Nexa's fee. The last refund takes whatever fee is left, so the amounts always add up.
- A paid order that is cancelled or declined, by staff, the customer, closing the business or deleting an account, is refunded in full automatically.
- Refunds made in the Stripe dashboard arrive by webhook and are recorded the same way.

## Webhooks
`POST /v1/payments/webhooks/stripe`, with no session. In order:
1. The `Stripe-Signature` header is checked: HMAC-SHA256 over `timestamp.body` with each secret in `STRIPE_WEBHOOK_SECRET` (comma-separated, for rotation), timestamp within `STRIPE_WEBHOOK_TOLERANCE_SECONDS` (default 300). Anything else is 400 `invalid_signature`.
2. An event from the other mode (live against a test key, or the reverse) is 400 `livemode_mismatch`.
3. The event id goes in `payment_events`. A repeat gets 200 `{ duplicate: true }` and changes nothing. The event is applied in the same transaction as that record, so a crash part-way means Stripe's retry applies it again from the start.
4. Work that talks to Stripe or sends notifications runs after the commit.

Handled: `checkout.session.completed`, `.async_payment_succeeded`, `.expired`, `.async_payment_failed`; `refund.created`, `.updated`, `.failed`; `account.updated`; `customer.subscription.created`, `.updated`, `.deleted`; `invoice.paid`.

## Idempotency
- Every POST to Stripe carries an `Idempotency-Key` made from our own row ids (`checkout:<payment>:<expiry>`, `refund:<refund>`, `subscribe:<business>:<clientId>` …), so a retry after a timeout can't charge or refund twice.
- We never call Stripe inside a database transaction. Stripe can call the webhook before it answers us, so rows are written first and the provider is called after.
- A sweep every `PAYMENTS_SWEEP_INTERVAL_SECONDS` (default 60) is the backstop for lost webhooks. It asks Stripe about checkouts that should have ended, sends refunds that never reached Stripe, and settles orders that closed while Stripe was down.

## Ledger
Double-entry, in `ledger_transactions` and `ledger_entries`. Positive amounts are debits. Accounts:

| Account | Meaning |
| --- | --- |
| `external:customers` | Money from or back to customers |
| `business:<id>:sales` | What the business has been paid, net of fees and refunds |
| `platform:fees` | Nexa's fees |
| `platform:subscriptions` | Plan revenue |

The database enforces it. A deferred trigger refuses any transaction whose entries don't sum to zero per currency, and the tables are append-only. Each provider object is recorded once (`UNIQUE (kind, provider_ref)`). `GET /v1/admin/ledger` returns balances and a check that every succeeded payment and refund has matching entries.

## Plans and entitlements
- Admins create plans (`POST /v1/admin/plans`). This makes the Stripe product and price, which can't be changed afterwards; make a new plan instead. A plan starts as `draft` and is put on sale (`active`) or stopped (`retired`).
- Entitlements are `staff.extra` (staff limit 10 → 100) and `catalogue.extra` (catalogue limit 500 → 5,000).
- A plan's features stay on while the subscription is `trialing`, `active` or `past_due`. When it lapses, nothing is deleted; adding more is refused with 409 `staff_limit` or `catalogue_full`.
- A business has at most one live subscription. A second one that slips through, for example from two checkouts, is ended at Stripe straight away.
- Subscription events are applied only if they are at least as new as the last one applied, and `canceled` is final, so events that arrive out of order can't bring a plan back.
- Closing a business ends its subscription.

## Configuration
| Variable | Default | |
| --- | --- | --- |
| `PAYMENTS_PROVIDER` | `none` | `stripe` turns payments on |
| `STRIPE_SECRET_KEY` | | `sk_` or `rk_`. Production needs `sk_live_`/`rk_live_`; live keys are refused anywhere else |
| `STRIPE_WEBHOOK_SECRET` | | `whsec_…`, comma-separated while rotating |
| `STRIPE_API_BASE` | Stripe | Only for the local stand-in; refused in staging and production |
| `STRIPE_WEBHOOK_TOLERANCE_SECONDS` | 300 | |
| `PAYMENTS_PLATFORM_FEE_BPS` | 0 | Nexa's fee on orders, in basis points |
| `PAYMENTS_CHECKOUT_MINUTES` | 30 | |
| `PAYMENTS_SWEEP_INTERVAL_SECONDS` | 60 | 0 turns the sweep off |

## Running it locally
```sh
STRIPE_SECRET_KEY=sk_test_local STRIPE_WEBHOOK_SECRET=whsec_local \
STRIPE_SANDBOX_WEBHOOK_URL=http://localhost:3000/v1/payments/webhooks/stripe \
pnpm --filter @nexa/api stripe-sandbox
```
Then start the API with `PAYMENTS_PROVIDER=stripe STRIPE_SECRET_KEY=sk_test_local STRIPE_WEBHOOK_SECRET=whsec_local STRIPE_API_BASE=http://127.0.0.1:12111`. The stand-in serves its own checkout, onboarding and billing portal pages, signs its webhooks the way Stripe does, and refuses a reused idempotency key with different parameters. It does not imitate everything Stripe does: tax, 3-D Secure, disputes and payout timing aren't there.

With a real Stripe test account, leave out `STRIPE_API_BASE` and forward webhooks with `stripe listen --forward-to localhost:3000/v1/payments/webhooks/stripe`.

## What needs real accounts
- **Stripe test account, Connect platform profile and approval for Express accounts.** Then run the flows above against real Stripe in test mode and check the field names against API version `2025-03-31.basil`.
- **Live Stripe account**, the business's terms and the platform agreement, and the launch countries (Connect availability, currencies, tax).
- **Legal review:** marketplace or agent model, refund and cancellation terms, consumer law in the launch countries, and the privacy notice for payment data.
- **App store billing** if plans or anything digital is sold to individuals in the mobile apps.
- **Razorpay** (or another regional provider), if chosen, needs its own account and a second provider implementation.

## Not built yet
- Online payment for bookings, deposits and no-show fees.
- Disputes and chargebacks (`charge.dispute.*`). Today they show up only in the Stripe dashboard.
- Changing plan in place (upgrades and downgrades with proration). A business cancels and subscribes again.
- Payout reports and reconciliation against Stripe's balance transactions. The ledger check covers our own records only.
- The Flutter back office: payouts, refunds and plans are on the web only. The Flutter app can pay for an order.
