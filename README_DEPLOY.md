# Deploy (Backend + Web)

Este monorepo possui pipelines separados para backend e web, mantendo deploy independente por serviço.

## Imagens Docker

### Backend (`docker/Dockerfile`)

- `api` -> `node dist/apps/api/main.js`
- `webhooks` -> `node dist/apps/webhooks/main.js`
- `worker` -> `node dist/apps/worker/main.js`

Build local:

```bash
docker build -f docker/Dockerfile --target api -t kodus-api:local .
docker build -f docker/Dockerfile --target webhooks -t kodus-webhooks:local .
docker build -f docker/Dockerfile --target worker -t kodus-worker:local .
```

### Web (`docker/Dockerfile.web`)

Build local:

```bash
docker build -f docker/Dockerfile.web -t kodus-web:local apps/web
```

## Roteamento de release/tag

- Backend PROD (GitOps): tags semver `x.y.z` (ex.: `1.0.0`)
- Web PROD (cloud): tags `web-x.y.z` (ex.: `web-1.0.2`)
- Self-hosted: workflow dedicado que builda/publisha tudo junto

## CI/CD (GitHub Actions)

### Backend

- QA: `.github/workflows/qa-build-push-and-pr-green.yml`
- PROD: `.github/workflows/prod-build-push-and-pr-green.yml`
- PR checks: `.github/workflows/tests.yml`

### Web

- QA: `.github/workflows/web-qa-deploy.yml`
- PROD build/push: `.github/workflows/web-build-push-production.yml`
- PROD deploy manual no servidor: `.github/workflows/web-deploy-to-prod.yml`
- PR checks: `.github/workflows/web-tests.yml`

### Preview (PR)

- Deploy preview web+backend: `.github/workflows/preview-deploy.yml`
- Cleanup preview: `.github/workflows/preview-cleanup.yml`

### Self-hosted

- Build/publish de api + webhooks + worker + web: `.github/workflows/selfhosted-build-push.yml`

## Backend GitOps (infra repo)

### Variables (Actions -> Variables)

- `ECR_REPOSITORY_API`
- `ECR_REPOSITORY_WEBHOOKS`
- `ECR_REPOSITORY_WORKER`
- `INFRA_REPO` (ex.: `kodustech/kodus-infra`)
- `INFRA_BASE_BRANCH` (ex.: `main`)
- `INFRA_TFVARS_PATH`
- `INFRA_GITHUB_APP_ID`

### Secrets (Actions -> Secrets)

- `AWS_REGION`
- `AWS_ROLE_TO_ASSUME`
- `INFRA_GITHUB_APP_PRIVATE_KEY`

## Web (cloud) - variáveis/secrets típicas

Os workflows de web (`web-qa-deploy.yml`, `web-build-push-production.yml`) usam:

- AWS credentials/region para ECR/SSM
- parâmetros SSM em `/qa/kodus-web/*` e `/prod/kodus-web/*`
- secrets de SSH no deploy manual de produção

## Self-hosted (compose)

`docker-compose.prod.yml` sobe backend + web via imagens GHCR:

```bash
ENV_FILE=.env.prod docker compose -f docker-compose.prod.yml up -d
```
