# Feature: Menu and Floor Setup

## Purpose

Let a manager shape the restaurant without calling a developer: add a menu item or category (a daily special), and decide how many tables a branch has and which zones they sit in.

## Scope

- Add menu item (category, name, price, kitchen or bar, prep minutes, description). Add menu category.
- Add tables (one or many at once, numbered automatically), edit label/zone/seats, take a table out of service and bring it back, rename a zone.
- Existing: mark an item sold out, change a price.

## Out of Scope

Rename, move, or delete a menu item or category; reorder the menu; delete a table or zone; per-zone settings; a drag-and-drop floor plan; adding branches or staff (still done by us).

## Related Files

- server/src/routes/admin.ts, server/src/routes/floor.ts (sold out / price)
- server/migrations/002_unique_menu_names.sql
- web/src/pages/MenuAdmin.tsx, web/src/pages/Tables.tsx
- server/src/tests/admin.test.ts

## Related Pages

/menu (new item, new category), /tables (new, manager only). The waiter's /floor and /order/:id pick up changes live.

## Related APIs

POST /api/menu/items, POST /api/menu/categories, GET/POST /api/admin/tables, PATCH /api/admin/tables/:id, PATCH /api/admin/zones. See [api/README.md](../api/README.md).

## Data Models

menu_items, menu_categories, dining_tables, audit_log. See [database/schema.md](../database/schema.md).

## Business Rules

- Manager only, enforced on the server. Floor and kitchen get 403.
- A zone is not an entity. It is the name its tables share: a new zone appears when a table is added with a new name; renaming is one bulk update and merges with an existing zone of that name.
- Nothing is deleted. Old orders point at tables and items. A table is "inactive" (hidden from the floor, cannot be opened). A menu item is "not available".
- A table with an open order cannot be made inactive (409 `table_busy`).
- Names are unique per restaurant, case-insensitive, after trimming and collapsing spaces (items and categories). Table labels are unique per branch.
- Typed Persian text is normalised: Arabic ي/ك become ی/ک.
- Automatic table numbers continue from the highest numeric label in the branch. Max 50 tables per request and 200 per branch.
- A new item is available immediately and appears in the same breath on every open waiter screen (live event).
- Price changes never touch existing order lines (they hold a snapshot).

## User Flow

Menu: manager opens Menu, taps "New item", picks category, fills name and price, saves; it can be ordered at once. Floor: manager opens Tables, taps "Add table", picks or types a zone, sets how many and how many seats, saves; tables appear on the floor map.

## Edge Cases

Two managers numbering tables at the same moment (branch row is locked, test with 6 parallel requests). Empty menu (the page offers "first category"). Typing in a form while a live refresh arrives (modals are module-level components so they are not remounted). Another restaurant's manager sending our ids (404).

## Security Notes

Manager role checked in the route guard; branch-pinned managers are limited to their branch; row-level security hides other restaurants' categories, branches and tables so foreign ids look like "not found". Inputs validated with zod (lengths, ranges, enums). Every create, edit and deactivate is written to the audit log.

## Known limits

The demo auto-reseed (DEMO_MODE) wipes edits made here after 6 quiet hours. There is no undo; a mistyped item name can only be fixed by us.

## Change History

- 2026-10-23: Initial version.
