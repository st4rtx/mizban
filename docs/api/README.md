# API: Overview

All under `/api`, JSON, session cookie `mz_session` (HttpOnly, SameSite=Lax, Secure in production). Errors: `{ "error": { "code", "message", "details?" } }`. Validation errors are 400 `validation`; unknown or foreign ids are 404; conflicts are 409 with `details.current` carrying fresh state.

| Method | Path | Roles | Notes |
|---|---|---|---|
| POST | /auth/login | public | rate-limited 8/min per IP+username |
| POST | /auth/logout | any | |
| GET | /auth/me | any | user, restaurant settings, branches |
| GET | /auth/demo | public | accounts list, only if DEMO_MODE |
| GET | /floor?branchId | manager, floor | tables + open orders + takeaway |
| GET | /menu | any | categories with items |
| PATCH | /menu/items/:id | manager | `{available?, price?}`, audited |
| POST | /orders | manager, floor | open table/takeaway; idempotent per table |
| GET | /orders/:id | any (branch-scoped) | full order with totals |
| POST | /orders/:id/items | manager, floor | `{requestId, items[]}`, idempotent on requestId |
| PATCH | /order-items/:id/status | any | `{to, version}`; kitchen: new/preparing/ready, floor: served |
| POST | /order-items/:id/void | manager, floor | `{reason?, version}` |
| PUT | /orders/:id/discount | manager, floor | `{kind, value, reason, version}`, role cap |
| POST | /orders/:id/bill-request | manager, floor | |
| POST | /orders/:id/payments | manager, floor | `{method, amount, orderVersion, idempotencyKey}` |
| POST | /orders/:id/void | manager | `{reason}`, only without payments |
| GET | /kitchen?branchId&station | manager, kitchen | live tickets |
| GET | /reports/day?branchId&date | manager | metrics + flags |
| POST | /reports/day/brief | manager | AI or template brief, 10/min |
| GET | /events | any | SSE: `order`, `menu` events |
| GET | /changes | any | long-poll twin of /events (≤25 s) for CDNs that buffer streams |
| GET | /health, /ready | public | liveness, DB readiness |

Common error codes: `unauthorized` 401, `forbidden` 403, `not_found` 404, `item_changed` / `bill_changed` / `order_closed` / `items_pending` / `item_unavailable` / `has_payments` 409.
