# Architecture: Deployment (test environment)

URL: https://testabr.ai-synapse.ir (public TLS at ArvanCloud) → nginx on the shared host → `127.0.0.1:8081` (app container). Postgres runs in its own container, reachable only inside the compose network (and on `127.0.0.1:5455` for the operator).

## Layout on the host

- `/opt/mizban/`: `docker-compose.yml`, `.env` (chmod 600, generated on the host, never in git), image tarball.
- Compose project name `mizban`; containers `mizban-app-1`, `mizban-db-1`; volume `mizban_mizban-pg`.
- nginx: `/etc/nginx/sites-available/mizban` enabled as `zzz-mizban`, plus `/etc/nginx/mizban-proxy.inc`. Other sites on the host were not modified.
- Memory limits: app 320 MB, db 384 MB (host has ~2.9 GB shared with other apps).

## Release

Build on a developer machine (the host cannot reach npm or Docker Hub), only from a clean commit:

```bash
scripts/build-image.sh                 # -> .build/mizban-app-<sha>.tar.gz
scp .build/mizban-app-<sha>.tar.gz docker-compose.yml ubuntu@HOST:/opt/mizban/
ssh ubuntu@HOST 'cd /opt/mizban && gunzip -c mizban-app-<sha>.tar.gz | sudo docker load \
  && sudo env APP_IMAGE=mizban-app:<sha> docker compose -p mizban up -d --no-build'
```

Migrations run on container start (idempotent). Demo data is seeded only when `DEMO_MODE=true`.

## Rollback

Keep the previous image loaded and re-run `up -d --no-build` with the previous `APP_IMAGE`. Schema changes are forward-only, so a rollback across a migration needs a restore from backup.

## Backups

Not configured by this project. Before real data: scheduled `pg_dump` of the `mizban` database to storage off this host.

## Never on this host

`docker build` (RAM), `docker image prune -a` (other apps' images), touching other nginx sites.
