-- Stage 7: business accounts, staff roles, catalogue, orders, bookings, the admin
-- dashboard (platform staff, moderation queue, suspensions) and the integration catalogue.
-- Money is stored in minor units (cents) with an ISO 4217 currency per business.
-- No payment happens here: orders are paid in person until Stage 8 adds a provider.

-- ------------------------------------------------------------------ accounts and sessions

-- Suspended by platform staff: cannot sign in, and their content is hidden like a
-- deactivated account's. Only staff can lift it.
ALTER TABLE users DROP CONSTRAINT users_state_check;
ALTER TABLE users ADD CONSTRAINT users_state_check CHECK (state IN ('active', 'deactivated', 'suspended', 'deleted'));
ALTER TABLE users
  ADD COLUMN suspended_at timestamptz,
  ADD COLUMN suspension_reason text;

-- Set when the session was opened with a two-step code. Admin access needs it.
ALTER TABLE sessions ADD COLUMN mfa_verified_at timestamptz;

-- ------------------------------------------------------------------ platform staff

-- People who run the platform. 'moderator' works the report queue; 'admin' also manages
-- businesses, integrations, moderators and reads the audit log. Admins are granted
-- from the command line only (see docs/admin.md).
CREATE TABLE platform_staff (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('moderator', 'admin')),
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE reports
  ADD COLUMN assigned_to     uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN resolved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN resolved_at     timestamptz,
  ADD COLUMN resolution_note text NOT NULL DEFAULT '',
  -- What was done about it, e.g. {content_removed, user_suspended}.
  ADD COLUMN actions         text[] NOT NULL DEFAULT '{}';
CREATE INDEX reports_subject ON reports (subject_type, subject_id);
CREATE INDEX reports_queue ON reports (status, created_at);

-- ------------------------------------------------------------------ businesses

CREATE TABLE businesses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle         text NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9][a-z0-9_-]{2,39}$'),
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description    text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  category       text NOT NULL CHECK (category IN ('food', 'retail', 'beauty', 'health', 'services', 'education', 'entertainment', 'other')),
  contact_email  text CHECK (contact_email IS NULL OR char_length(contact_email) <= 254),
  phone          text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{6,14}$'),
  address        text NOT NULL DEFAULT '' CHECK (char_length(address) <= 300),
  time_zone      text NOT NULL,
  currency       text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  orders_enabled   boolean NOT NULL DEFAULT false,
  bookings_enabled boolean NOT NULL DEFAULT false,
  -- 'suspended' is set by platform staff; the business is hidden from customers.
  state          text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suspended', 'deleted')),
  suspension_reason text,
  verified_at    timestamptz,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX businesses_search ON businesses USING gin (to_tsvector('simple', name || ' ' || handle)) WHERE state = 'active';

-- Staff roles: owner (one), manager, staff. Someone added by a manager is 'invited'
-- until they accept, so nobody is put on a business's staff list without agreeing.
CREATE TABLE business_staff (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'manager', 'staff')),
  state       text NOT NULL CHECK (state IN ('invited', 'active')),
  invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  PRIMARY KEY (business_id, user_id),
  CHECK (role <> 'owner' OR state = 'active')
);
CREATE UNIQUE INDEX business_one_owner ON business_staff (business_id) WHERE role = 'owner';
CREATE INDEX business_staff_user ON business_staff (user_id);

-- Opening hours per weekday (0 = Sunday) in the business's time zone. Several rows per
-- day allow a lunch break. Closing at 00:00 is not allowed; use 23:59.
CREATE TABLE business_hours (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens       time NOT NULL,
  closes      time NOT NULL,
  CHECK (closes > opens),
  PRIMARY KEY (business_id, weekday, opens)
);

-- ------------------------------------------------------------------ catalogue and orders

CREATE TABLE catalogue_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description  text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  price_minor  bigint NOT NULL CHECK (price_minor BETWEEN 0 AND 100000000),
  available    boolean NOT NULL DEFAULT true,
  -- NULL means not tracked. Orders take stock atomically and give it back on cancel.
  stock        integer CHECK (stock IS NULL OR stock >= 0),
  position     integer NOT NULL DEFAULT 0,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX catalogue_items_business ON catalogue_items (business_id, position, created_at) WHERE archived_at IS NULL;

