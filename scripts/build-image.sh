#!/usr/bin/env bash
# Build everything locally (npm registries and Docker Hub can be blocked from Iranian servers),
# package it in an image, and write a gzip tarball ready for `docker load` on the server.
# Usage: scripts/build-image.sh [tag]     Refuses to build from a dirty git tree unless ALLOW_DIRTY=1.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -d .git ] && [ -n "$(git status --porcelain)" ] && [ "${ALLOW_DIRTY:-0}" != "1" ]; then
  echo "working tree is dirty: commit first (deploys must come from a commit)" >&2; exit 1
fi
SHA=$(git rev-parse --short HEAD 2>/dev/null || echo nogit)
TAG="${1:-$SHA}"
rm -rf .build && mkdir -p .build/server
( cd web && npm run build )
( cd server && npm run build )
cp -r web/dist .build/web-dist
cp -r server/dist server/migrations server/package.json server/package-lock.json .build/server/
( cd .build/server && npm ci --omit=dev --legacy-peer-deps --offline --no-audit --no-fund )
docker build -f Dockerfile.prebuilt --platform linux/amd64 -t "mizban-app:$TAG" .
docker save "mizban-app:$TAG" | gzip > ".build/mizban-app-$TAG.tar.gz"
echo "image mizban-app:$TAG -> .build/mizban-app-$TAG.tar.gz ($(du -h ".build/mizban-app-$TAG.tar.gz" | cut -f1)) from commit $SHA"
