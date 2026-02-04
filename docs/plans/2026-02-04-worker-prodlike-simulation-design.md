# Worker Prod-Like Simulation (Dev) Design

## Context
We want to reproduce production-like performance characteristics for the worker in dev. The target is **3 vCPU / 12.977 GiB** with Node heap configured similarly to production, while keeping the default dev flow unchanged unless explicitly requested.

## Goals
- Simulate production-like CPU and memory limits for the worker in dev.
- Align Node heap sizing with production expectations (~85% of memory).
- Keep the default `docker compose -f docker-compose.dev.yml ...` behavior unchanged.
- Provide a clear, repeatable command for running the worker in prod-like mode.

## Non-Goals
- No changes to the default dev compose file behavior.
- No changes to API/webhooks in this iteration.
- No code-level performance optimizations yet; this is only about runtime simulation.

## Proposed Approach
Add a **compose override file** that is applied only when explicitly passed. This file will:
- Set cgroup limits for CPU and memory.
- Override `NODE_OPTIONS` to match a prod-like heap size.
- Run the worker in production mode (compiled output), avoiding watch/webpack overhead.

This yields a more faithful runtime profile under load while remaining opt-in.

## Compose Override Details
New file (example): `docker-compose.worker-prodlike.yml`.

Key settings:
- `cpus: "3.0"`
- `mem_limit: "13g"` (approximate 12.977 GiB)
- `NODE_OPTIONS: --max-old-space-size=11264 --max-semi-space-size=64`
  - 11 GiB heap is ~85% of 13 GiB.
- `NODE_ENV: production`
- `API_DEVELOPMENT_MODE: "false"`
- `command: yarn start:prod:worker`

## Data Flow / Runtime Behavior
- The worker runs from compiled JS (`dist/apps/worker/main.js`).
- No webpack/watch overhead; CPU/memory profile is closer to prod.
- cgroup limits ensure the container experiences realistic memory pressure.

## Error Handling / Failure Modes
- If `dist` is missing, the worker will fail to start; the user should run `yarn build:worker` first.
- If resources are insufficient on the host, the container may OOM or throttle.

## Validation
- `docker stats` shows container capped at 3 vCPU / ~13 GiB.
- Worker starts successfully and processes jobs under expected load.
- Pyroscope or other profilers show stable, repeatable performance signals.

## Risks / Trade-offs
- Running in prod mode removes hot reload; iteration speed is slower.
- Heap size tuning is approximate and may differ from prod cgroup behavior.

## Usage
```
docker compose -f docker-compose.dev.yml -f docker-compose.worker-prodlike.yml up -d worker
```

Optional cleanup:
```
docker compose -f docker-compose.dev.yml -f docker-compose.worker-prodlike.yml down
```
