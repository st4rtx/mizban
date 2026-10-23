# Architecture: Concurrency

Chosen model: **row-level pessimistic lock on the order for anything that changes the bill, optimistic version check on anything a human looked at before acting.** Not CRDTs, not event sourcing.

| Situation | Mechanism | Outcome |
|---|---|---|
| Two waiters open the same table | partial unique index `orders_one_open_per_table` + `ON CONFLICT DO NOTHING` | both land on one order |
| Many people add items | each item is its own row; the order row is locked `FOR UPDATE` for the few ms it takes to insert and bump `orders.version` | nothing lost, adds serialise per order |
| Retried "send" after Wi-Fi drop | `client_request_id` per batch, unique `(order_id, client_request_id, line_no)` | applied once |
| Kitchen taps vs waiter voids the same dish | `UPDATE … WHERE version = $v AND status = ANY(legal_sources)` | exactly one wins, loser gets 409 `item_changed` with fresh state |
| Cashier looking at a total while an item is added | payment carries `orderVersion`; mismatch returns 409 `bill_changed` with the current order | table is never closed on a stale total |
| Payment racing add-item | both take `FOR UPDATE` on the order | either the item is on the paid bill or the payment is refused |
| Double-tap on pay | `payments (order_id, idempotency_key)` unique; replay returns current order | recorded once |
| Two discounts | version check on the order | one wins, only the winner is audited |

## Where it breaks (stated honestly)

- Adds serialise per order. A 40-person table adding at the exact same instant waits a few milliseconds each. Fine for a restaurant, wrong for a stadium.
- Item **status** changes do not bump the order version (they do not change money). A cashier can therefore pay while an item is still `preparing` on a take-away; dine-in blocks that with `items_pending`.
- Live updates are in-process. A second API instance would not see the first one's events. Fix: Postgres LISTEN/NOTIFY.
- Last-write-wins on menu price and availability (manager only, audited).
- Lock order is always order → item. Any new code path must keep it or it can deadlock; `withTenant` retries deadlocks twice.

Tests: `server/src/tests/concurrency.test.ts` runs these races against real Postgres with parallel requests.
