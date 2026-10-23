-- Docs: /docs/database/schema.md
-- Mizban core schema. Every tenant table carries restaurant_id and is protected by
-- row level security keyed on the transaction-local setting app.restaurant_id.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role    AS ENUM ('manager', 'floor', 'kitchen');
CREATE TYPE order_kind   AS ENUM ('dine_in', 'takeaway');
CREATE TYPE order_status AS ENUM ('open', 'paid', 'void');
CREATE TYPE item_status  AS ENUM ('new', 'preparing', 'ready', 'served', 'void');
CREATE TYPE station_kind AS ENUM ('kitchen', 'bar');
CREATE TYPE pay_method   AS ENUM ('cash', 'card', 'transfer');
CREATE TYPE discount_kind AS ENUM ('percent', 'amount');

CREATE TABLE restaurants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  slug            text NOT NULL UNIQUE,
  service_pct     integer NOT NULL DEFAULT 0 CHECK (service_pct BETWEEN 0 AND 30),
  vat_pct         integer NOT NULL DEFAULT 10 CHECK (vat_pct BETWEEN 0 AND 30),
  floor_discount_max_pct integer NOT NULL DEFAULT 10 CHECK (floor_discount_max_pct BETWEEN 0 AND 100),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id),
  name          text NOT NULL,
  address       text,
  order_seq     integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id)
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id),
  branch_id     uuid,                       -- NULL = all branches (owners)
  username      text NOT NULL UNIQUE,       -- globally unique: login happens before tenant is known
  display_name  text NOT NULL,
  role          user_role NOT NULL,
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id)
);
CREATE INDEX users_restaurant_idx ON users (restaurant_id);

CREATE TABLE dining_tables (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id),
  branch_id     uuid NOT NULL,
  label         text NOT NULL,
  zone          text NOT NULL,
  seats         integer NOT NULL CHECK (seats > 0),
  sort          integer NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id),
  UNIQUE (restaurant_id, id),
  UNIQUE (branch_id, label)
);

CREATE TABLE menu_categories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id),
  name          text NOT NULL,
  icon          text,
  sort          integer NOT NULL DEFAULT 0,
  UNIQUE (restaurant_id, id)
);

-- price is integer toman. Orders copy name+price, so edits never rewrite history.
CREATE TABLE menu_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id),
  category_id   uuid NOT NULL,
  name          text NOT NULL,
  description   text,
  price         integer NOT NULL CHECK (price >= 0),
  station       station_kind NOT NULL DEFAULT 'kitchen',
  prep_minutes  integer NOT NULL DEFAULT 10,
  available     boolean NOT NULL DEFAULT true,
  sort          integer NOT NULL DEFAULT 0,
  FOREIGN KEY (restaurant_id, category_id) REFERENCES menu_categories (restaurant_id, id),
  UNIQUE (restaurant_id, id)
);

CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id),
  branch_id       uuid NOT NULL,
  table_id        uuid,
  kind            order_kind NOT NULL,
  number          integer NOT NULL,              -- per-branch running ticket number
  status          order_status NOT NULL DEFAULT 'open',
  guests          integer NOT NULL DEFAULT 1 CHECK (guests > 0),
  opened_by       uuid NOT NULL REFERENCES users(id),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  bill_requested_at timestamptz,
  discount_kind   discount_kind,
  discount_value  integer NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
  discount_reason text,
  discount_by     uuid REFERENCES users(id),
  -- Totals frozen at settlement; NULL while open (computed live from items).
  paid_subtotal   integer,
  paid_discount   integer,
  paid_service    integer,
  paid_vat        integer,
  paid_total      integer,
  version         integer NOT NULL DEFAULT 1,    -- bumped on every change that affects the bill
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id),
  FOREIGN KEY (restaurant_id, table_id)  REFERENCES dining_tables (restaurant_id, id),
  UNIQUE (restaurant_id, id),
  CHECK ((kind = 'dine_in' AND table_id IS NOT NULL) OR (kind = 'takeaway' AND table_id IS NULL))
);
-- At most one open order per table: two waiters opening the same table race on this index.
CREATE UNIQUE INDEX orders_one_open_per_table ON orders (table_id) WHERE status = 'open' AND table_id IS NOT NULL;
CREATE INDEX orders_branch_open_idx ON orders (branch_id, status);
CREATE INDEX orders_branch_closed_idx ON orders (branch_id, closed_at) WHERE status = 'paid';

