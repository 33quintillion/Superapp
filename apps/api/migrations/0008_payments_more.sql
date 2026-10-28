-- Stage 8 follow-up: deposits for bookings, disputes (chargebacks), changing plan in
-- place, and checking our records against the provider's balance. As before, money moves
-- only through the provider (ADR 0005) and no card data reaches these tables.

-- ------------------------------------------------------------------ booking deposits

-- A service can ask for part (or all) of its price up front. The deposit is kept if the
-- customer cancels late or doesn't come; it is refunded in full if they cancel by the
-- free-cancellation time or the business cancels.
ALTER TABLE booking_services ADD COLUMN deposit_minor bigint NOT NULL DEFAULT 0 CHECK (deposit_minor >= 0);
ALTER TABLE booking_services ADD CONSTRAINT booking_services_deposit_within_price CHECK (deposit_minor <= price_minor);
ALTER TABLE booking_services ADD COLUMN free_cancel_hours integer NOT NULL DEFAULT 24 CHECK (free_cancel_hours BETWEEN 0 AND 168);

-- A booking with a deposit holds its place in pending_payment until the provider confirms.
ALTER TABLE bookings DROP CONSTRAINT bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN ('pending_payment', 'confirmed', 'cancelled', 'completed', 'no_show'));
-- What was agreed when booking, so later changes to the service don't change it.
ALTER TABLE bookings ADD COLUMN price_minor bigint NOT NULL DEFAULT 0 CHECK (price_minor >= 0);
ALTER TABLE bookings ADD COLUMN deposit_minor bigint NOT NULL DEFAULT 0 CHECK (deposit_minor >= 0);
ALTER TABLE bookings ADD COLUMN free_cancel_until timestamptz;
-- Set when a paid deposit has to go back: the business cancelled, the customer cancelled
-- in time, or the payment arrived after the booking had closed. The payments sweep acts on it.
ALTER TABLE bookings ADD COLUMN refund_due boolean NOT NULL DEFAULT false;
ALTER TABLE bookings ADD CONSTRAINT bookings_pending_has_deposit CHECK (status <> 'pending_payment' OR deposit_minor > 0);
DROP INDEX bookings_service_time;
CREATE INDEX bookings_service_time ON bookings (service_id, starts_at) WHERE status IN ('pending_payment', 'confirmed');

-- A payment is for exactly one order or one booking.
ALTER TABLE payments ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE payments ADD COLUMN booking_id uuid UNIQUE REFERENCES bookings(id) ON DELETE RESTRICT;
ALTER TABLE payments ADD CONSTRAINT payments_one_subject CHECK (num_nonnulls(order_id, booking_id) = 1);

-- ------------------------------------------------------------------ disputes

-- A customer asked their bank to take a card payment back. The provider takes the money
-- from the platform while the bank decides; we take the business's share back from the
-- business (as with refunds) and return it if the business wins.
CREATE TABLE disputes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id            uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  provider_dispute_id   text NOT NULL UNIQUE,
  provider_charge_id    text NOT NULL,
  amount_minor          bigint NOT NULL CHECK (amount_minor > 0),
  -- The platform fee's share of the disputed amount, which the platform bears.
  fee_share_minor       bigint NOT NULL DEFAULT 0 CHECK (fee_share_minor >= 0 AND fee_share_minor <= amount_minor),
  currency              text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reason                text NOT NULL DEFAULT '',
  status                text NOT NULL CHECK (status IN ('warning_needs_response', 'warning_under_review', 'warning_closed', 'needs_response', 'under_review', 'won', 'lost')),
  evidence_due_by       timestamptz,
  evidence_submitted_at timestamptz,
  evidence_submitted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Set when the provider took the money, and when it gave it back.
  funds_withdrawn_at    timestamptz,
  funds_reinstated_at   timestamptz,
  -- Our calls that move the business's share: back from it, and to it again after a win.
  recovery_reversal_id  text,
  return_transfer_id    text,
  provider_updated_at   timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (funds_reinstated_at IS NULL OR funds_withdrawn_at IS NOT NULL)
);
CREATE INDEX disputes_payment ON disputes (payment_id);
CREATE INDEX disputes_open ON disputes (created_at) WHERE status IN ('warning_needs_response', 'needs_response');

-- How much of the payment the bank currently holds back. Not refundable meanwhile.
ALTER TABLE payments ADD COLUMN disputed_minor bigint NOT NULL DEFAULT 0 CHECK (disputed_minor >= 0);

ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check
  CHECK (kind IN ('payment', 'refund', 'subscription_invoice', 'dispute', 'dispute_reinstated'));
ALTER TABLE ledger_transactions ADD COLUMN dispute_id uuid REFERENCES disputes(id) ON DELETE RESTRICT;

-- ------------------------------------------------------------------ plan changes

-- Who changed the plan last, and when (the provider bills the difference).
ALTER TABLE subscriptions ADD COLUMN plan_changed_at timestamptz;
