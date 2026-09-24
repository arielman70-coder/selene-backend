# selene-backend

Node 20 + TypeScript backend for a Shopify DTC store (~1,000 orders/month).
Handles abandoned-cart recovery, cashback with spend tiers, and post-purchase
upsell over WhatsApp and email.

Customer identity comes from the Shopify webhooks — there are no accounts and
no signup. The Lovable frontend is a customer-club page where a shopper types
the email they ordered with and sees their cashback balance. The service-role
key stays server-side only; Lovable never touches the database.

## Stack

| Concern    | Choice                                    |
|------------|-------------------------------------------|
| Runtime    | Node 20 + Express (TypeScript, strict)    |
| Database   | Supabase Postgres                         |
| WhatsApp   | Green API, Twilio fallback                |
| Email      | Resend, Amazon SES fallback               |
| Scheduling | pg_cron → authenticated `/jobs/*` routes  |

## Setup

```bash
npm install
cp .env.example .env      # fill it in — the app refuses to boot without it
```

Then, in the Supabase SQL editor, run in order:

1. `supabase/migrations/001_initial_schema.sql` — tables, indexes, RLS, tier seed
2. `supabase/migrations/002_functions.sql` — atomic balance/claim functions
3. `supabase/migrations/004_login_codes.sql` — email OTP table and functions
4. `supabase/migrations/005_tiers_and_cashback_expiry.sql` — current tier ladder,
   `last_accrual_at`, and the cashback expiry sweep
5. `supabase/migrations/003_cron.sql` — **after deploying**, with `<BACKEND_URL>`
   and `<CRON_SECRET>` replaced

Apply 005 **before** deploying the code that ships with it. Migration-first is
safe in both directions: the old 3-argument `increment_cashback` calls still
resolve against the new 4-argument function via its default. Code-first is not
— `expire_stale_cashback` would not exist yet (the sweep logs an error and
skips, harmlessly), and the two refund paths in `redeem-cashback.ts` would pass
a `p_touch_accrual` argument the deployed function has no parameter for.

Deploy, then point Shopify at the deployment:

```bash
npm run register-webhooks -- --base https://your-backend.up.railway.app
npm run list-webhooks     # verify
```

Local development:

```bash
npm run dev        # nodemon + ts-node
npm run typecheck
npm run build && npm start
```

## Routes

| Method | Path                             | Auth          |
|--------|----------------------------------|---------------|
| GET    | `/health`                        | none          |
| POST   | `/webhooks/checkout-create`      | Shopify HMAC  |
| POST   | `/webhooks/checkout-update`      | Shopify HMAC  |
| POST   | `/webhooks/order-create`         | Shopify HMAC  |
| POST   | `/webhooks/order-paid`           | Shopify HMAC  |
| POST   | `/webhooks/order-refund`         | Shopify HMAC  |
| POST   | `/api/auth/request-code`         | none, rate-limited |
| POST   | `/api/auth/verify-code`          | none, rate-limited |
| GET    | `/api/customer/profile`          | club session  |
| PATCH  | `/api/customer/preferences`      | club session  |
| GET    | `/api/customer/cashback-history` | club session  |
| GET    | `/api/customer/active-coupon`    | club session  |
| POST   | `/api/customer/redeem-cashback`  | club session + rate limit |
| POST   | `/jobs/abandoned-carts`          | `CRON_SECRET` |
| POST   | `/jobs/upsell-queue`             | `CRON_SECRET` |
| POST   | `/jobs/expire-coupons`           | `CRON_SECRET` |

**Club login (email OTP).** `POST /api/auth/request-code {email}` mails a
six-digit code; `POST /api/auth/verify-code {email, code}` returns the
customer's balance plus a `session_token` valid for `CLUB_SESSION_MINUTES`
(default 30). The frontend sends that token as `Authorization: Bearer <token>`
on every other route. Expired token → `401 {code: "SESSION_EXPIRED"}`, and the
page asks for the email again.

`request-code` answers 200 with the same body whether or not the address is a
customer — anything else makes it an oracle for who shops here. Codes are
single-use, expire in `OTP_TTL_MINUTES`, survive `OTP_MAX_ATTEMPTS` wrong
guesses, and issuing a new one voids the old.

## How the flows work

**Abandoned cart.** `checkouts/create` and `checkouts/update` upsert into
`abandoned_checkouts`. Every 5 minutes the job claims a batch, mints one
Shopify coupon per cart, and sends WhatsApp + email. `orders/create` marks the
cart converted so nobody who already bought gets chased.

**Cashback.** `orders/create` credits `subtotal × tier.cashback_pct`, writes a
ledger row, and re-evaluates the tier. `refunds/create` reverses it pro-rata.
Redemption converts a balance into a fixed-amount discount code.

The ladder is bronze 5% / silver 7% from ₪500 / gold 10% from ₪1,500, and
tiers only ever move up. 005 retires the platinum tier that 001 seeded,
moving anyone still on it to gold — the one demotion in the system, and a
raise at that, since platinum paid 7%.

A balance expires `CASHBACK_EXPIRY_MONTHS` (default 12) after the customer's
last accrual. `last_accrual_at` is stamped by `increment_cashback` on every
credit; the hourly job zeroes anything past the window and writes an `expire`
ledger row for it. Refunding a failed redemption deliberately does not restamp
the clock — the customer is getting back money they already had.

