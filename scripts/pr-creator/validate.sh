#!/usr/bin/env bash

# Script de validação do PR Creator

echo "🔍 Validando Kodus PR Creator\n"

# 1. Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js não encontrado. Instale: https://nodejs.org"
    exit 1
fi
NODE_VERSION=$(node -v)
echo "✅ Node.js: $NODE_VERSION"

# 2. Check npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm não encontrado"
    exit 1
fi
echo "✅ npm instalado"

# 3. Check node-fetch
if [ ! -d "node_modules/node-fetch" ]; then
    echo "⚠️  node-fetch não instalado. Rodando npm install..."
    npm install
    if [ $? -ne 0 ]; then
        echo "❌ Falha ao instalar node-fetch"
        exit 1
    fi
fi
echo "✅ node-fetch instalado"

# 4. Check 1Password CLI
if ! command -v op &> /dev/null; then
    echo "⚠️  1Password CLI não encontrado. Instale: https://developer.1password.com/docs/cli/get-started"
    echo "   Você pode continuar, mas precisará configurar os tokens manualmente"
else
    echo "✅ 1Password CLI instalado"
    # Check se está logado
    if op account list &> /dev/null; then
        echo "✅ 1Password CLI autenticado"
    else
        echo "⚠️  1Password CLI não está logado. Execute: eval \$(op signin)"
    fi
fi

# 5. Check syntax script
if ! node --check create-test-prs.mjs &> /dev/null; then
    echo "❌ Erro de sintaxe no script create-test-prs.mjs"
    exit 1
fi
echo "✅ Script syntax is valid"

# 6. Check .env
if [ ! -f ".env" ]; then
    echo ""
    echo "⚠️  Arquivo .env não encontrado"
    echo "📝 Criando .env a partir de .env.example..."
    cp .env.example .env
    echo ""
    echo "⚠️  Configure o arquivo .env com suas credenciais:"
    echo "   nano .env"
else
    echo "✅ Arquivo .env existe"

    # Check .env required fields
    source .env
    if [ -z "$KODUS_EMAIL" ] || [ "$KODUS_EMAIL" = "seu@email.com" ]; then
        echo ""
        echo "⚠️  Configure KODUS_EMAIL no .env"
    else
        echo "✅ KODUS_EMAIL configurado"
    fi

    if [ -z "$KODUS_PASSWORD" ] || [ "$KODUS_PASSWORD" = "sua-senha" ]; then
        echo "⚠️  Configure KODUS_PASSWORD no .env"
    else
        echo "✅ KODUS_PASSWORD configurado"
    fi
fi

echo ""
echo "📋 Resumo do que configurar:"
echo ""
echo "1. Editar o .env:"
echo "   nano .env"
echo ""
echo "2. Configurar:"
echo "   - KODUS_EMAIL (obrigatório)"
echo "   - KODUS_PASSWORD (obrigatório)"
echo "   - TOTAL_PRS (opcional, padrão: 10)"
echo "   - TARGET_BRANCH (opcional, padrão: main)"
echo ""
echo "3. Configurar tokens no 1Password (ou desativar Sync Forks):"

# Detectar quais plataformas a org usa
if [ -f ".env" ]; then
    source .env
    echo "   Execute o script primeiro para detectar as plataformas"
else
    echo "   O script detectará automaticamente quais plataformas usar"
fi

echo ""
echo "Tokens padrão no 1Password:"
echo "   - GitHub Token (para repos GitHub)"
echo "   - GitLab Token (para repos GitLab)"
echo "   - Bitbucket Token (para repos Bitbucket)"
echo "   - Azure Devops Token (para repos Azure DevOps)"
echo ""
echo "   Cada token deve ser um item tipo Password com:"
echo "   - Label: password"
echo "   - Valor: Seu access token da plataforma"
echo ""

echo "🚀 Para rodar o script:"
echo "   ./run.sh"
echo ""
