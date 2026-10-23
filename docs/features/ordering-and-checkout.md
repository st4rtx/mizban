# Feature: Ordering and Checkout (the service loop)

## Purpose

Take a table from empty to paid with several people working on the same order, without losing or corrupting anything.

## Scope

Floor map; open table / takeaway ticket; cart then "send"; kitchen/bar board; serve; void with reasons; discount with role cap; bill request; split payment (cash/card/transfer); receipt print; audit trail.

## Out of Scope

Table merge/move, item-level split, kitchen printers, card-terminal integration, tax-authority submission, inventory.

## Related Files

- server/src/services/orders.ts
- server/src/routes/orders.ts, floor.ts, kitchen.ts, events.ts
- web/src/pages/Floor.tsx, Order.tsx, Checkout.tsx, Kitchen.tsx

## Related Pages

/floor, /order/:id, /kitchen

## Related APIs

POST /api/orders; GET /api/orders/:id; POST /api/orders/:id/items; PATCH /api/order-items/:id/status; POST /api/order-items/:id/void; PUT /api/orders/:id/discount; POST /api/orders/:id/bill-request; POST /api/orders/:id/payments; POST /api/orders/:id/void; GET /api/floor; GET /api/kitchen; GET /api/events (SSE). See [api/README.md](../api/README.md).

## Data Models

orders, order_items, payments, audit_log. See [database/schema.md](../database/schema.md).

## Business Rules

- Roles: `manager` (all), `floor` (waiter + cashier), `kitchen` (board only). Staff may be pinned to one branch.
- Item states: `new → preparing → ready → served`, `preparing → new`, `ready → preparing`. Kitchen moves new/preparing/ready; floor only marks `served`.
- Floor can void an item only while `new`. After that only a manager, with a reason.
- Floor discount cap = restaurant `floor_discount_max_pct` (demo 10%). Discount needs a reason and is audited.
- Totals: discount, then service %, then VAT % on (taxable + service). Rounded per line of the bill.
- Dine-in cannot close while an item is `new` or `preparing`; `ready` items are auto-served on close.
- A closed (paid/void) order accepts no changes.

## User Flow

1. Waiter taps a free table, picks guest count. 2. Taps items into a draft cart, optional notes. 3. "Send": one request, one `requestId`. 4. Kitchen/bar see tickets live, advance them. 5. Waiter marks served. 6. Customer asks for the bill; waiter flags it, the tile turns red. 7. Cashier opens checkout, optionally discounts, pays in one or more parts. 8. Table frees; receipt can be printed.

## Edge Cases

Retry after dropped connection; stale total at checkout; item sold out between menu load and send (409 with ids, cart auto-cleans); overpay refused; two devices on the same order; kitchen tap vs cancel.

## Security Notes

All routes authenticated; role guards server-side; branch pin enforced server-side; tenant isolation by RLS. UI hiding is cosmetic only.

## Dependencies

PostgreSQL. No external services.

## Change History

- 2026-10-23: Initial version.
