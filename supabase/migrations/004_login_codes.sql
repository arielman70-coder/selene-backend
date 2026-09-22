-- =====================================================================
-- 004_login_codes.sql
-- Email OTP for the customer club. Replaces "type an email, see a balance"
-- with proof that the person controls the mailbox.
-- =====================================================================

create table if not exists login_codes (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references customers(id) on delete cascade,
  email        citext not null,

  -- SHA-256 of (code + pepper). The plaintext code never touches the
  -- database, so a leaked dump can't be used to log in as anyone.
  code_hash    text not null,

  expires_at   timestamptz not null,
  attempts     int not null default 0,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);

-- The verify path looks up the newest live code for an email.
create index if not exists login_codes_lookup_idx
  on login_codes (email, created_at desc)
  where consumed_at is null;

create index if not exists login_codes_expiry_idx on login_codes (expires_at);

alter table login_codes enable row level security;

-- ---------------------------------------------------------------------
-- consume_login_code: verify and burn a code in one atomic step.
--
-- Returns the customer_id on success, null otherwise. Doing this in SQL
-- rather than TypeScript closes the window where two parallel requests
-- could both verify the same code before either marked it used.
--
-- The attempt counter increments on every wrong guess and the row dies at
-- p_max_attempts, so a 6-digit code can't be brute-forced: an attacker gets
-- 5 tries out of 1,000,000 before the code is void.
-- ---------------------------------------------------------------------
create or replace function consume_login_code(
  p_email        citext,
  p_hash         text,
  p_max_attempts int default 5
) returns uuid as $$
declare
  v_row login_codes;
begin
  select * into v_row
  from login_codes
  where email = p_email
    and consumed_at is null
    and expires_at > now()
    and attempts < p_max_attempts
  order by created_at desc
  limit 1
  for update;

  if not found then
    return null;
  end if;

  if v_row.code_hash <> p_hash then
    update login_codes set attempts = attempts + 1 where id = v_row.id;
    return null;
  end if;

  update login_codes set consumed_at = now() where id = v_row.id;
  return v_row.customer_id;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------
-- invalidate_login_codes: called before issuing a new code, so only the
-- most recent one ever works.
-- ---------------------------------------------------------------------
create or replace function invalidate_login_codes(p_email citext)
returns void as $$
  update login_codes set consumed_at = now()
  where email = p_email and consumed_at is null;
$$ language sql;

-- Housekeeping, wired into the hourly expire-coupons job.
create or replace function prune_login_codes() returns void as $$
  delete from login_codes where created_at < now() - interval '2 days';
$$ language sql;
