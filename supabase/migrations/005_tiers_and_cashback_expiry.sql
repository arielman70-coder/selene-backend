-- =====================================================================
-- 005_tiers_and_cashback_expiry.sql
-- Two independent changes:
--   1. New tier ladder — bronze / silver / gold, platinum retired.
--   2. Cashback balances expire 12 months after the customer's last accrual.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tier ladder: bronze / silver / gold
-- ---------------------------------------------------------------------
-- UPDATE rather than another seeded INSERT: 001 already created these rows,
-- so `on conflict do nothing` would be a no-op and the old values would
-- quietly survive the migration.
update tier_config set min_spent = 0,    cashback_pct = 0.0500 where tier = 'bronze';
update tier_config set min_spent = 500,  cashback_pct = 0.0700 where tier = 'silver';
update tier_config set min_spent = 1500, cashback_pct = 0.1000 where tier = 'gold';

-- Retire platinum.
--
-- 001 still seeds the row and is deliberately left alone — it has already
-- been applied, and editing an applied migration desyncs every database that
-- ran the earlier version. The row is removed here instead, so a fresh
-- install and an existing one converge on the same three tiers.
--
-- Deleting it is not cosmetic. recalculateTier() reads the ladder out of this
-- table at runtime, so a surviving platinum row would keep promoting people
-- into a tier that `Tier` in src/db/schema.ts no longer admits — the API
-- would then hand the frontend a tier it cannot render.
--
-- Anyone standing on platinum moves to gold first, or customers.tier's
-- foreign key blocks the delete. This is the only demotion in the system and
-- it costs the customer nothing: platinum paid 7%, the new gold pays 10%.
update customers set tier = 'gold', updated_at = now() where tier = 'platinum';
delete from tier_config where tier = 'platinum';

-- Every threshold dropped, so customers whose lifetime spend already clears a
-- new threshold are sitting on a tier they have outgrown. recalculateTier()
-- only runs on a new order or a refund, so without this they would keep
-- earning at the old rate until they next bought something.
--
-- Promote-only, matching recalculateTier()'s rule that a tier never moves
-- down. Drop this statement before applying if you would rather the new
-- ladder apply to future orders only.
with earned as (
  select c.id,
         (select tc.tier
            from tier_config tc
           where c.total_spent >= tc.min_spent
           order by tc.min_spent desc
           limit 1) as new_tier
    from customers c
)
update customers c
set tier = e.new_tier
from earned e, tier_config cur, tier_config nxt
where c.id = e.id
  and e.new_tier is not null
  and cur.tier = c.tier
  and nxt.tier = e.new_tier
  and nxt.min_spent > cur.min_spent;

-- ---------------------------------------------------------------------
-- 2. Cashback expiry
-- ---------------------------------------------------------------------
alter table customers add column if not exists last_accrual_at timestamptz;

-- Backfill before anything can sweep. A null would read as "infinitely
-- stale" and wipe every existing balance on the first run, so nobody is
-- left null: newest 'earn' row if the customer has one, else their own
-- created_at.
update customers c
set last_accrual_at = coalesce(
  (select max(t.created_at)
     from cashback_transactions t
    where t.customer_id = c.id
      and t.type = 'earn'),
  c.created_at,
  now()
)
where c.last_accrual_at is null;

-- The sweep's hot path: only balances that still hold money can expire.
create index if not exists customers_accrual_expiry_idx
  on customers (last_accrual_at)
  where cashback_balance > 0;

-- ---------------------------------------------------------------------
-- increment_cashback: same as 002 plus the accrual stamp.
--
-- Dropped first, not just replaced: adding a defaulted parameter creates an
-- OVERLOAD rather than replacing the function, and PostgREST refuses to
-- resolve an ambiguous name (PGRST203) — every existing 3-arg caller would
-- start failing.
--
-- p_touch_accrual exists because two of the three call sites are not
-- accruals: redeem-cashback.ts calls this to hand money BACK after a failed
-- mint or ledger write. Restoring a balance the customer already owned
-- should not buy them another 12 months.
-- ---------------------------------------------------------------------
drop function if exists increment_cashback(uuid, numeric, numeric);

create or replace function increment_cashback(
  p_customer_id   uuid,
  p_earn_amount   numeric,
  p_total_amount  numeric,
  p_touch_accrual boolean default true
) returns customers as $$
declare
  updated_customer customers;
begin
  update customers set
    cashback_balance = cashback_balance + p_earn_amount,
    cashback_earned  = cashback_earned  + p_earn_amount,
    total_spent      = total_spent      + p_total_amount,
    last_accrual_at  = case when p_touch_accrual then now() else last_accrual_at end,
    updated_at       = now()
  where id = p_customer_id
  returning * into updated_customer;

  if not found then
    raise exception 'Customer % not found', p_customer_id;
  end if;

  return updated_customer;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------
-- expire_stale_cashback: zero balances that have gone p_months without an
-- accrual, and write the ledger row that explains where the money went.
--
-- The ledger type is 'expire' — the value the cashback_transactions CHECK
-- constraint in 001 already allows.
--
-- Row-at-a-time under FOR UPDATE SKIP LOCKED rather than one set-based
-- UPDATE, for the same reason claim_abandoned_checkouts does it: the amount
-- written to the ledger has to be the balance actually taken. Reading it in
-- one statement and zeroing it in another lets a concurrent redeem land in
-- between and the ledger row then lies about the amount. Holding the row
-- lock across both closes that. A row locked by an in-flight redeem is
-- skipped and picked up on the next hourly run.
--
-- `cashback_balance > 0` is also what stops a zeroed customer being swept
-- again every hour: last_accrual_at stays stale forever, so without it we
-- would write an endless stream of 0-amount 'expire' rows.
-- ---------------------------------------------------------------------
create or replace function expire_stale_cashback(p_months int default 12)
returns int as $$
declare
  v_row   record;
  v_count int := 0;
begin
  for v_row in
    select id, cashback_balance
      from customers
     where cashback_balance > 0
       and last_accrual_at is not null
       and last_accrual_at < now() - make_interval(months => p_months)
     order by id
       for update skip locked
  loop
    update customers
       set cashback_balance = 0,
           updated_at = now()
     where id = v_row.id;

    insert into cashback_transactions
      (customer_id, type, amount, balance_after, description)
    values
      (v_row.id, 'expire', -v_row.cashback_balance, 0,
       format('פקיעת קאשבק — %s חודשים ללא צבירה', p_months));

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$ language plpgsql;
