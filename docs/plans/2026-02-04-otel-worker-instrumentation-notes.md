# OTel + Pyroscope + Worker Prod-like Simulation Notes

> Snapshot of changes made so we can resume later. No commits were created.

## 1) Pyroscope

**Enabled early in API and worker bootstrap**:
- `apps/api/src/main.ts`
- `apps/worker/src/main.ts`

Both call:
```ts
initPyroscope({ appName: 'kodus-api' | 'kodus-worker' });
```

**Pyroscope container (dev):**
- Service exists in `docker-compose.dev.yml` behind the `profiling` profile.
- Start with:
```bash
docker compose -f docker-compose.dev.yml --profile profiling up -d pyroscope
```

---

## 2) OTel (local collector, logs only)

### Files created
- `docker/otel-collector.yml`
- `docker-compose.otel.yml`

### Collector config (debug exporter)
```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

exporters:
  debug:
    verbosity: normal

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
```

### Compose override (opt-in)
```yaml
services:
  api:
    environment:
      OTEL_ENABLED: "true"
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318/v1/traces
  worker:
    environment:
      OTEL_ENABLED: "true"
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318/v1/traces
  otel-collector:
    image: otel/opentelemetry-collector:latest
    command: ["--config=/etc/otel-collector.yml"]
    volumes:
      - ./docker/otel-collector.yml:/etc/otel-collector.yml
    ports:
      - "4318:4318"
    networks:
      - kodus-backend-services
    restart: unless-stopped
```

### OTel bootstrap
Updated: `libs/core/infrastructure/config/log/otel-kodus-flow.ts`
- `startKodusOtel` now accepts `{ serviceName }`.
- Only sets `OTEL_SERVICE_NAME` if not already set.
- Added instrumentations: HTTP, Express, Nest, Pino.
- Uses OTLP HTTP exporter at `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318/v1/traces`).

### Entry points
Added optional enablement before bootstrap:
- `apps/api/src/main.ts`
- `apps/worker/src/main.ts`

```ts
if (process.env.OTEL_ENABLED === 'true') {
  void startKodusOtel({ serviceName: 'kodus-api' | 'kodus-worker' });
}
```

### Verification performed (API)
```bash
docker compose -f docker-compose.dev.yml -f docker-compose.otel.yml up -d otel-collector api worker
curl http://localhost:3001/health

docker logs kodus-ai-otel-collector-1 | tail -n 80
```
Result: spans logged for `service.name=kodus-api`.

### Worker spans
Not observed yet because worker only emits spans when executing jobs (no HTTP server). Need a real job to confirm `service.name=kodus-worker` in logs.

### Note about old collector errors
The collector logs can show old errors about `logging` exporter. They are from the earlier config. Restart the collector to clean:
```bash
docker compose -f docker-compose.dev.yml -f docker-compose.otel.yml restart otel-collector
```

---

## 3) Worker prod-like simulation (opt-in)

**File created:** `docker-compose.worker-prodlike.yml`

```yaml
services:
  worker:
    cpus: "3.0"
    mem_limit: "13g"
    environment:
      NODE_OPTIONS: --max-old-space-size=11264 --max-semi-space-size=64
      NODE_ENV: production
      API_DEVELOPMENT_MODE: "false"
    command: yarn start:prod:worker
```

**Usage:**
```bash
yarn build:worker

docker compose -f docker-compose.dev.yml -f docker-compose.worker-prodlike.yml up -d worker
```

---

## 4) Test file (ignored by git)

A test was created but is **ignored** due to `.gitignore` matching `__tests__`:
- `libs/core/infrastructure/config/log/__tests__/otel-kodus-flow.spec.ts`

If you want to stash it, use:
```bash
git stash push -a -m "otel-test" -- libs/core/infrastructure/config/log/__tests__/otel-kodus-flow.spec.ts
```

---

## 5) Files changed due to OTel/Pyroscope/prod-like worker

Tracked modifications:
- `apps/api/src/main.ts`
- `apps/worker/src/main.ts`
- `libs/core/infrastructure/config/log/otel-kodus-flow.ts`

Untracked files:
- `docker-compose.otel.yml`
- `docker/otel-collector.yml`
- `docker-compose.worker-prodlike.yml`
- `libs/core/infrastructure/config/log/__tests__/otel-kodus-flow.spec.ts` (ignored)

---

## 6) Suggested stash commands

Stash only OTel/Pyroscope/prod-like changes (tracked + untracked):
```bash
git stash push -u -m "otel+pyroscope+worker-prodlike" -- \
  apps/api/src/main.ts \
  apps/worker/src/main.ts \
  libs/core/infrastructure/config/log/otel-kodus-flow.ts \
  docker-compose.otel.yml \
  docker/otel-collector.yml \
  docker-compose.worker-prodlike.yml
```

Include ignored test file:
```bash
git stash push -a -m "otel-test" -- \
  libs/core/infrastructure/config/log/__tests__/otel-kodus-flow.spec.ts
```

---

## 7) Next step to analyze worker bottlenecks

To see worker spans, trigger a real job (PR code review). Then check collector logs for `service.name=kodus-worker`.

