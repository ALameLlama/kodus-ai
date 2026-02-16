# Docker Scripts (Current)

This document reflects the current Docker workflow in the monorepo.

## Default Compose File

All root Docker scripts use:

- `docker-compose.dev.yml`

There is no active `docker-compose.dev.small.yml` split in the current setup.

## Main Commands

```bash
yarn docker:start      # down + up local profile (backend + web + local-db profile)
yarn docker:start:fg   # same as above, foreground
yarn docker:up         # docker compose --profile local-db up -d --build
yarn docker:down       # stop/remove containers
yarn docker:logs       # logs for api/worker/webhooks
yarn docker:logs:all   # compose logs for all services
```

## Environment-aware Start

Use:

```bash
yarn docker:start:env local
yarn docker:start:env qa
yarn docker:start:env prod
```

Script path: `scripts/docker/docker-start-env.sh`

- `local` uses `--profile local-db` and `API_DATABASE_ENV=development`
- `qa` uses `API_DATABASE_ENV=homolog`
- `prod` uses `API_DATABASE_ENV=production`

By default, all modes read `.env` (or `ENV_FILE` when provided).

## Monorepo Note

Web is in `apps/web` and is part of the same compose file.
Deploys can still be separated by dedicated CI/CD workflows and tag conventions.