CREATE TABLE order_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id),
  order_id        uuid NOT NULL,
  menu_item_id    uuid NOT NULL,
  name            text NOT NULL,                 -- snapshot
  unit_price      integer NOT NULL CHECK (unit_price >= 0), -- snapshot
  station         station_kind NOT NULL,
  qty             integer NOT NULL CHECK (qty BETWEEN 1 AND 99),
  note            text,
  status          item_status NOT NULL DEFAULT 'new',
  version         integer NOT NULL DEFAULT 1,
  round           integer NOT NULL DEFAULT 1,    -- which "send to kitchen" this belongs to
  client_request_id uuid NOT NULL,               -- idempotency for a retried "send" (one id per batch)
  line_no         integer NOT NULL DEFAULT 0,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  status_at       timestamptz NOT NULL DEFAULT now(),
  ready_at        timestamptz,                   -- when the kitchen/bar marked it ready (prep-time metric)
  void_stage      item_status,                   -- status at the moment it was voided
  void_reason     text,
  voided_by       uuid REFERENCES users(id),
  FOREIGN KEY (restaurant_id, order_id) REFERENCES orders (restaurant_id, id),
  FOREIGN KEY (restaurant_id, menu_item_id) REFERENCES menu_items (restaurant_id, id),
  UNIQUE (order_id, client_request_id, line_no)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE INDEX order_items_live_idx ON order_items (restaurant_id, status) WHERE status IN ('new', 'preparing', 'ready');

CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id),
  order_id        uuid NOT NULL,
  method          pay_method NOT NULL,
  amount          integer NOT NULL CHECK (amount > 0),
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid NOT NULL,
  FOREIGN KEY (restaurant_id, order_id) REFERENCES orders (restaurant_id, id),
  UNIQUE (order_id, idempotency_key)
);
CREATE INDEX payments_order_idx ON payments (order_id);

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id),
  branch_id     uuid,
  actor_id      uuid REFERENCES users(id),
  action        text NOT NULL,                   -- e.g. discount.set, item.void, menu.price
  entity        text NOT NULL,
  entity_id     uuid,
  data          jsonb NOT NULL DEFAULT '{}',
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_restaurant_at_idx ON audit_log (restaurant_id, at DESC);

-- Cached AI briefs: one per branch/day/input hash.
CREATE TABLE day_briefs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id),
  branch_id     uuid NOT NULL,
  day           date NOT NULL,
  input_hash    text NOT NULL,
  source        text NOT NULL CHECK (source IN ('ai', 'template')),
  body          text NOT NULL,
  model         text,
  latency_ms    integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, day, input_hash)
);

-- ---------------------------------------------------------------------------
-- Row level security. The app connects as mizban_app (not owner, no BYPASSRLS).
-- With no tenant set, current_setting(..., true) is NULL and every policy is false: fail closed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.restaurant_id', true), '')::uuid $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['branches','users','dining_tables','menu_categories','menu_items',
                           'orders','order_items','payments','audit_log','day_briefs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (restaurant_id = app_tenant()) WITH CHECK (restaurant_id = app_tenant())', t);
  END LOOP;
END $$;

ALTER TABLE restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON restaurants USING (id = app_tenant()) WITH CHECK (id = app_tenant());

-- Login happens before a tenant is known. This is the only cross-tenant read, and it
-- returns a single user by exact username.
CREATE OR REPLACE FUNCTION auth_lookup(p_username text)
RETURNS TABLE (id uuid, restaurant_id uuid, role user_role, password_hash text, active boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.restaurant_id, u.role, u.password_hash, u.active FROM users u WHERE u.username = p_username
$$;
REVOKE ALL ON FUNCTION auth_lookup(text) FROM PUBLIC;
