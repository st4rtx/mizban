# AI_USAGE

Two different things use AI here and they should not be confused: **(a)** the product's runtime AI feature (the end-of-day brief, see `docs/features/day-report-ai-brief.md`), and **(b)** the AI tools used to build the product. This file is about (b).

> Items marked **[OWNER]** can only be answered by the person submitting this. Fill them in before sending; I would rather leave a visible blank than invent an answer.

## Tools

- **Claude Code** (CLI / VS Code extension), Opus 5.5 for planning and the first backend pass, Sonnet 5.5 for the rest. Used for essentially everything: reading the environment, schema, services, tests, UI, seed data, Dockerfiles, documents.
- Skills loaded inside it: `frontend-design` (design direction before writing CSS), `persian-writing` (HANDOVER and Persian UI copy, orthography lint).
- Headless Chrome driven from Python/Playwright, to look at the screens at desktop and 390 px widths.
- No other AI product was used for code. The runtime provider for the brief is GapGPT (OpenAI-compatible endpoint reachable from Iran); its key was copied server-to-server from the Shahnameh/farr production env into `/opt/mizban/.env` (mode 600) without being printed, and is not in the repo.
- **[OWNER]** Total hours spent and where they went.

## Where it saved real time

- Writing the same five concurrency scenarios as SQL **and** as parallel-request tests. That would have been an evening by hand.
- The seed: 51 menu items with realistic Persian names and toman prices, a 30-day history generator with weekday shape, split payments, planted anomalies. Tedious and error-prone by hand.
- The CSS system and ten screens in RTL.
- Documentation, in the shapes the project's own rules ask for.

## Where it produced something bad

These are real, from this build:

1. **Item status update SQL.** The first draft mixed up the "legal source states" condition (`$2 = ANY($4)` instead of `status = ANY($4)`) and had a convoluted ternary building the parameter. Caught by rereading it before running; rewritten with an explicit `allowedFrom(to)`.
2. **Sold-out query.** Left an unused `$1` placeholder, so Postgres failed with `could not determine data type of parameter $1`. Found by the smoke run against the report endpoint, not by the type checker.
3. **Test setup clobbered the dev database role.** Roles are cluster-wide; the test setup reset the `mizban_app` password and locked the dev API out. The AI did not foresee it. Found by `password authentication failed` in the log. Logged as REVISIT 15 in DECISIONS.
4. **Seed column hack.** The first seed had a duplicated `ready_at` column that was spliced out later, and voided items carried a non-null `ready_at`. Cleaned after reading the generated rows.
5. **Tool-use mistakes, not code mistakes:** a `pkill -f` pattern that matched its own shell and killed it (twice); an unquoted `--noproxy *` that the shell expanded into file names; assuming an npm mirror was reachable. All were environment discoveries, cheap to fix, but they show the AI acts on assumptions about the machine that must be checked.
6. **Security findings caught after commit, not before.** An automated review flagged two real flaws in the login limiter the assistant wrote: it trusted any `X-Forwarded-For` (`trustProxy: true`), and it keyed the limiter on a differently normalised username than the lookup. Both were exploitable, both are fixed and covered by tests that try the bypass.
7. **Worked on localhost, not behind the CDN.** The SSE design passed every local test and delivered nothing through ArvanCloud. Found only by testing the deployed URL; fixed with a long-poll fallback.
8. **Duplicate content.** The day-report UI showed every flag twice (once in the template text, once as a flag row). Found only by looking at a screenshot.
9. **Live provider flakiness.** The first deployed brief returned `fetch failed`; a direct POST then hung 25 s while a `GET /models` with the same key returned 200 in 0.5 s. Minutes later every model answered in about a second and the brief worked (about 6 s end to end). Cause unknown (provider side or path from the host). The template fallback absorbed it, which is the design, but it means provider latency is not something I can promise.
10. **Model said «امروز» about yesterday.** Caught by reading the first real AI output, not by the number validator (it only checks digits). Fixed with an explicit prompt rule; there is no automated check for wording errors like this.

## One recommendation I rejected

The plan the assistant proposed on day one was **Next.js + Prisma + a Playwright end-to-end test**. I dropped all three while building: Prisma fights per-transaction `set_config` and `FOR UPDATE`/`ON CONFLICT` patterns that the isolation and concurrency story depends on; Next.js was too heavy for a 2.8 GB shared host with blocked registries; and a browser e2e would have cost more of the time box than the HTTP-level full-workflow test, which exercises the same business rules. Reasons are in DECISIONS 5, 6 and 11. The Playwright e2e is on the "chose not to test" list below.

A second, smaller one: the assistant's first instinct for the brief's anomaly detection was to hand the raw day to the model. I rejected that: rules decide what is unusual, the model only writes sentences. That is what makes the output checkable.

## How generated code was verified

- `tsc --noEmit` on server and web, every change.
- 24 tests against a **real Postgres** (migrations + real seed, no mocks): tenant isolation at SQL and HTTP, role enforcement, CSRF/auth, five concurrency races with parallel requests, one full workflow, AI output validation.
- Direct SQL checks: the app role has `rolbypassrls = f`, no-tenant queries return 0 rows.
- Smoke scripts with `curl` against the running API; a screenshot pass at desktop and phone widths for every screen.
- Built the production image, started it against a database, checked `/ready`, static assets, SPA fallback, memory (≈ 42 MB idle).
- Read every migration and service as a reviewer, not as the author.

**Not verified:** real tablets/phones; SSE itself behind the CDN (it is buffered there, so the long-poll fallback is what actually runs in production); anything under load.

## Which parts of the architecture were my own thinking

- **[OWNER]** Decide honestly. My suggestion for the split, so you can correct it: the *product call* (service loop over QR menu; three roles; AI only after the shift; payments recorded not processed) and the scope cuts were agreed in the planning exchange; the *tenancy design* (RLS with a non-bypass role, `auth_lookup`), the *bill version on payments*, and the *SSE refetch* idea came from the assistant and were reviewed, not originated, by the owner. If that is not how it went, say so here.
