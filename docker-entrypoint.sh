#!/bin/sh
set -e
# Migrations are idempotent and run on every start. Demo data is only seeded when DEMO_MODE=true.
node dist/db/migrate.js
if [ "$DEMO_MODE" = "true" ]; then node dist/seed/seed.js; fi
exec node dist/index.js
