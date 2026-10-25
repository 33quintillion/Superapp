# ADR 0005: Payments boundary (planned for Stage 8)

**Status:** proposed

## Decision
- Payments go only through **licensed providers** (for example Stripe, Adyen, or regional providers) using their hosted or tokenised flows. **No raw card data ever touches our servers**, which keeps the PCI DSS scope at SAQ A.
- **No stored-value wallet, customer balances or peer-to-peer transfers** until a jurisdiction-by-jurisdiction review of licensing, safeguarding and AML/KYC has been done. The wallet screen will show provider-held payment methods and transaction history only.
- Every payment request carries an **idempotency key**. Webhooks are accepted only after **signature verification** and are deduplicated by event id. An internal **double-entry ledger** records every state change and is reconciled against provider reports.
- **Sandbox and live** credentials are kept fully apart, per environment. Production refuses sandbox keys and the reverse.
- In-app purchases of digital goods on iOS and Android must follow store billing rules. This affects how premium subscriptions are sold.

## Blocked on
Choice of provider and merchant account approval, the target launch countries, and legal review.
