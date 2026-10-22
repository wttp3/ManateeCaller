#!/usr/bin/env bash
# Pack a staged release tree into release.tar.gz.
# The stage directory must already contain production node_modules
# (`npm ci --omit=dev`). The host extracts this tarball and does not install.
# Refuses any .env file. node_modules is part of the release.
set -euo pipefail

out="${1:?output tarball}"
stage="${2:?stage directory}"

test -f "$stage/dist/index.js"
test -f "$stage/dist/db/migrate.js"
test -d "$stage/public"
test -d "$stage/migrations"
test -f "$stage/package.json"
test -f "$stage/package-lock.json"
test -f "$stage/ecosystem.config.cjs"
test -d "$stage/node_modules"
test ! -e "$stage/.env"
test ! -e "$stage/.env.local"

tar -czf "$out" -C "$stage" \
  dist \
  public \
  migrations \
  package.json \
  package-lock.json \
  ecosystem.config.cjs \
  node_modules

# grep -c reads the full listing. grep -q would SIGPIPE tar under pipefail
# and look like a missing node_modules tree.
module_entries="$(tar -tzf "$out" | grep -c '^node_modules/' || true)"
if [ "${module_entries}" -lt 1 ]; then
  echo "release tarball must include production node_modules" >&2
  exit 1
fi

if tar -tzf "$out" | grep -E '(^|/)\.env($|\.)' >/dev/null; then
  echo "release tarball must not contain .env" >&2
  exit 1
fi