**Upsell.** `orders/create` enqueues a row in `upsell_queue` scheduled
`UPSELL_DELAY_MINUTES` out. A per-minute job matches an offer from
`upsell_offers`, mints a coupon, and sends it.

`upsell_offers` starts empty, so no upsells send until you add rows:

```sql
insert into upsell_offers
  (name, trigger_product_ids, offer_product_id, offer_product_title,
   offer_product_url, discount_pct, priority)
values
  ('Refill after starter kit', '{123456789}', 987654321, 'מארז מילוי',
   'https://yourbrand.co.il/products/refill', 15, 10);
```

An offer with an empty `trigger_product_ids` is a catch-all fallback.

## Design notes

Things that are deliberate, so they don't get "simplified" back later:

- **Money moves inside Postgres functions.** `increment_cashback`,
  `decrement_cashback` and `reverse_cashback` are atomic. `decrement_cashback`
  carries `and cashback_balance >= p_amount`, so concurrent redemptions cannot
  drive a balance negative regardless of what the API layer does.
- **Redemption debits before minting.** A failed mint is refunded immediately.
  Minting first would leave live, unpaid-for discount codes in Shopify when the
  debit fails.
- **`tier_config` has no rank column.** `min_spent` is the ladder, so ordering
  by it is the ranking — nothing can drift out of step with the thresholds the
  way a separate `sort_order` can.
- **Reads of `tier_config` check their error.** Swallowing it let a renamed
  column surface as `tier: null` in the API and as tier upgrades that silently
  never happened, rather than as a failure anyone could see.
- **One `earn` ledger row per order**, enforced by a partial unique index. It is
  the last line of defence against a replayed webhook double-crediting.
- **Jobs claim rows with `FOR UPDATE SKIP LOCKED`.** A run that overruns its
  5-minute interval cannot have its carts picked up again by the next run.
- **Raw body is captured via `express.json({ verify })`.** Draining the stream
  by hand leaves the parser with nothing and `req.body` permanently empty.
- **HMAC compares length before `timingSafeEqual`**, which throws on mismatched
  buffers — a one-character header would otherwise 500 instead of 401.
- **The Shopify token refreshes itself, and client credentials always win.**
  Set `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET` and the backend exchanges
  them via `POST /admin/oauth/access_token` (`grant_type=client_credentials`),
  caching the result in memory, refreshing a minute before `expires_in`,
  fetching single-flight so a batch of concurrent calls triggers one exchange,
  and re-fetching once on a 401. `SHOPIFY_ADMIN_ACCESS_TOKEN` is only a
  fallback for setups with no app, and is ignored whenever client credentials
  exist — a client_credentials token lasts 24 hours, so one pasted into that
  variable used to shadow the refresh logic and take Shopify down a day later,
  with no way to recover on its own. Boot logs which mode is active.
- **Coupon codes use `crypto.randomInt`.** These are bearer instruments;
  `Math.random()` is predictable enough to guess forward from a known code.
- **Webhooks ack before working.** Shopify times out at 5s and retries.
- **The session token carries the customer id**, so no endpoint reads one from
  a request body.
- **Login codes are stored as SHA-256 with `API_TOKEN_SECRET` as pepper.** Six
  digits is a 1,000,000-wide space, so a plain hash is a rainbow table away
  from useless; the pepper lives only in the environment, which keeps a leaked
  database dump from yielding working codes. Verification and the attempt
  counter run inside one Postgres function, so parallel requests can't both
  spend the same code.
- **Redemption codes are sent to the email/WhatsApp on file, never returned in
  the HTTP response.** Typing an email is not proof of owning it, so echoing
  the code back would let a stranger convert someone else's balance into a
  discount they could spend. Out-of-band delivery means the worst a stranger
  can do is move a balance into a code only the real owner receives. The
  active-coupon 409 response omits the code for the same reason.
- **Reminder counters only increment on a delivered message**, so a provider
  outage doesn't silently burn a customer's remaining reminders.

## Verified

- `npx tsc --noEmit` clean (strict, `noUncheckedIndexedAccess`)
- Boots; `/health` 200
- Webhook auth: missing / short / wrong HMAC → 401; valid → 200; valid
  signature from an unexpected shop domain → 401
- Email OTP, against the real app with a stubbed database and mail provider:
  known and unknown addresses return byte-identical responses; no code is
  issued for an unknown address; correct code returns a working session;
  replaying a code fails; requesting a new code voids the previous one; five
  wrong guesses void the code; no code ever reaches the logs
- Code generation over 20,000 samples: always six digits, leading zeros kept,
  full range used, >90% unique; the pepper demonstrably changes the hash
- Session auth: no token, garbage, expired, wrong issuer, and wrong signature
  → 401; valid session passes into the handler
- Job auth: missing and wrong `CRON_SECRET` → 401
- Env validation rejects missing vars, a storefront domain in
  `SHOPIFY_STORE_DOMAIN`, a short `CRON_SECRET`, no Shopify credential of
  either kind, and a half-set client id/secret pair
- Shopify token exchange (against a stubbed fetch): 6 concurrent cold-cache
  calls trigger exactly 1 exchange, the cached token is reused, and a 401
  triggers exactly one refresh plus a retry with the new token
- Phone normalization: 13 cases (local, dashed, spaced, `00`, `+972`,
  redundant trunk zero, landline, junk)

**Not verified:** the SQL migrations have never been executed — no Postgres was
available in this environment. Run them against a Supabase branch before
production. Nothing has been tested against live Shopify, Green API, Resend, or
Supabase; every external call is unexercised.
