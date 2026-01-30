#!/usr/bin/env bash

# Script para limpar configurações antigas do .npmrc
# Uso: ./scripts/cleanup-npmrc.sh [PROJECT_ID]

PROJECT_ID=${1:-kodus-infra-prod}

echo "🧹 Limpando configurações antigas do .npmrc..."

# Backup do .npmrc atual (se existir)
if [ -f .npmrc ]; then
    cp .npmrc .npmrc.backup.$(date +%Y%m%d_%H%M%S)
    echo "✅ Backup criado: .npmrc.backup.*"
fi

# Criar .npmrc limpo e unificado
cat > .npmrc << EOF
# Google Artifact Registry Configuration
# Configuração unificada para todos os pacotes @kodus/*
@kodus:registry=https://us-central1-npm.pkg.dev/$PROJECT_ID/kodus-pkg/

# Fallback para npm público (para outras dependências)
registry=https://registry.npmjs.org/

# Configurações de segurança
audit-level=moderate
fund=false
EOF

echo "✅ .npmrc limpo e configurado!"
echo "📦 Registry unificado: https://us-central1-npm.pkg.dev/$PROJECT_ID/kodus-pkg/"
echo ""
echo "🔄 Configurações removidas:"
echo "   ❌ kodus-common (antigo)"
echo "   ❌ _authToken (desnecessário para consumo)"
echo "   ❌ @kodus/flow:registry (específico desnecessário)"
echo ""
echo "✅ Configurações adicionadas:"
echo "   ✅ @kodus:registry (unificado para todos os pacotes @kodus/*)"
echo "   ✅ registry fallback (para outras dependências)"
echo "   ✅ Configurações de segurança"
echo ""
echo "🚀 Agora você pode instalar os pacotes:"
echo "   npm install @kodus/flow @kodus/kodus-common"
echo "   yarn add @kodus/flow @kodus/kodus-common"
