# Architecture: Overview

## Shape

One Node process (Fastify) serves the JSON API, the SSE stream, and the built React app. PostgreSQL holds all state. Nothing else.

```
 tablet / phone (React SPA, RTL)
        |  HTTPS (CDN or nginx) 
        v
 Fastify  ── /api/*  (zod validation, cookie session, role guard)
    |   └── /api/events (SSE: "something changed, refetch")
    v
 withTenant(restaurantId)  →  BEGIN; set_config('app.restaurant_id', …, local)  →  SQL under RLS
    v
 PostgreSQL 16  (role mizban_app: no BYPASSRLS, owns nothing)
```

## Layers

- `server/src/routes/*`: HTTP only. Parse with zod, call a service, publish a live event after commit.
- `server/src/services/orders.ts`: the domain. Every rule about orders, items, discounts, payments lives here.
- `server/src/services/reports.ts`, `ai.ts`: day metrics (SQL), anomaly rules (plain code), brief (AI + template).
- `server/src/db/pool.ts`: `withTenant`, the only way a request touches tenant tables.
- `web/src/pages/*`: one file per screen. State is server state: `useLoad` refetches on SSE event, slow poll, and tab focus.

## Tenancy

See [concurrency.md](concurrency.md) for races and [../database/schema.md](../database/schema.md) for RLS.

## Failure behaviour

- DB down: `/ready` returns 503, API calls return 500 with a request id (no internals).
- SSE drops: client reconnects (3 s) and refetches on reconnect, so a missed event is repaired.
- AI provider down/slow/invalid: day brief falls back to a template.
