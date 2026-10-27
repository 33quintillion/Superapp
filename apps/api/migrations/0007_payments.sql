-- Stage 8: online payments for orders, refunds, business subscriptions, and a
-- double-entry ledger. Money moves only through a licensed provider (ADR 0005): the
-- customer pays the provider, which pays the business's own connected account. Nexa
-- never holds funds, and no card data reaches these tables.

-- ------------------------------------------------------------------ orders

ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending_payment', 'placed', 'accepted', 'ready', 'completed', 'cancelled', 'rejected'));
ALTER TABLE orders DROP CONSTRAINT orders_payment_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_check CHECK (payment IN ('pay_in_person', 'online'));
-- Online orders wait in pending_payment, holding their stock, until the provider confirms.
ALTER TABLE orders ADD CONSTRAINT orders_pending_is_online CHECK (status <> 'pending_payment' OR payment = 'online');

-- A business may stop taking payment at pickup once it can take payment online.
ALTER TABLE businesses ADD COLUMN in_person_payments boolean NOT NULL DEFAULT true;

-- ------------------------------------------------------------------ payout accounts

-- The business's own account at the provider (a Stripe Connect Express account). The
-- provider runs identity checks and pays out; we only keep what it tells us.
CREATE TABLE business_payment_accounts (
  business_id       uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  provider          text NOT NULL CHECK (provider IN ('stripe')),
  livemode          boolean NOT NULL,
  account_id        text NOT NULL UNIQUE,
  country           text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  charges_enabled   boolean NOT NULL DEFAULT false,
  payouts_enabled   boolean NOT NULL DEFAULT false,
  details_submitted boolean NOT NULL DEFAULT false,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ payments and refunds

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Kept as long as the payment is: financial records outlive the order's customer.
  order_id            uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  payer_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  provider            text NOT NULL CHECK (provider IN ('stripe')),
  livemode            boolean NOT NULL,
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  -- The platform's fee, taken by the provider out of the amount.
  fee_minor           bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0 AND fee_minor <= amount_minor),
  currency            text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  destination_account text NOT NULL,
  status              text NOT NULL DEFAULT 'requires_payment' CHECK (status IN ('requires_payment', 'succeeded', 'cancelled')),
  -- Refunds that are pending or done. A failed refund gives its amount back.
  refunded_minor      bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0 AND refunded_minor <= amount_minor),
  checkout_id         text UNIQUE,
  checkout_url        text,
  checkout_expires_at timestamptz,
  provider_payment_id text UNIQUE,
  succeeded_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'succeeded' OR provider_payment_id IS NOT NULL),
  CHECK (refunded_minor = 0 OR status = 'succeeded')
);
CREATE INDEX payments_business ON payments (business_id, created_at DESC);
CREATE INDEX payments_payer ON payments (payer_id, created_at DESC);
CREATE INDEX payments_open ON payments (created_at) WHERE status = 'requires_payment';

CREATE TABLE refunds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id         uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  amount_minor       bigint NOT NULL CHECK (amount_minor > 0),
  -- The share of the platform fee handed back with it.
  fee_refund_minor   bigint NOT NULL DEFAULT 0 CHECK (fee_refund_minor >= 0 AND fee_refund_minor <= amount_minor),
  reason             text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 300),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  -- 'auto' when a paid order was cancelled; 'provider' when made outside the app.
  origin             text NOT NULL CHECK (origin IN ('staff', 'auto', 'provider')),
  provider_refund_id text UNIQUE,
  requested_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Makes staff retries safe; auto refunds use a fixed key per order.
  client_id          text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9_:-]{8,80}$'),
  created_at         timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, client_id)
);
CREATE INDEX refunds_payment ON refunds (payment_id, created_at);
CREATE INDEX refunds_unsent ON refunds (created_at) WHERE status = 'pending' AND provider_refund_id IS NULL;

-- Every provider event is recorded once, by id, before it is acted on, so a redelivered
-- event does nothing. Only ids and types are kept: payloads carry personal data.
CREATE TABLE payment_events (
  provider    text NOT NULL,
  event_id    text NOT NULL,
  type        text NOT NULL,
  livemode    boolean NOT NULL,
  object_id   text,
  created_at  timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

-- ------------------------------------------------------------------ plans and subscriptions

-- Plans that businesses can subscribe to. Prices live at the provider and can't change;
-- a new price is a new plan.
CREATE TABLE plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name                text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description         text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  price_minor         bigint NOT NULL CHECK (price_minor BETWEEN 1 AND 100000000),
  currency            text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  interval            text NOT NULL CHECK (interval IN ('month', 'year')),
  entitlements        text[] NOT NULL CHECK (entitlements <@ ARRAY['staff.extra', 'catalogue.extra']::text[] AND cardinality(entitlements) > 0),
  state               text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'active', 'retired')),
  provider            text NOT NULL CHECK (provider IN ('stripe')),
  livemode            boolean NOT NULL,
  provider_product_id text NOT NULL,
  provider_price_id   text NOT NULL UNIQUE,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- The business as a customer of Nexa, for its subscription.
CREATE TABLE business_billing (
  business_id          uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  provider             text NOT NULL CHECK (provider IN ('stripe')),
  livemode             boolean NOT NULL,
  provider_customer_id text NOT NULL UNIQUE,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  plan_id                  uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  provider                 text NOT NULL CHECK (provider IN ('stripe')),
  provider_subscription_id text NOT NULL UNIQUE,
  status                   text NOT NULL CHECK (status IN ('incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'canceled')),
  cancel_at_period_end     boolean NOT NULL DEFAULT false,
  current_period_end       timestamptz,
  -- Time of the newest provider event applied; older events arriving late are ignored.
  provider_updated_at      timestamptz NOT NULL,
  created_by               uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subscriptions_one_live ON subscriptions (business_id) WHERE status <> 'canceled';

-- ------------------------------------------------------------------ ledger

-- Double-entry ledger of money the provider moved on our behalf. Each transaction's
-- entries sum to zero per currency (checked at commit), and rows can't be changed or
-- removed. Positive amounts are debits. Accounts:
--   external:customers          money from (or back to) customers' cards
--   business:<id>:sales         what a business earned, net of the platform fee
--   platform:fees               the platform's fee on sales
--   platform:subscriptions      subscription income
CREATE TABLE ledger_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('payment', 'refund', 'subscription_invoice')),
  -- The provider object this records (payment intent, refund, invoice). One transaction each.
  provider_ref    text NOT NULL,
  payment_id      uuid REFERENCES payments(id) ON DELETE RESTRICT,
  refund_id       uuid REFERENCES refunds(id) ON DELETE RESTRICT,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE RESTRICT,
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, provider_ref)
);

CREATE TABLE ledger_entries (
  id             bigserial PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  account        text NOT NULL CHECK (account ~ '^(external:customers|platform:fees|platform:subscriptions|business:[0-9a-f-]{36}:sales)$'),
  amount_minor   bigint NOT NULL CHECK (amount_minor <> 0)
);
CREATE INDEX ledger_entries_transaction ON ledger_entries (transaction_id);
CREATE INDEX ledger_entries_account ON ledger_entries (account);

CREATE FUNCTION ledger_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total bigint;
BEGIN
  SELECT coalesce(sum(amount_minor), 0) INTO total FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % does not balance (off by %)', NEW.transaction_id, total USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();

CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the ledger is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