CREATE TABLE orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- NULL once the customer deletes their account; the business keeps its record.
  customer_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  client_id     text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  status        text NOT NULL DEFAULT 'placed'
                CHECK (status IN ('placed', 'accepted', 'ready', 'completed', 'cancelled', 'rejected')),
  fulfilment    text NOT NULL DEFAULT 'pickup' CHECK (fulfilment IN ('pickup')),
  -- Stage 8 adds online payment. Until then everything is paid at pickup.
  payment       text NOT NULL DEFAULT 'pay_in_person' CHECK (payment IN ('pay_in_person')),
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  total_minor   bigint NOT NULL CHECK (total_minor >= 0),
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status_reason text NOT NULL DEFAULT '' CHECK (char_length(status_reason) <= 300),
  created_at    timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at    timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  UNIQUE (customer_id, client_id)
);
CREATE INDEX orders_business ON orders (business_id, created_at DESC, id DESC);
CREATE INDEX orders_customer ON orders (customer_id, created_at DESC, id DESC);

-- Name and price are copied at order time, so later catalogue edits don't rewrite history.
CREATE TABLE order_items (
  order_id         uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  position         smallint NOT NULL CHECK (position BETWEEN 0 AND 49),
  item_id          uuid REFERENCES catalogue_items(id) ON DELETE SET NULL,
  name             text NOT NULL,
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  quantity         integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  PRIMARY KEY (order_id, position)
);

-- ------------------------------------------------------------------ bookings

CREATE TABLE booking_services (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description      text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  price_minor      bigint NOT NULL DEFAULT 0 CHECK (price_minor BETWEEN 0 AND 100000000),
  -- How many people can be booked into the same time.
  capacity         integer NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 100),
  active           boolean NOT NULL DEFAULT true,
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);
CREATE INDEX booking_services_business ON booking_services (business_id) WHERE archived_at IS NULL;

CREATE TABLE bookings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_id   uuid NOT NULL REFERENCES booking_services(id) ON DELETE CASCADE,
  customer_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  client_id    text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show')),
  cancelled_by text CHECK (cancelled_by IN ('customer', 'business')),
  note         text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  created_at   timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  UNIQUE (customer_id, client_id)
);
CREATE INDEX bookings_service_time ON bookings (service_id, starts_at) WHERE status = 'confirmed';
CREATE INDEX bookings_business_time ON bookings (business_id, starts_at);
CREATE INDEX bookings_customer ON bookings (customer_id, starts_at DESC);

-- ------------------------------------------------------------------ integration catalogue
-- Phase 1 of mini-apps (ADR 0006): a curated list of reviewed partner integrations.
-- No partner code runs in the app. People grant each integration named scopes, can
-- revoke them, and platform admins can switch an integration off (the kill switch).

CREATE TABLE integrations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{2,39}$'),
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description    text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  category       text NOT NULL CHECK (category IN ('food', 'bookings', 'tickets', 'travel', 'shopping', 'utilities', 'other')),
  developer_name text NOT NULL CHECK (char_length(developer_name) BETWEEN 1 AND 120),
  developer_contact text NOT NULL CHECK (char_length(developer_contact) BETWEEN 3 AND 254),
  homepage_url   text NOT NULL CHECK (homepage_url ~ '^https://'),
  scopes         text[] NOT NULL DEFAULT '{}',
  version        text NOT NULL DEFAULT '1.0.0' CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  -- draft: being reviewed; live: in the catalogue; disabled: switched off (kill switch).
  state          text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'live', 'disabled')),
  disabled_reason text,
  reviewed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at    timestamptz,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (scopes <@ ARRAY['profile.basic', 'email', 'orders.read', 'bookings.read', 'notifications.send']::text[])
);

CREATE TABLE integration_grants (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  scopes         text[] NOT NULL,
  granted_at     timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  PRIMARY KEY (user_id, integration_id)
);
CREATE INDEX integration_grants_integration ON integration_grants (integration_id);
