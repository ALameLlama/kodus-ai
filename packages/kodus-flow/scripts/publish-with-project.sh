#!/usr/bin/env bash

# Script para publicar com projectId específico
# Uso: ./scripts/publish-with-project.sh [PROJECT_ID]

PROJECT_ID=$1

if [ -z "$PROJECT_ID" ]; then
    echo "❌ Project ID não fornecido"
    echo "   Uso: $0 [PROJECT_ID]"
    echo "   Exemplo: $0 kodus-infra-prod"
    exit 1
fi

echo "🚀 Publicando com Project ID: $PROJECT_ID"

# Renovar token com projectId
source scripts/refresh-token.sh "$PROJECT_ID"

# Configurar .npmrc para publicação
echo "🔑 Configurando autenticação..."
./scripts/manage-npmrc.sh publish "$PROJECT_ID"
echo "//us-central1-npm.pkg.dev/$PROJECT_ID/kodus-pkg/:_authToken=$NPM_TOKEN" >> .npmrc

# Build e publicar (com variável de ambiente definida)
GAR_PROJECT_ID=$PROJECT_ID yarn build && yarn lint && npm publish --registry=https://us-central1-npm.pkg.dev/$PROJECT_ID/kodus-pkg/ --access public

# Limpar .npmrc (remover linha de autenticação e restaurar)
echo "🧹 Limpando configuração..."
sed -i.bak '/_authToken/d' .npmrc
./scripts/manage-npmrc.sh restore

echo "✅ Publicação concluída!"
