#!/usr/bin/env bash

# Script para renovar token de autenticação do Google Artifact Registry
# Token é usado apenas durante publicação, não fica persistido

# Verificar se gcloud está instalado
if ! command -v gcloud &> /dev/null; then
    echo "❌ gcloud CLI não encontrado. Instale em: https://cloud.google.com/sdk/docs/install"
    exit 1
fi

# Verificar se está autenticado
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | grep -q .; then
    echo "❌ Não autenticado no gcloud. Execute: gcloud auth login"
    exit 1
fi

# Obter Project ID (pode ser passado como parâmetro ou usar o configurado)
PROJECT_ID=${1:-$(gcloud config get-value project)}
if [ -z "$PROJECT_ID" ]; then
    echo "❌ Project ID não configurado"
    echo "   Uso: $0 [PROJECT_ID]"
    echo "   Ou configure: gcloud config set project SEU_PROJECT_ID"
    exit 1
fi

# Gerar novo token (não persistir)
TOKEN=$(gcloud auth print-access-token)

# Exportar variáveis de ambiente apenas para esta sessão
export NPM_TOKEN=$TOKEN
export GAR_PROJECT_ID=$PROJECT_ID

echo "✅ Token renovado para publicação: $(echo $TOKEN | cut -c1-8)..."
echo "📦 Registry: https://us-central1-npm.pkg.dev/$PROJECT_ID/kodus-pkg/"
echo "🔑 Project ID: $PROJECT_ID"
echo "🔒 Token será usado apenas para esta sessão"
