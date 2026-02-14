<p align="center">
  <img alt="koduslogo" src="https://kodus.io/wp-content/uploads/2025/04/kodusweb.png">
</p>

<p align="center">
  <a href="https://kodus.io" target="_blank">Website</a>
  ·
  <a href="https://discord.gg/6WbWrRbsH7" target="_blank">Community</a>
  ·
  <a href="https://docs.kodus.io" target="_blank">Docs</a>
  ·
  <a href="https://app.kodus.io" target="_blank"><strong>Try Kodus Cloud »</strong></a>
</p>

<p align="center">
   <a href="https://github.com/kodustech/kodus-ai" target="_blank"><img src="https://img.shields.io/github/stars/kodustech/kodus-ai" alt="Github Stars"></a>
   <a href="../../license.md"><img src="https://img.shields.io/badge/license-AGPLv3-red" alt="License"></a>
</p>

<h3 align="center">A modern interface for managing Kodus code reviews.</h3>

<br/>

## About

Kodus Web is the Next.js frontend for Kodus. In this repository it lives in `apps/web` and is developed/deployed independently from backend pipelines.

## Local Development (Monorepo)

### Prerequisites

- Node.js 22.x
- Yarn 1.x

### Run only web (without Docker)

From repository root:

```bash
yarn web:install
yarn web:dev
```

Or from `apps/web`:

```bash
yarn install
yarn start:dev
```

### Run full stack with Docker (backend + web)

From repository root:

```bash
yarn docker:start
```

Web will be available at `http://localhost:3000`.

## Scripts (`apps/web/package.json`)

- `yarn start:dev`: start Next.js in dev mode
- `yarn build`: build production bundle
- `yarn start`: run production server
- `yarn lint`: run ESLint
- `yarn check-types`: run TypeScript checks

## CI/CD

- PR checks: `.github/workflows/web-tests.yml`
- QA deploy: `.github/workflows/web-qa-deploy.yml`
- Production image build/push: `.github/workflows/web-build-push-production.yml`
- Manual production deploy: `.github/workflows/web-deploy-to-prod.yml`
