-- =====================================================================
-- 001_initial_schema.sql
-- Core tables for abandoned-cart recovery, cashback/tiers, and upsell.
--
-- RLS is enabled on every table with NO policies. The backend uses the
-- service role key, which bypasses RLS; anon/authenticated clients get
-- nothing directly and must go through /api/*. This is deliberate — the
-- frontend (Lovable) never talks to these tables.
-- =====================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "citext";     -- case-insensitive email

-- ---------------------------------------------------------------------
-- tier_config: cashback tiers. Seeded below, editable at runtime.
-- ---------------------------------------------------------------------
create table if not exists tier_config (
  tier          text primary key,
  display_name  text not null,
  min_spent     numeric(12,2) not null default 0,
  cashback_pct  numeric(5,4)  not null default 0.02,  -- 0.02 = 2%
  sort_order    int not null default 0,
  created_at    timestamptz not null default now()
);

insert into tier_config (tier, display_name, min_spent, cashback_pct, sort_order) values
  ('bronze',   'ברונזה', 0,     0.02, 1),
  ('silver',   'כסף',    1000,  0.03, 2),
  ('gold',     'זהב',    3000,  0.05, 3),
  ('platinum', 'פלטינה', 7500,  0.07, 4)
on conflict (tier) do nothing;

-- ---------------------------------------------------------------------
-- customers
-- ---------------------------------------------------------------------
create table if not exists customers (
  id                uuid primary key default gen_random_uuid(),
  shopify_id        bigint unique,
  email             citext unique,
  phone             text unique,              -- E.164, e.g. +9725XXXXXXXX
  first_name        text,
  last_name         text,

  tier              text not null default 'bronze' references tier_config(tier),
  total_spent       numeric(12,2) not null default 0,
  cashback_balance  numeric(12,2) not null default 0,
  cashback_earned   numeric(12,2) not null default 0,
  cashback_redeemed numeric(12,2) not null default 0,

  opted_in_whatsapp boolean not null default true,
  opted_in_email    boolean not null default true,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- A customer is only useful if we can reach them somehow.
  constraint customers_contactable check (email is not null or phone is not null),
  constraint customers_balance_non_negative check (cashback_balance >= 0)
);

create index if not exists customers_phone_idx on customers (phone);
create index if not exists customers_tier_idx  on customers (tier);

-- ---------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------
create table if not exists orders (
  id                  uuid primary key default gen_random_uuid(),
  shopify_order_id    bigint unique not null,
  shopify_order_name  text,
  customer_id         uuid references customers(id) on delete set null,
  email               citext,
  phone               text,

  subtotal            numeric(12,2) not null default 0,
  total               numeric(12,2) not null default 0,
  currency            text not null default 'ILS',
  financial_status    text,
  fulfillment_status  text,

  cashback_earned     numeric(12,2) not null default 0,
  cashback_reversed   numeric(12,2) not null default 0,

  line_items          jsonb not null default '[]'::jsonb,
  raw_payload         jsonb,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists orders_customer_idx   on orders (customer_id, created_at desc);
create index if not exists orders_email_idx      on orders (email);

-- ---------------------------------------------------------------------
-- abandoned_checkouts
-- ---------------------------------------------------------------------
create table if not exists abandoned_checkouts (
  id                    uuid primary key default gen_random_uuid(),
  shopify_checkout_id   text unique not null,      -- Shopify checkout token
  shopify_checkout_url  text,
  customer_id           uuid references customers(id) on delete set null,
  email                 citext,
  phone                 text,

  cart_items            jsonb not null default '[]'::jsonb,
  subtotal              numeric(12,2) not null default 0,
  currency              text not null default 'ILS',

  -- pending -> reminder_sent -> converted | expired
  status                text not null default 'pending'
                          check (status in ('pending','reminder_sent','converted','expired')),
  reminder_count        int not null default 0,
  last_reminder_at      timestamptz,
  whatsapp_sent_at      timestamptz,
  email_sent_at         timestamptz,

  coupon_code           text,
  coupon_expires_at     timestamptz,

  converted_at          timestamptz,
  raw_payload           jsonb,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- The abandoned-cart job's hot path: rows still in the reminder cycle.
-- Covers 'reminder_sent' too, since MAX_REMINDERS > 1 revisits those.
create index if not exists abandoned_pending_idx
  on abandoned_checkouts (status, created_at)
  where status in ('pending','reminder_sent');
create index if not exists abandoned_email_idx on abandoned_checkouts (email);
create index if not exists abandoned_phone_idx on abandoned_checkouts (phone);

-- ---------------------------------------------------------------------
-- cashback_transactions: append-only ledger. Never UPDATE a row here.
-- ---------------------------------------------------------------------
create table if not exists cashback_transactions (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references customers(id) on delete cascade,
  order_id      uuid references orders(id) on delete set null,
  type          text not null check (type in ('earn','redeem','reverse','adjust','expire')),
  amount        numeric(12,2) not null,     -- signed: earn > 0, redeem/reverse < 0
  balance_after numeric(12,2) not null,
  description   text,
  coupon_code   text,
  created_at    timestamptz not null default now()
);

create index if not exists cashback_tx_customer_idx
  on cashback_transactions (customer_id, created_at desc);

-- One 'earn' row per order, so a replayed webhook can never double-credit.
create unique index if not exists cashback_tx_one_earn_per_order
  on cashback_transactions (order_id)
  where type = 'earn' and order_id is not null;

-- ---------------------------------------------------------------------
-- dynamic_coupons: mirrors Shopify price rules / discount codes
-- ---------------------------------------------------------------------
create table if not exists dynamic_coupons (
  id                     uuid primary key default gen_random_uuid(),
  code                   text unique not null,
  shopify_price_rule_id  bigint,
  shopify_discount_id    bigint,

  type                   text not null
                           check (type in ('abandoned_cart','cashback_redeem','upsell','manual')),
  customer_id            uuid references customers(id) on delete set null,

  discount_type          text not null check (discount_type in ('percentage','fixed_amount')),
  discount_value         numeric(12,2) not null,

  max_uses               int not null default 1,
  used_count             int not null default 0,
  status                 text not null default 'active'
                           check (status in ('active','used','expired','revoked')),

  expires_at             timestamptz,
  used_at                timestamptz,
  created_at             timestamptz not null default now()
);

create index if not exists coupons_customer_active_idx
  on dynamic_coupons (customer_id, type, status);
create index if not exists coupons_expiry_idx
  on dynamic_coupons (status, expires_at)
  where status = 'active';

-- ---------------------------------------------------------------------
-- notification_log: every WhatsApp/email send attempt
-- ---------------------------------------------------------------------
create table if not exists notification_log (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid references customers(id) on delete set null,
  channel         text not null check (channel in ('whatsapp','email')),
  provider        text,                       -- green_api | twilio | resend | ses
  type            text not null,              -- abandoned_cart_reminder | upsell_offer | ...
  recipient       text not null,
  status          text not null check (status in ('sent','failed','skipped')),
  external_msg_id text,
  error_message   text,
  sent_at         timestamptz not null default now()
);

-- Backs the dedup lookup in the abandoned-cart job.
create index if not exists notification_dedup_idx
  on notification_log (type, recipient, sent_at desc);

-- ---------------------------------------------------------------------
-- upsell_offers: which product to pitch after which purchase
-- ---------------------------------------------------------------------
create table if not exists upsell_offers (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  -- empty array = matches any order (catch-all fallback offer)
  trigger_product_ids bigint[] not null default '{}',
  offer_product_id    bigint,
  offer_product_title text not null,
  offer_product_url   text not null,
  discount_pct        numeric(5,2) not null default 15,
  priority            int not null default 0,     -- higher wins
  active              boolean not null default true,
  created_at          timestamptz not null default now()
);

create index if not exists upsell_offers_active_idx
  on upsell_offers (active, priority desc);

-- ---------------------------------------------------------------------
-- upsell_queue: delayed sends, drained by the upsell-sender job
-- ---------------------------------------------------------------------
create table if not exists upsell_queue (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null unique references orders(id) on delete cascade,
  customer_id   uuid references customers(id) on delete cascade,
  phone         text,
  email         citext,
  line_items    jsonb not null default '[]'::jsonb,

  scheduled_for timestamptz not null,
  status        text not null default 'pending'
                  check (status in ('pending','sent','skipped','failed')),
  attempts      int not null default 0,
  error_message text,

  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);

create index if not exists upsell_queue_due_idx
  on upsell_queue (status, scheduled_for)
  where status = 'pending';

-- ---------------------------------------------------------------------
-- webhook_events: idempotency ledger for Shopify deliveries
-- ---------------------------------------------------------------------
create table if not exists webhook_events (
  id             uuid primary key default gen_random_uuid(),
  shopify_topic  text not null,
  shopify_id     text not null,
  processed      boolean not null default false,
  processed_at   timestamptz,
  error_message  text,
  received_at    timestamptz not null default now(),
  unique (shopify_topic, shopify_id)
);

create index if not exists webhook_events_unprocessed_idx
  on webhook_events (received_at)
  where processed = false;

-- ---------------------------------------------------------------------
-- api_rate_limits: fixed-window counters for /api/* (survives restarts
-- and works across multiple instances, unlike in-memory limiters)
-- ---------------------------------------------------------------------
create table if not exists api_rate_limits (
  bucket_key   text not null,
  window_start timestamptz not null,
  count        int not null default 0,
  primary key (bucket_key, window_start)
);

create index if not exists api_rate_limits_window_idx on api_rate_limits (window_start);

-- ---------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists customers_set_updated_at on customers;
create trigger customers_set_updated_at before update on customers
  for each row execute function set_updated_at();

drop trigger if exists orders_set_updated_at on orders;
create trigger orders_set_updated_at before update on orders
  for each row execute function set_updated_at();

drop trigger if exists abandoned_set_updated_at on abandoned_checkouts;
create trigger abandoned_set_updated_at before update on abandoned_checkouts
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- RLS: on everywhere, no policies. Service role bypasses; nobody else reads.
-- ---------------------------------------------------------------------
alter table tier_config           enable row level security;
alter table customers             enable row level security;
alter table orders                enable row level security;
alter table abandoned_checkouts   enable row level security;
alter table cashback_transactions enable row level security;
alter table dynamic_coupons       enable row level security;
alter table notification_log      enable row level security;
alter table upsell_offers         enable row level security;
alter table upsell_queue          enable row level security;
alter table webhook_events        enable row level security;
alter table api_rate_limits       enable row level security;
