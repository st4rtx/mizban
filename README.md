# Mizban (میزبان)

Service-floor platform for Iranian cafés and restaurants. This first version finishes **one** workflow and makes it survive a real shift: table → order → kitchen/bar → serve → discount → split payment → close → day report with an AI-written brief.

- Live: <https://testabr.ai-synapse.ir>  (demo accounts are on the login page; all passwords `demo1234`). Deployed from commit `82f44ac`.
- **AI brief status:** live. GapGPT (`gpt-4o-mini`) writes the brief in roughly 3 to 5 s; verified on the deployed URL. Two provider failures happened during testing (a timeout and a rejected answer) and each time the owner correctly got the template, which is the fallback working as designed.
- Scope agreed before building: [SCOPE.md](SCOPE.md) · Decisions: [DECISIONS.md](DECISIONS.md) · AI usage: [AI_USAGE.md](AI_USAGE.md) · For the owner (Persian): [HANDOVER.md](HANDOVER.md)

## Demo accounts

| Username | Role | Restaurant / branch |
|---|---|---|
| `sara` | manager | کافه‌رستوران نارنج, both branches |
| `ali`, `maryam` | floor (waiter, cashier) | Narenj Saadat Abad |
| `reza` | kitchen + bar | Narenj Saadat Abad |
| `kaveh`, `sahar` / `nima` | floor / kitchen | Narenj Vanak |
| `bagh` / `golnar` / `davood` | manager / floor / kitchen | چای‌خانه باغ (second tenant) |

Password for all: `demo1234`. These exist only because `DEMO_MODE=true`; the login page lists them only in that mode.

Things to try: open two browsers (`ali` and `reza`), send an order from one and watch it arrive on the other; open the same table from both; apply a 30% discount as `maryam` (refused) then as `sara`; open checkout on one device, add an item on another, then try to pay on the first; log in as `bagh` and try to find anything from Narenj.

## Run locally (one command)

Needs Docker.

```bash
make up          # creates .env on first run, builds, migrates, seeds, starts db + app
# open http://localhost:8081
```

Developer loop (db in Docker, API and Vite on the host; needs Node 20):

```bash
make dev                      # db + migrate + seed + API (:8081) + Vite (:5173)
make test                     # 25 tests against a real Postgres (needs the db container)
make reset                    # rebuild demo data
```

If your npm registry is blocked or flaky: `npm i --legacy-peer-deps --registry=https://registry.npmjs.org`.

## Architecture in one screen

```
React SPA (RTL, Vazirmatn bundled, no third-party hosts)
   │ HTTPS, cookie session, SSE
Fastify  routes → services → withTenant(restaurantId)
   │                               │ BEGIN; set_config('app.restaurant_id', …, local)
PostgreSQL 16  ←──────────────────┘ row-level security, role without BYPASSRLS
```

- `server/src/services/orders.ts` is the domain: every rule about orders, items, discounts and payments.
- `server/migrations/001_init.sql` is the schema; [docs/database/schema.md](docs/database/schema.md) explains it.
- [docs/architecture/concurrency.md](docs/architecture/concurrency.md) lists each race, the mechanism, and where it breaks.
- [docs/api/README.md](docs/api/README.md) lists the endpoints.

## Security: the three risks that matter here

1. **One restaurant reading another's data.** Row-level security on every tenant table with `FORCE`; the app role cannot bypass it; the tenant is set per transaction (never per connection) and unset means zero rows. Composite foreign keys block cross-tenant references. Proof: `server/src/tests/isolation.test.ts` asserts zero rows without a tenant, no cross-tenant read/update/insert, no leakage between pooled connections, and 404 (not 403) on foreign ids over HTTP.
2. **Money corruption under concurrency.** Version-checked bill (`orderVersion` on payments), idempotency keys on payments and on "send", unique index for one open order per table, row locks on bill-changing paths. A cashier cannot close a table on a stale total. Proof: `concurrency.test.ts`.
3. **The AI feature as an injection and cost channel.** The model receives only aggregates we computed, never text typed by staff; output is rejected for links, bad length, or an unknown 4+ digit number; timeout 15 s; results cached per data hash; endpoint rate-limited; template fallback. Proof: `workflow.test.ts` (validation and fallback).

Also handled: scrypt password hashing and identical responses for unknown user vs wrong password, per IP+username login rate limit, HttpOnly SameSite=Lax cookie (Secure in production), Origin check on state-changing requests, zod validation at every boundary, errors that fail closed with a request id and no internals, secrets only from the environment (boot fails if missing), request logs with cookies redacted, append-only audit log.

## Logging

Fastify's pino JSON logs, one line per request with `reqId` (honours `x-request-id` from the proxy and returns it to the client; every 500 shows the id to the user). Business events are logged with ids, not payloads: `login ok/failed`, `payment recorded`, `order voided`, `ai brief ok/fell back`, `demo data refreshed`. At 3 am: `docker compose logs app | grep '"level":50'` for errors, `grep <reqId>` to follow one request.

## What I chose not to test, and why

- **Browser end-to-end (Playwright).** The full-workflow test drives the same HTTP API the UI uses and covers the business rules; a browser test would mostly test React rendering at high cost. The screens were checked visually at desktop and 390 px instead.
- **The live AI provider.** Needs a key and network; I test what I own (validation, fallback, cost guards), not the vendor. Untested against the real endpoint until the key is configured.
- **SSE delivery end to end and the print stylesheet.** Behaviour depends on the proxy/CDN and the browser; the client repairs missed events by refetching, so correctness does not depend on it.
- **Load.** Not measured. See HANDOVER section 5 for where I expect it to break.
- **Seed realism and the Persian copy.** Reviewed by eye, not asserted.

## Configuration

Copy `.env.example` to `.env`. No secrets in the repo. Server variables are validated at boot (`server/src/config.ts`): `DATABASE_URL`, `DATABASE_ADMIN_URL`, `APP_DB_PASSWORD`, `SESSION_SECRET` (32+ chars), `COOKIE_SECURE`, `DEMO_MODE`, `ALLOWED_ORIGINS`, `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, `AI_TIMEOUT_MS`.

## Deploy

Registries and Docker Hub are blocked from Iranian hosts, so the image is built on a developer machine and shipped as a tarball:

```bash
scripts/build-image.sh          # refuses a dirty git tree; builds web + server, packages, writes .build/mizban-app-<sha>.tar.gz
# copy to server, docker load, then:
APP_IMAGE=mizban-app:<sha> docker compose up -d --no-build
```

ArvanCloud terminates public TLS; the host's nginx (`deploy/nginx.conf`, installed as `zzz-mizban`) uses the host's origin certificate and proxies to `127.0.0.1:8081`, overwriting `X-Forwarded-For`. ArvanCloud buffers SSE, so the client falls back to `/api/changes` long-polling (see DECISIONS 4b). Server layout and rollback: [docs/architecture/deployment.md](docs/architecture/deployment.md).

## Time box

**[OWNER]** State actual hours and, if over six, where they went.

## Layout

```
server/  src/{routes,services,db,lib,seed,demo,tests}  migrations/
web/     src/{pages,hooks.tsx,api.ts,fa.ts,ui.tsx,styles.css}
docs/    features, architecture, api, database
scripts/ build-image.sh
```
