#!/usr/bin/env bash
# Pack the deploy artifact. The tarball root is the PM2 working directory.
# The host extracts it and runs `npm ci --omit=dev` (no node_modules here).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

test -f dist/index.js
test -f dist/db/migrate.js
test -d public
test -d migrations
test -f package.json
test -f package-lock.json
test -f ecosystem.config.cjs

out="${1:-$root/release.tar.gz}"
tar -czf "$out" \
  dist \
  public \
  migrations \
  package.json \
  package-lock.json \
  ecosystem.config.cjs

# Refuse a pack that picked up env files or installed modules.
if tar -tzf "$out" | grep -E '(^|/)\.env($|\.)|(^|/)node_modules/' >/dev/null; then
  echo "release tarball must not contain .env or node_modules" >&2
  exit 1
fi
