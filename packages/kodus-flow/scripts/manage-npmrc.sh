#!/usr/bin/env bash

# Script para gerenciar .npmrc dinamicamente
# Uso: ./scripts/manage-npmrc.sh [dev|publish|restore]

MODE=$1

case $MODE in
    "dev")
        echo "🔧 Configurando .npmrc para desenvolvimento..."
        # Comentar a linha problemática para desenvolvimento
        sed -i.bak 's/^@kodus:registry=/# @kodus:registry=/' .npmrc
        echo "✅ .npmrc configurado para desenvolvimento"
        ;;
    "publish")
        PROJECT_ID=$2
        if [ -z "$PROJECT_ID" ]; then
            echo "❌ Project ID não fornecido"
            echo "   Uso: $0 publish [PROJECT_ID]"
            exit 1
        fi
        echo "🚀 Configurando .npmrc para publicação..."
        # Descomentar e substituir variável
        sed -i.bak "s/^# @kodus:registry=/@kodus:registry=/" .npmrc
        sed -i.bak "s/\${GAR_PROJECT_ID}/$PROJECT_ID/g" .npmrc
        echo "✅ .npmrc configurado para publicação com Project ID: $PROJECT_ID"
        ;;
    "restore")
        echo "🔄 Restaurando .npmrc original..."
        # Restaurar variável e comentar novamente
        sed -i.bak "s/kodus-infra-[a-zA-Z0-9-]*/\${GAR_PROJECT_ID}/g" .npmrc
        sed -i.bak 's/^@kodus:registry=/# @kodus:registry=/' .npmrc
        echo "✅ .npmrc restaurado"
        ;;
    *)
        echo "❌ Modo não reconhecido"
        echo "   Uso: $0 [dev|publish PROJECT_ID|restore]"
        echo "   Exemplos:"
        echo "     $0 dev                    # Para desenvolvimento"
        echo "     $0 publish kodus-infra-prod  # Para publicação"
        echo "     $0 restore                # Para restaurar"
        exit 1
        ;;
esac 