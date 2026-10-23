-- Docs: /docs/database/schema.md
-- Reports group sales by item name and the menu editor lets a manager type names, so two items (or
-- categories) with the same name in one restaurant would silently merge in reports. Enforce uniqueness
-- case-insensitively per restaurant. Safe on existing data: the demo seed has no duplicates.
CREATE UNIQUE INDEX menu_items_name_uq ON menu_items (restaurant_id, lower(name));
CREATE UNIQUE INDEX menu_categories_name_uq ON menu_categories (restaurant_id, lower(name));
