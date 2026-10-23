# Database: Schema

## Purpose

Model the domain (restaurant → branch → table; menu; order → item → payment), not the screens.

## Tables

`restaurants`, `branches`, `users`, `dining_tables`, `menu_categories`, `menu_items`, `orders`, `order_items`, `payments`, `audit_log`, `day_briefs`.

## Key decisions

- Money is integer toman. No floats anywhere.
- `order_items` snapshot `name` and `unit_price`: editing the menu never rewrites history or a bill.
- Totals are computed live for open orders and **frozen** (`paid_*` columns) at settlement.
- `orders.version` is the bill version: bumped by add item, void item, discount. Not by status changes or payments.
- Composite foreign keys `(restaurant_id, x_id)` make it impossible to point an order at another tenant's table or item, even through a bug.
- `audit_log` is append-only for the app role (UPDATE/DELETE revoked).

## Row-level security

Every tenant table has `restaurant_id` and policy `restaurant_id = app_tenant()` with `FORCE ROW LEVEL SECURITY`. `app_tenant()` reads `current_setting('app.restaurant_id', true)`, set per transaction by `withTenant`. Unset means NULL means no rows (fail closed). The runtime role `mizban_app` is `NOBYPASSRLS`, owns nothing, and cannot read `schema_migrations`.

The only cross-tenant read is `auth_lookup(username)` (SECURITY DEFINER), needed because login happens before the tenant is known. It returns one row by exact username.

## Indexes

`menu_items_name_uq` and `menu_categories_name_uq` (unique per restaurant, `lower(name)`, migration 002), `orders_one_open_per_table` (partial unique), `orders_branch_open_idx`, `orders_branch_closed_idx` (reports), `order_items_live_idx` (kitchen board), `audit_restaurant_at_idx`.

## Migration notes

Plain SQL in `server/migrations`, applied in order by `server/src/db/migrate.ts`, tracked in `schema_migrations`. Forward-only. The runtime role and its grants are (re)applied on every migrate run; its password comes from `APP_DB_PASSWORD`, never from SQL files.

## Security notes

Staff names and discount reasons are free text and are never passed to the AI provider.

## Related

- [Feature: ordering and checkout](../features/ordering-and-checkout.md)

## Change History

- 2026-10-23: Initial version.
- 2026-10-23: Migration 002: unique names for menu items and categories per restaurant.
