# ADR 0005: Payments boundary

**Status:** accepted for Stripe (Stage 8). Built and tested against a local stand-in for Stripe; not yet run against a real account. Details in [`payments.md`](../payments.md).

## Decision
- Payments go only through **licensed providers** (for example Stripe, Adyen, or regional providers) using their hosted or tokenised flows. **No raw card data ever touches our servers**, which keeps the PCI DSS scope at SAQ A.
- **No stored-value wallet, customer balances or peer-to-peer transfers** until a jurisdiction-by-jurisdiction review of licensing, safeguarding and AML/KYC has been done. The wallet screen will show provider-held payment methods and transaction history only.
- Every payment request carries an **idempotency key**. Webhooks are accepted only after **signature verification** and are deduplicated by event id. An internal **double-entry ledger** records every state change and is reconciled against provider reports.
- **Sandbox and live** credentials are kept fully apart, per environment. Production refuses sandbox keys and the reverse.
- In-app purchases of digital goods on iOS and Android must follow store billing rules. This affects how premium subscriptions are sold.

## How Stage 8 applies it
- **Stripe Connect Express with destination charges.** The business is the seller and is paid out by Stripe; Nexa takes an application fee and never holds the money. Card details go only to Stripe Checkout.
- **Idempotency keys** come from our own row ids. Provider calls never happen inside a database transaction.
- **Webhooks** are checked with `Stripe-Signature` (with a tolerance window and secret rotation), checked for live or test mode, deduplicated in `payment_events`, and applied in the same transaction as that record.
- **The ledger** is double-entry. The database refuses unbalanced transactions and any change to past entries.
- **Live and test keys:** production needs a live key, and a live key is refused everywhere else. Payout accounts made in the other mode can't take payments.
- **Plans are for businesses only**, so store billing rules don't apply yet. Anything sold to individuals inside the mobile apps needs store billing first.
- Razorpay or another regional provider would be a second implementation of the same boundary.

## Blocked on
A Stripe account with Connect approval, the target launch countries, and legal review. Razorpay, if it is chosen, needs its own account.
