-- =====================================================================
-- 003_cron.sql
-- Scheduled jobs. Run this in the Supabase SQL editor AFTER the backend is
-- deployed and you know its public URL.
--
-- Replace before running:
--   <BACKEND_URL>   e.g. https://selene-backend.up.railway.app
--   <CRON_SECRET>   the same value as the backend's CRON_SECRET env var
--
-- The secret is stored in the job definition, which is readable by anyone
-- with SQL access to this project — that's the same trust boundary as the
-- service role key, so no new exposure, but rotate both together.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Re-running this file replaces the jobs rather than duplicating them.
select cron.unschedule(jobid)
from cron.job
where jobname in ('process-abandoned-carts', 'process-upsell-queue', 'expire-coupons');

-- Chase abandoned carts every 5 minutes.
select cron.schedule(
  'process-abandoned-carts',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := '<BACKEND_URL>/jobs/abandoned-carts',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <CRON_SECRET>',
      'Content-Type',  'application/json'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- Drain the delayed upsell queue every minute. UPSELL_DELAY_MINUTES defaults
-- to 2, so a coarser schedule would make the actual delay unpredictable.
select cron.schedule(
  'process-upsell-queue',
  '* * * * *',
  $$
  select net.http_post(
    url     := '<BACKEND_URL>/jobs/upsell-queue',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <CRON_SECRET>',
      'Content-Type',  'application/json'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- Hourly housekeeping: expire coupons, expire stale carts, prune rate limits.
select cron.schedule(
  'expire-coupons',
  '0 * * * *',
  $$
  select net.http_post(
    url     := '<BACKEND_URL>/jobs/expire-coupons',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <CRON_SECRET>',
      'Content-Type',  'application/json'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- Verify:
--   select jobname, schedule, active from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 20;
