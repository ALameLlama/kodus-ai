#!/bin/sh
set -eu

echo "▶ dev-entrypoint: starting (NODE_ENV=${NODE_ENV:-})"

# ----------------------------------------------------------------
# Dynamic Environment Configuration
# ----------------------------------------------------------------
# Generates the environment.ts file at runtime based on ENV vars.
# This allows changing CLOUD_MODE/DEV_MODE without rebuilding.
# ----------------------------------------------------------------
CLOUD_MODE=${API_CLOUD_MODE:-false}
DEV_MODE=${API_DEVELOPMENT_MODE:-true}

echo "▶ Configuring Environment..."
echo "  - API_CLOUD_MODE: $CLOUD_MODE"
echo "  - API_DEVELOPMENT_MODE: $DEV_MODE"

sed -e "s/__CLOUD_MODE__/${CLOUD_MODE}/g" \
    -e "s/__DEVELOPMENT_MODE__/${DEV_MODE}/g" \
    -e "/declare const/d" \
    libs/ee/configs/environment/environment.template.ts > libs/ee/configs/environment/environment.ts

# Fingerprint of dependency manifests used to detect stale node_modules volume.
DEPS_FINGERPRINT=$(node -e "const fs=require('fs'); const crypto=require('crypto'); const h=crypto.createHash('sha256'); h.update(fs.readFileSync('package.json')); h.update('\\n'); h.update(fs.readFileSync('yarn.lock')); process.stdout.write(h.digest('hex'));")
DEPS_STAMP_FILE="node_modules/.deps-fingerprint"

install_deps() {
  echo "▶ Installing deps (yarn --frozen-lockfile)…"
  yarn install --frozen-lockfile
  mkdir -p node_modules
  printf "%s" "$DEPS_FINGERPRINT" > "$DEPS_STAMP_FILE"
}

# 1. Install dependencies if necessary
if [ ! -x node_modules/.bin/nest ]; then
  install_deps
fi

# 1a. Install deps when package.json or yarn.lock changed since last successful install.
if [ -f "$DEPS_STAMP_FILE" ]; then
  INSTALLED_FINGERPRINT=$(cat "$DEPS_STAMP_FILE" || true)
else
  INSTALLED_FINGERPRINT=""
fi
if [ "$INSTALLED_FINGERPRINT" != "$DEPS_FINGERPRINT" ]; then
  echo "▶ Dependency manifests changed; syncing node_modules..."
  install_deps
fi

# 1b. Ensure @nestjs/common exports are valid (guard against broken node_modules)
if ! node -e "const { Module } = require('@nestjs/common'); process.exit(typeof Module === 'function' ? 0 : 1)"; then
  echo "▶ @nestjs/common export invalid; reinstalling deps..."
  rm -rf node_modules
  install_deps
fi

# 1c. Ensure zod v4 runtime files are present (guard against partial/broken installs)
if [ ! -f node_modules/zod/v4/core/util.js ]; then
  echo "▶ zod runtime files missing; reinstalling deps..."
  rm -rf node_modules
  install_deps
fi

# 2. Run Migrations and Seeds (if configured)
RUN_MIGRATIONS="${RUN_MIGRATIONS:-false}"
RUN_SEEDS="${RUN_SEEDS:-false}"

if [ "$RUN_MIGRATIONS" = "true" ]; then
  echo "▶ Running Migrations..."
  npm run migration:run:internal
else
  echo "▶ Skipping Migrations (RUN_MIGRATIONS=$RUN_MIGRATIONS)"
fi

if [ "$RUN_SEEDS" = "true" ]; then
  echo "▶ Running Seeds..."
  npm run seed:internal
else
  echo "▶ Skipping Seeds (RUN_SEEDS=$RUN_SEEDS)"
fi

# 3. Yalc Check
[ -d ".yalc/@kodus/flow" ] && echo "▶ yalc detected: using .yalc/@kodus/flow"

# 4. Execute container command (Full flexibility)
# If no command is passed, use nodemon as fallback
if [ $# -eq 0 ]; then
    echo "▶ No command specified, defaulting to nodemon..."
    exec nodemon --config nodemon.json
else
    echo "▶ Executing command: $@"
    exec "$@"
fi
