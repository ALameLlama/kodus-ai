# 🚀 Kodus AI - Quick Setup Guide

This guide will help you get Kodus AI running on your local machine in just a few minutes.

## Prerequisites

- Node.js (LTS version)
- Yarn or NPM
- Docker
- OpenSSL (usually pre-installed on macOS/Linux)

## Quick Start (Recommended)

For first-time setup, simply run:

```bash
yarn setup
```

This automated script will:
- ✅ Check all dependencies
- 📦 Install project dependencies
- 🔧 Create and configure your `.env` file
- 🔐 Generate secure keys automatically
- 🐳 Set up Docker networks
- 🚀 Start all services
- 📊 Run database migrations
- 🌱 Seed initial data

## Manual Configuration

If you prefer manual setup or need to customize settings:

1. **Install dependencies:**
   ```bash
   yarn install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   ```

3. **Add your OpenAI API key to `.env`:**
   ```env
   API_OPEN_AI_API_KEY=your_api_key_here
   ```

4. **Start services:**
   ```bash
   yarn dev:quick-start
   ```

### Conectar aos bancos de QA/Prod

1. Gere o arquivo de variáveis do ambiente desejado (`aws ssm` requerido):
   ```bash
   ./scripts/dev/fetch-env-qa.sh qa    # ou ./scripts/dev/fetch-env-prod.sh prod
   ```
2. Suba os serviços (por padrão o compose usa o `.env` da raiz). Se preferir outro arquivo, exporte `ENV_FILE` antes do comando:
   ```bash
   docker compose -f docker-compose.dev.yml up
   # ou, para usar o arquivo baixado via fetch:
   ENV_FILE=.env.qa docker compose -f docker-compose.dev.yml up
   ```
3. Caso queira incluir os bancos locais no mesmo comando, habilite o perfil `local-db`:
   ```bash
   ENV_FILE=.env.qa docker compose --profile local-db -f docker-compose.dev.yml up
   ```
   Esse perfil também sobe o RabbitMQ local para desenvolvimento.
   O perfil pode ser combinado com `down`, `logs` e demais subcomandos do Docker Compose.
   Se estiver usando apenas o `.env` principal, remova o prefixo `ENV_FILE=...`.

> Prefere um atalho? Rode `yarn docker:start:env qa` ou `yarn docker:start:env prod` para ajustar `API_DATABASE_ENV` e subir o compose (usando o `.env` por padrão).

> Preferindo manter apenas o `.env`, defina manualmente as credenciais remotas e exporte `API_DATABASE_ENV=production` ou `API_DATABASE_ENV=homolog` antes de subir:
> ```bash
> API_DATABASE_ENV=production docker compose -f docker-compose.dev.yml up
> ```
> Assim o serviço usa os hosts remotos mesmo carregando o `.env` padrão.

## Available Scripts

| Command | Description |
|---------|-------------|
| `yarn setup` | Complete first-time setup |
| `yarn dev:health-check` | Verify all services are running |
| `yarn dev:quick-start` | Start services and run health check |
| `yarn dev:restart` | Restart all services |
| `yarn dev:stop` | Stop all services |
| `yarn dev:logs` | View service logs |
| `yarn dev:clean` | Clean restart (removes Docker cache) |

## Health Check

To verify everything is working:

```bash
yarn dev:health-check
```

## Service Endpoints

Once running, you can access:

- **API Health:** http://localhost:3331/health
- **API Base:** http://localhost:3331
- **RabbitMQ Management UI:** http://localhost:15672 (default user/pass: `dev` / `devpass`)

## Troubleshooting

If you encounter issues:

1. **Check service status:**
   ```bash
   yarn dev:health-check
   ```

2. **View logs:**
   ```bash
   yarn dev:logs
   ```

3. **Clean restart:**
   ```bash
   yarn dev:clean
   ```

4. **Manual container check:**
   ```bash
   docker ps
   ```

## Getting API Keys

- **OpenAI:** https://platform.openai.com/api-keys
- **Google AI:** https://cloud.google.com/docs/authentication/api-keys
- **Anthropic:** https://docs.anthropic.com/claude/reference/getting-started-with-the-api

## Need Help?

If you're still having trouble, check our [full documentation](./CONTRIBUTING.md) or open an issue.
