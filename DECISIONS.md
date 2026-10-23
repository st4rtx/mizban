# DECISIONS

Each entry: decision / reason / alternative considered / trade-off accepted. Entries marked **REVISIT** are ones I now think were wrong or would change.

## 1. Build the table → kitchen → bill loop, nothing else
- **Decision:** one workflow, finished: open table, order in rounds, kitchen board, serve, discount, split payment, close, day report.
- **Reason:** it is where several people touch the same thing and where money leaks. A QR menu or a dashboard would demo well and survive nothing.
- **Alternative:** QR menu (easy, no value alone), inventory (weeks of data entry before payoff), menu-from-photo AI (flashy, hard to defend).
- **Trade-off:** no customer-facing surface, no inventory, no integrations. A restaurant can run a shift on it; it cannot yet replace the accountant.

## 2. Tenant isolation in the database (RLS), not only in code
- **Decision:** every tenant table has `restaurant_id`; Postgres row-level security with `FORCE`; the app connects as a role without `BYPASSRLS`; each request runs in a transaction that sets `app.restaurant_id` locally. Unset means zero rows.
- **Reason:** "one restaurant must never reach another's data" should survive a forgotten `WHERE`. Composite foreign keys also stop cross-tenant references.
- **Alternative:** `WHERE restaurant_id = $1` everywhere (one slip leaks), schema-per-tenant or database-per-tenant (strongest, but migrations and pooling get painful at 1,000+).
- **Trade-off:** every query runs inside a transaction with a `set_config` round trip; RLS predicates cost a little on every statement; login needs one `SECURITY DEFINER` function that is the single cross-tenant read. Proof: `isolation.test.ts`.

## 3. Pessimistic order lock for bill changes, optimistic version for human decisions
- **Decision:** add/void/discount/pay lock the order row `FOR UPDATE`; every screen action carries the `version` it saw; mismatch returns 409 with fresh state. Items are separate rows, so adding is an insert, not a read-modify-write.
- **Reason:** simple, correct, explainable. The cashier-sees-stale-total bug is the one that costs money and it is closed by `orderVersion` on payments.
- **Alternative:** CRDT/event sourcing (overkill), `SERIALIZABLE` isolation (retries leak into UX), last-write-wins (silently loses a pizza).
- **Trade-off:** adds serialise per order; item *status* changes do not bump the bill version. See `docs/architecture/concurrency.md` for where it breaks.

## 4. SSE that says "refetch", never carries state
- **Decision:** the server pushes `order`/`menu` events with ids only; clients refetch. Plus a 20 s poll, refetch on reconnect and on tab focus.
- **Reason:** a lost event cannot leave a screen wrong; no client-side merge logic; works through CDNs that mangle WebSockets (`x-accel-buffering: no`).
- **Alternative:** WebSocket with state diffs (faster, much more to get wrong), polling only (simple, 5 s stale on the kitchen board).
- **Trade-off:** one extra GET per change per open screen. Fine at tens of devices.

### 4b. Long-poll fallback, found only after deploying
The public URL sits behind ArvanCloud, which buffers the SSE response (no bytes arrive). The client now opens SSE and, if it has not opened within 5 s, switches to `GET /api/changes` (long-poll, 25 s, complete responses). Lesson: a transport that works on localhost proves nothing about the CDN in front of it. Cost: a held request per device, same order of load as SSE.

## 5. Raw SQL with `pg` instead of an ORM
- **Decision:** hand-written SQL in services, zod at the boundary.
- **Reason:** I planned Prisma, then dropped it: RLS needs `set_config` inside the same transaction as every query, `FOR UPDATE`, partial unique indexes and `ON CONFLICT` are first-class here, and the data layer is small.
- **Alternative:** Prisma/Drizzle with a transaction wrapper.
- **Trade-off:** no generated types; row shapes are mapped by hand and a typo is a runtime error (tests catch the main paths, not all).

## 6. Fastify + Vite SPA in one container instead of Next.js
- **Decision:** one small image (42 MB RAM at idle) serving API and static app.
- **Reason:** the target host has 2.8 GB RAM shared with other apps and blocked package registries; no SSR need behind a login.
- **Alternative:** Next.js (nicer routing, heavier, slower to build here).
- **Trade-off:** hand-rolled 30-line router; no server-rendered pages.

## 7. Integer toman and snapshot lines
- **Decision:** money is integer toman; `order_items` copy name and unit price; totals are frozen at settlement.
- **Reason:** no float drift; changing a price never rewrites a bill; invoice-ready for later tax integration.
- **Alternative:** rial storage, decimal columns, live joins to the menu.
- **Trade-off:** toman/rial display switch is a later job; rounding rules (service then VAT) are my assumption pending the accountant.

## 8. Signed-cookie session, user re-read on every request
- **Decision:** HMAC-signed cookie with user id, restaurant id, expiry; each request re-loads the user row (active flag, role) inside the tenant.
- **Reason:** deactivating a user or changing a role takes effect immediately; no session table to manage.
- **Alternative:** JWT with embedded role (stale until expiry), server-side sessions.
- **Trade-off:** one extra DB transaction per request (see REVISIT 12); one global secret; no per-device logout.

## 9. Payments are recorded, not processed
- **Decision:** the cashier chooses cash/card/transfer and amount; the system validates, splits, and closes.
- **Reason:** Iranian terminals are standalone and PSP integration needs contracts. The value is correct bookkeeping under concurrency.
- **Alternative:** integrate a PSP.
- **Trade-off:** a cashier can record the wrong method. Audit trail shows it; nothing prevents it.

