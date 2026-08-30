-- =====================================================================
-- 002_functions.sql
-- Atomic operations. Anything that touches a balance, claims a job, or
-- dedups a webhook lives here — doing it in TypeScript with read-then-
-- write leaves a race window on every call.
-- =====================================================================

-- Claim columns for the job runners (idempotent add).
alter table abandoned_checkouts add column if not exists claimed_at timestamptz;
alter table upsell_queue        add column if not exists claimed_at timestamptz;

-- ---------------------------------------------------------------------
-- increment_cashback: credit a customer and bump lifetime spend.
-- ---------------------------------------------------------------------
create or replace function increment_cashback(
  p_customer_id  uuid,
  p_earn_amount  numeric,
  p_total_amount numeric
) returns customers as $$
declare
  updated_customer customers;
begin
  update customers set
    cashback_balance = cashback_balance + p_earn_amount,
    cashback_earned  = cashback_earned  + p_earn_amount,
    total_spent      = total_spent      + p_total_amount,
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
-- decrement_cashback: debit on redemption.
-- The `cashback_balance >= p_amount` predicate is the whole safety story:
-- two concurrent redeems can't both pass it, so the balance cannot go
-- negative no matter how the API layer is called.
-- ---------------------------------------------------------------------
create or replace function decrement_cashback(
  p_customer_id uuid,
  p_amount      numeric
) returns numeric as $$
declare
  new_balance numeric;
begin
  if p_amount <= 0 then
    raise exception 'Redemption amount must be positive';
  end if;

  update customers set
    cashback_balance  = cashback_balance - p_amount,
    cashback_redeemed = cashback_redeemed + p_amount,
    updated_at        = now()
  where id = p_customer_id
    and cashback_balance >= p_amount
  returning cashback_balance into new_balance;

  if not found then
    raise exception 'Insufficient cashback balance';
  end if;

  return new_balance;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------
-- reverse_cashback: claw back credit when an order is refunded.
-- Balance floors at zero — the customer may already have spent it, and we
-- don't chase them into debt over a few shekels of cashback.
-- ---------------------------------------------------------------------
create or replace function reverse_cashback(
  p_customer_id uuid,
  p_amount      numeric,
  p_spend_amount numeric
) returns numeric as $$
declare
  new_balance numeric;
begin
  update customers set
    cashback_balance = greatest(0, cashback_balance - p_amount),
    cashback_earned  = greatest(0, cashback_earned  - p_amount),
    total_spent      = greatest(0, total_spent      - p_spend_amount),
    updated_at       = now()
  where id = p_customer_id
  returning cashback_balance into new_balance;

  if not found then
    raise exception 'Customer % not found', p_customer_id;
  end if;

  return new_balance;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------
-- claim_webhook_event: returns true if the caller should process this
-- delivery, false if it's a duplicate.
--
-- Three cases:
--   * row inserted now            -> first delivery, process it
--   * row exists, processed       -> duplicate, skip
--   * row exists, unprocessed and older than p_stale_seconds
--                                 -> a previous attempt died, retry it
--   * row exists, unprocessed and recent
--                                 -> another worker has it in flight, skip
-- ---------------------------------------------------------------------
create or replace function claim_webhook_event(
  p_topic         text,
  p_id            text,
  p_stale_seconds int default 300
) returns boolean as $$
declare
  v_rows       int := 0;
  v_processed  boolean;
  v_received   timestamptz;
begin
  insert into webhook_events (shopify_topic, shopify_id)
  values (p_topic, p_id)
  on conflict (shopify_topic, shopify_id) do nothing;

  get diagnostics v_rows = row_count;
  if v_rows > 0 then
    return true;
  end if;

  select processed, received_at into v_processed, v_received
  from webhook_events
  where shopify_topic = p_topic and shopify_id = p_id
  for update;

  if v_processed then
    return false;
  end if;

  if v_received < now() - make_interval(secs => p_stale_seconds) then
    update webhook_events set received_at = now()
    where shopify_topic = p_topic and shopify_id = p_id;
    return true;
  end if;

  return false;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------
-- check_rate_limit: fixed-window counter. Returns true when the call is
-- allowed. Increments only on allow, so a blocked caller can't extend
-- their own penalty by hammering.
-- ---------------------------------------------------------------------
create or replace function check_rate_limit(
  p_key            text,
  p_limit          int,
  p_window_seconds int
) returns boolean as $$
declare
  v_window timestamptz;
  v_count  int;
begin
  v_window := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into api_rate_limits (bucket_key, window_start, count)
  values (p_key, v_window, 1)
  on conflict (bucket_key, window_start) do update
    set count = api_rate_limits.count + 1
    where api_rate_limits.count < p_limit
  returning api_rate_limits.count into v_count;

  -- No row returned => the WHERE on the DO UPDATE failed => at the limit.
  return v_count is not null;
end;
$$ language plpgsql;

-- Housekeeping: drop windows nobody will read again.
create or replace function prune_rate_limits() returns void as $$
  delete from api_rate_limits where window_start < now() - interval '1 day';
$$ language sql;

-- ---------------------------------------------------------------------
-- claim_abandoned_checkouts: hand the caller a batch of carts to chase.
--
-- FOR UPDATE SKIP LOCKED + a claimed_at stamp means two overlapping cron
-- runs can never grab the same cart, so a customer can't get the same
-- reminder twice because the 5-minute job ran long.
-- ---------------------------------------------------------------------
create or replace function claim_abandoned_checkouts(
  p_delay_minutes int,
  p_max_reminders int,
  p_gap_hours     int,
  p_limit         int default 50
) returns setof abandoned_checkouts as $$
begin
  return query
  with due as (
    select ac.id
    from abandoned_checkouts ac
    where ac.status in ('pending','reminder_sent')
      and ac.created_at < now() - make_interval(mins => p_delay_minutes)
      and ac.reminder_count < p_max_reminders
      and (ac.last_reminder_at is null
           or ac.last_reminder_at < now() - make_interval(hours => p_gap_hours))
      and (ac.claimed_at is null
           or ac.claimed_at < now() - interval '15 minutes')
      and (ac.email is not null or ac.phone is not null)
    order by ac.created_at
    limit p_limit
    for update skip locked
  )
  update abandoned_checkouts ac
  set claimed_at = now()
  from due
  where ac.id = due.id
  returning ac.*;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------
-- claim_upsell_jobs: same pattern for the delayed upsell queue.
-- ---------------------------------------------------------------------
create or replace function claim_upsell_jobs(
  p_limit int default 50
) returns setof upsell_queue as $$
begin
  return query
  with due as (
    select uq.id
    from upsell_queue uq
    where uq.status = 'pending'
      and uq.scheduled_for <= now()
      and uq.attempts < 3
      and (uq.claimed_at is null or uq.claimed_at < now() - interval '15 minutes')
    order by uq.scheduled_for
    limit p_limit
    for update skip locked
  )
  update upsell_queue uq
  set claimed_at = now(), attempts = uq.attempts + 1
  from due
  where uq.id = due.id
  returning uq.*;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------
-- expire_stale_checkouts: carts nobody converted and we've stopped
-- chasing. Keeps the pending index small.
-- ---------------------------------------------------------------------
create or replace function expire_stale_checkouts(p_days int default 7)
returns int as $$
declare
  v_count int;
begin
  update abandoned_checkouts
  set status = 'expired'
  where status in ('pending','reminder_sent')
    and created_at < now() - make_interval(days => p_days);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$ language plpgsql;
