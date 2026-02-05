#!/bin/sh
set -eu

echo "▶ dev-entrypoint: starting (NODE_ENV=${NODE_ENV:-})"

# ----------------------------------------------------------------
# Dynamic Environment Configuration
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

# ----------------------------------------------------------------
# Dependencies check (restore from build cache if needed)
# ----------------------------------------------------------------
if [ ! -x node_modules/.bin/nest ]; then
  if [ -f /usr/src/node_modules.tar ]; then
    echo "▶ Restoring node_modules from build cache..."
    tar -xf /usr/src/node_modules.tar
  else
    echo "▶ Installing deps (no cache available)..."
    yarn install --frozen-lockfile
  fi
elif ! node -e "require('@nestjs/common')" 2>/dev/null; then
  echo "▶ node_modules corrupted, restoring from cache..."
  rm -rf node_modules
  if [ -f /usr/src/node_modules.tar ]; then
    tar -xf /usr/src/node_modules.tar
  else
    yarn install --frozen-lockfile
  fi
else
  echo "▶ Dependencies OK"
fi

# ----------------------------------------------------------------
# Migrations and Seeds (only for API container)
# ----------------------------------------------------------------
RUN_MIGRATIONS="${RUN_MIGRATIONS:-false}"
RUN_SEEDS="${RUN_SEEDS:-false}"

if [ "$RUN_MIGRATIONS" = "true" ]; then
  echo "▶ Running Migrations..."
  npm run migration:run:internal
fi

if [ "$RUN_SEEDS" = "true" ]; then
  echo "▶ Running Seeds..."
  npm run seed:internal
fi

# ----------------------------------------------------------------
# Yalc Check
# ----------------------------------------------------------------
[ -d ".yalc/@kodus/flow" ] && echo "▶ yalc detected: using .yalc/@kodus/flow"

# ----------------------------------------------------------------
# Execute command
# ----------------------------------------------------------------
if [ $# -eq 0 ]; then
    exec nodemon --config nodemon.json
else
    echo "▶ Executing: $@"
    exec "$@"
fi