## 10. One narrow AI feature, with a hard output check
- **Decision:** the model only writes the Persian end-of-day brief from a closed JSON of aggregates; flags come from rules; staff-typed text never reaches it; answers with a link, bad length, or an unknown 4+ digit number are discarded for a template.
- **Reason:** AI adds little to real-time coordination, but the absent owner genuinely benefits from a readable summary. Prompt injection has no channel in.
- **Alternative:** forecasting, menu-from-photo, an "assistant" chat.
- **Trade-off:** the number check misses small numbers (order counts, percentages); quality depends on the Iranian-accessible provider.

### 10b. Model chosen by measurement, and the date handed over pre-formatted
`gapgpt-qwen-3.5` (what the Shahnameh project uses) answered a short prompt in 0.7 s, but with the real brief payload 3 of 4 calls timed out at 15 s and the fourth took 10 s. `gpt-4o-mini` through the same provider answered 4 of 4 in 3 to 4.5 s, so it is the default (`AI_MODEL` overrides it). Separately, the first answers failed my own number check because the model converted the Gregorian date to a Jalali year (۱۴۰۵) on its own: correct, but unverifiable. The server now hands the model a ready Jalali date and tells it not to compute dates. I kept the check strict rather than allow-listing years.
- **Trade-off:** one provider, one model, no automatic model failover; when it is down the owner gets the plain template.

## 11. `node:test` instead of Vitest/Jest
- **Decision:** built-in runner via `tsx`.
- **Reason:** zero extra dependencies; Vitest's install failed repeatedly in this environment (npm arborist error behind the proxy) and I would not spend the time box on it.
- **Alternative:** Vitest.
- **Trade-off:** no watch mode UI, weaker mocking; tests run serially against a real Postgres, which is what I wanted anyway.

## 12. REVISIT: user lookup as a separate transaction per request
- **Decision (wrong):** the auth guard opens its own `withTenant` transaction, then the handler opens another.
- **Why wrong:** doubles round trips and pool pressure on every call; a kitchen board polling every 10 s feels it first.
- **Would do instead:** one transaction per request: authenticate and handle inside it, or short-TTL in-memory cache of the user row keyed by id.

## 13. REVISIT: demo auto-reseed lives in the web process
- **Decision (wrong):** with `DEMO_MODE=true` the API process itself truncates and re-seeds when data is stale. That means the web process holds the admin DB URL.
- **Why wrong:** one misconfigured env var on a real deployment wipes it; the web process should never hold owner credentials.
- **Would do instead:** a separate one-shot job/cron container for demo refresh; the API gets only the restricted role. I accepted it because a stale demo is the more likely failure for a reviewer.

## 14. REVISIT: order numbers via `UPDATE branches SET order_seq = order_seq + 1`
- **Decision (wrong):** a running per-branch counter on the branch row.
- **Why wrong:** every new order in a branch serialises on one row; and restaurants expect numbers to restart each morning, which this does not do.
- **Would do instead:** per-business-day counter (table keyed by branch+day with `INSERT … ON CONFLICT DO UPDATE`), or a display number derived from the day's count.

## 15. REVISIT: DB roles are cluster-wide and my tests forgot
- **Decision (wrong):** test setup created a fresh database but re-ran migrations, which re-set the `mizban_app` role password cluster-wide, locking my dev API out until I noticed.
- **Would do instead:** namespaced role names per database, or run tests in a throwaway Postgres container. Fixed for now by sharing one password.

## 17. A zone is a name on a table, not a table of its own
- **Decision:** `dining_tables.zone` stays a text column; "add a zone" means adding tables with a new name, "rename a zone" is a bulk update.
- **Reason:** the owner's request was "how many tables, how many areas"; that is two numbers and a label, and a zones table would add joins, a delete problem, and a migration for no behaviour the restaurant asked for.
- **Alternative:** a `zones` table with its own sort order, capacity and settings.
- **Trade-off:** an empty zone cannot exist (it vanishes when its last table is deactivated), zone order is implied by table sort, a typo creates a new zone (fixed with rename/merge), and there are no per-zone settings. I would add the table the day someone wants zone-level service charge or a closing time.

## 18. Retire, never delete (tables and menu items)
- **Decision:** the setup screens add and edit but never delete. A table becomes inactive; an item becomes unavailable. A table with an open order cannot be retired.
- **Reason:** orders, payments and reports reference them. Deleting rewrites history or fails halfway; "inactive" keeps both honest.
- **Alternative:** soft delete with a `deleted_at`, or cascade.
- **Trade-off:** clutter grows (inactive rows stay in the table list) and an item name stays taken forever because of the unique name index. A manager cannot rename or fix a typo in an item name yet.

## 19. Unique names enforced by the database, case-insensitively
- **Decision:** migration 002 adds `UNIQUE (restaurant_id, lower(name))` on items and categories; the API turns the violation into a 409 with a readable message.
- **Reason:** reports group sales by name, so two "Latte" rows would silently merge and mislead; the unique index also settles two managers adding the same item at once without any locking code.
- **Alternative:** check-then-insert in code (races), or group reports by id.
- **Trade-off:** a legitimate "same name, different price" (e.g. small/large) must be named differently; and the migration would fail on a database that already has duplicates (the demo has none).

## 16. Draft cart on the client, "send" as one batch
- **Decision:** items live in a local cart (sessionStorage) until the waiter sends; the batch carries one `requestId`.
- **Reason:** the kitchen never sees half-typed orders; a retry cannot duplicate dishes.
- **Alternative:** each tap hits the server.
- **Trade-off:** a cart lives on one device; two waiters cannot co-edit an unsent cart (they can both send, which is fine).
