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
3. `supabase/migrations/003_cron.sql` — **after deploying**, with `<BACKEND_URL>`
   and `<CRON_SECRET>` replaced

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
| POST   | `/api/identify`                  | none, IP rate-limited |
| GET    | `/api/customer/profile`          | club session  |
| PATCH  | `/api/customer/preferences`      | club session  |
| GET    | `/api/customer/cashback-history` | club session  |
| GET    | `/api/customer/active-coupon`    | club session  |
| POST   | `/api/customer/redeem-cashback`  | club session + rate limit |
| POST   | `/jobs/abandoned-carts`          | `CRON_SECRET` |
| POST   | `/jobs/upsell-queue`             | `CRON_SECRET` |
| POST   | `/jobs/expire-coupons`           | `CRON_SECRET` |

**Club page flow.** `POST /api/identify {email}` looks up the customer row the
webhooks created and returns their balance plus a `session_token`, valid for
`CLUB_SESSION_MINUTES` (default 30). The frontend sends that token as
`Authorization: Bearer <token>` on the other routes, so an email never has to
be re-posted. Unknown address → `404 {code: "NOT_FOUND"}`; expired token →
`401 {code: "SESSION_EXPIRED"}`, and the page just asks for the email again.

## How the flows work

**Abandoned cart.** `checkouts/create` and `checkouts/update` upsert into
`abandoned_checkouts`. Every 5 minutes the job claims a batch, mints one
Shopify coupon per cart, and sends WhatsApp + email. `orders/create` marks the
cart converted so nobody who already bought gets chased.

**Cashback.** `orders/create` credits `subtotal × tier.cashback_pct`, writes a
ledger row, and re-evaluates the tier. `refunds/create` reverses it pro-rata.
Redemption converts a balance into a fixed-amount discount code.

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
- **One `earn` ledger row per order**, enforced by a partial unique index. It is
  the last line of defence against a replayed webhook double-crediting.
- **Jobs claim rows with `FOR UPDATE SKIP LOCKED`.** A run that overruns its
  5-minute interval cannot have its carts picked up again by the next run.
- **Raw body is captured via `express.json({ verify })`.** Draining the stream
  by hand leaves the parser with nothing and `req.body` permanently empty.
- **HMAC compares length before `timingSafeEqual`**, which throws on mismatched
  buffers — a one-character header would otherwise 500 instead of 401.
- **The Shopify token can be static or exchanged.** Set
  `SHOPIFY_ADMIN_ACCESS_TOKEN`, or set `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET`
  and the backend exchanges them via `POST /admin/oauth/access_token`
  (`grant_type=client_credentials`). The exchanged token is cached in memory,
  refreshed a minute before any `expires_in`, fetched single-flight so a batch
  of concurrent calls triggers one exchange, and re-fetched once on a 401.
- **Coupon codes use `crypto.randomInt`.** These are bearer instruments;
  `Math.random()` is predictable enough to guess forward from a known code.
- **Webhooks ack before working.** Shopify times out at 5s and retries.
- **The session token carries the customer id**, so no endpoint reads one from
  a request body.
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
- Club lookup: missing email → 400, malformed email → 400, well-formed email
  reaches the DB lookup
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
