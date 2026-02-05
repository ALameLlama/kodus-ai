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

# Generates the environment.ts file at runtime based on ENV vars using the template.
echo "▶ Configuring Environment..."
echo "  - API_CLOUD_MODE: $CLOUD_MODE"
echo "  - API_DEVELOPMENT_MODE: $DEV_MODE"

sed -e "s/__CLOUD_MODE__/${CLOUD_MODE}/g" \
    -e "s/__DEVELOPMENT_MODE__/${DEV_MODE}/g" \
    -e "/declare const/d" \
    libs/ee/configs/environment/environment.template.ts > libs/ee/configs/environment/environment.ts

# 1. Install dependencies if necessary
if [ ! -x node_modules/.bin/nest ]; then
  echo "▶ Installing deps (yarn --frozen-lockfile)…"
  yarn install --frozen-lockfile
fi

# 1b. Ensure @nestjs/common exports are valid (guard against broken node_modules)
if ! node -e "const { Module } = require('@nestjs/common'); process.exit(typeof Module === 'function' ? 0 : 1)"; then
  echo "▶ @nestjs/common export invalid; reinstalling deps..."
  rm -rf node_modules
  yarn install --frozen-lockfile
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