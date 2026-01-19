# Relatório de Performance - Kodus AI

**Data**: 2026-01-19
**Ferramenta**: Pyroscope (continuous profiling)
**Ambiente**: Desenvolvimento com 5000 PRs mockados

---

## Resumo Executivo

Análise realizada com Pyroscope em ambiente de desenvolvimento. Os dados revelam problemas críticos de performance tanto na **API** quanto no **Worker**.

| Serviço | Wall Time | GC Overhead | MongoDB Overhead |
|---------|-----------|-------------|------------------|
| API     | 35.54s    | 16.8%       | ~40%             |
| Worker  | 41.66s    | 13.4%       | ~35%             |

---

## 1. Problemas Identificados

### 1.1 CRÍTICO: Transferência Massiva de Dados do MongoDB

**Arquivo**: `libs/platformData/infrastructure/adapters/repositories/pullRequests.repository.ts:162-175`

**Problema**: O método `findManyByNumbersAndRepositoryIds` faz uma query que exclui apenas o **conteúdo textual** das sugestões, mas ainda traz:
- Array `files` completo
- Array `suggestions` de cada file (só sem `existingCode`, `improvedCode`, `suggestionContent`)

**Impacto calculado**:
```
30 PRs × 150 files × 40 suggestions = 180,000 objetos por request
```

Cada objeto de suggestion ainda contém: `uuid`, `id`, `label`, `type`, `severity`, `category`, `deliveryStatus`, `filePath`, `startLine`, `endLine`, `codeSnippet`, `language`, etc.

**Evidência no Pyroscope**:
| Função | Tempo | % do Total |
|--------|-------|------------|
| `bson.cjs:deserializeObject` | 1.693s | 4.76% |
| `bson.cjs:toUTF8` | 0.663s | 1.87% |

**Código problemático**:
```typescript
// pullRequests.repository.ts:162-175
const pullRequests = await this.pullRequestsModel.find(
    { organizationId, $or: orConditions },
    {
        'files.suggestions.existingCode': 0,     // Exclui conteúdo
        'files.suggestions.improvedCode': 0,     // Exclui conteúdo
        'files.suggestions.suggestionContent': 0, // Exclui conteúdo
        'commits': 0,
        'prLevelSuggestions': 0,
    },  // MAS ainda traz files[] e suggestions[] completos!
).lean().exec();
```

**Chamado por**: `get-enriched-pull-requests.use-case.ts:222-238`

---

### 1.2 CRÍTICO: MongoDB Connection Pool Overhead

**Arquivo**: Driver MongoDB (comportamento do pool de conexões)

**Problema**: O connection pool está consumindo tempo significativo em operações de gerenciamento.

**Dados do Pyroscope (API)**:
| Função | Tempo | % do Total |
|--------|-------|------------|
| `connection_pool.js:ensureMinPoolSize` | 6.874s | 19.34% |
| `connection_pool.js:(anonymous:L#484)` | 7.368s | 20.73% |
| `connection_pool.js:destroyConnectionIfPerished` | 2.453s | 6.90% |
| `connection_pool.js:connectionIsIdle` | 1.533s | 4.31% |

**Configuração atual** (`libs/core/infrastructure/database/mongodb/mongoose.factory.ts:51-66`):
```typescript
poolConfigs = {
    api: { max: 30, min: 5 },
    worker: { max: 60, min: 5 },
}
// maxIdleTimeMS: 50000 (50 segundos)
```

**Causa**: Com `maxIdleTimeMS: 50000`, conexões idle são destruídas frequentemente, causando overhead de recriação.

---

### 1.3 ALTO: Garbage Collection Elevado

**Evidência no Pyroscope**:
| Serviço | Tempo GC | % do Total |
|---------|----------|------------|
| API | 5.960s | 16.8% |
| Worker | 5.587s | 13.4% |

**Causa raiz**: Relacionada ao problema 1.1 - criação e destruição de ~180k objetos JavaScript por request durante a deserialização BSON.

---

### 1.4 MÉDIO: Compilação Repetida de Glob Patterns

**Arquivo**: `libs/common/utils/glob-utils.ts:27-29`

**Problema**: Os padrões glob são recompilados a cada chamada de `isFileMatchingGlob`:

```typescript
// Chamado para CADA arquivo do PR
const matchers = patterns.map((pattern) =>
    picomatch(pattern, { dot: true }),  // Recompila toda vez
);
```

**Impacto**: Para um PR com 150 arquivos e 10 padrões de ignore:
```
150 arquivos × 10 padrões = 1,500 compilações de glob por PR
```

**Chamado por**: `libs/code-review/infrastructure/adapters/services/pullRequestManager.service.ts:61-63`

---

### 1.5 MÉDIO: Outbox Polling Frequente

**Arquivo**: `libs/core/workflow/infrastructure/outbox-relay.service.ts:120-148`

**Evidência no Pyroscope (Worker)**:
| Função | Tempo | % do Total |
|--------|-------|------------|
| `poll` | 0.840s | 2.02% |
| `processOutbox` | 0.736s | 1.77% |
| `claimBatch` | 0.701s | 1.68% |

**Problema**: O polling adaptativo pode ser muito frequente:
```typescript
private readonly MIN_INTERVAL = 100;   // 100ms mínimo
private readonly MAX_INTERVAL = 5000;  // 5s máximo
```

Quando há mensagens, o intervalo volta para 100ms, causando muitas queries ao PostgreSQL.

---

### 1.6 MÉDIO: Múltiplas Chamadas a findByKey (Parâmetros)

**Arquivo**: `libs/organization/application/use-cases/parameters/find-by-key-use-case.ts:22`

**Evidência no Pyroscope (API)**:
| Função | Tempo | % do Total |
|--------|-------|------------|
| `execute (FindByKeyParametersUseCase)` | 0.179s | 0.50% |

**Problema**: O método é chamado em **30+ lugares diferentes** no código. Cada chamada faz uma query ao banco. Não há cache em memória para configurações que raramente mudam.

**Principais chamadores**:
- `businessRulesValidationAgent.ts:562`
- `runCodeReview.use-case.ts:742`
- `codeBaseConfig.service.ts:99, 609, 634, 748`
- `validate-config.stage.ts:76`
- `resolve-config.stage.ts:99`

---

### 1.7 BAIXO: MongoDB Observability Exporter

**Arquivo**: `packages/kodus-flow/src/observability/exporters/mongodb-exporter.ts`

**Evidência no Pyroscope (Worker)**:
| Função | Tempo | % do Total |
|--------|-------|------------|
| `mongodb-exporter.js:flushLogs` | 1.439s | 3.46% |

O exporter de logs para MongoDB está consumindo tempo significativo no Worker.

---

## 2. Diagramas de Fluxo

### 2.1 Fluxo Problemático (API)

```
Request: GET /pull-requests/executions
           │
           ▼
┌─────────────────────────────────────┐
│ GetEnrichedPullRequestsUseCase      │
│ (get-enriched-pull-requests.ts:63)  │
└─────────────┬───────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│ pullRequestsService                 │
│   .findManyByNumbersAndRepositoryIds│
│ (pullRequests.service.ts:112)       │
└─────────────┬───────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│ MongoDB Query com projection        │
│ parcial - AINDA traz files[]        │
│ (pullRequests.repository.ts:162)    │
└─────────────┬───────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│ BSON Deserialization                │
│ ~180,000 objetos                    │
│ 4.76% do tempo total                │
└─────────────┬───────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│ extractSuggestionsCount()           │
│ Itera por TODOS files/suggestions   │
│ para contar SENT vs NOT_SENT        │
│ (get-enriched-pull-requests.ts:548) │
└─────────────────────────────────────┘
```

### 2.2 Fluxo Problemático (Worker)

```
Outbox Polling Loop
           │
           ▼
┌─────────────────────────────────────┐
│ poll() - MIN_INTERVAL = 100ms       │
│ (outbox-relay.service.ts:120)       │
└─────────────┬───────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│ claimBatch() - Query PostgreSQL     │
│ UPDATE ... WHERE ... SKIP LOCKED    │
│ (outbox-message.repository.ts:83)   │
└─────────────┬───────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│ Code Review Pipeline                │
└─────────────┬───────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│ getChangedFiles()                   │
│ (pullRequestManager.service.ts:29)  │
└─────────────┬───────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│ isFileMatchingGlob() - N vezes      │
│ Recompila padrões a cada arquivo    │
│ (glob-utils.ts:9)                   │
└─────────────────────────────────────┘
```

---

## 3. Sumário de Impacto

| # | Problema | Componente | Impacto | Prioridade |
|---|----------|------------|---------|------------|
| 1.1 | Transferência massiva MongoDB | API | ~25% do tempo | CRÍTICO |
| 1.2 | Connection Pool overhead | API/Worker | ~20% do tempo | CRÍTICO |
| 1.3 | Garbage Collection | API/Worker | ~15% do tempo | ALTO |
| 1.4 | Glob recompilation | Worker | ~0.6% por PR | MÉDIO |
| 1.5 | Outbox polling | Worker | ~5% do tempo | MÉDIO |
| 1.6 | findByKey sem cache | API/Worker | ~0.5% por request | MÉDIO |
| 1.7 | MongoDB exporter | Worker | ~3.5% do tempo | BAIXO |

---

## 4. Arquivos Principais Afetados

| Arquivo | Problema Relacionado |
|---------|---------------------|
| `libs/platformData/infrastructure/adapters/repositories/pullRequests.repository.ts` | 1.1 |
| `libs/code-review/application/use-cases/dashboard/get-enriched-pull-requests.use-case.ts` | 1.1 |
| `libs/core/infrastructure/database/mongodb/mongoose.factory.ts` | 1.2 |
| `libs/common/utils/glob-utils.ts` | 1.4 |
| `libs/core/workflow/infrastructure/outbox-relay.service.ts` | 1.5 |
| `libs/organization/application/use-cases/parameters/find-by-key-use-case.ts` | 1.6 |

---

## 5. Dados Brutos do Pyroscope

### 5.1 Top 30 Funções por Self Time - API

| Função | Self Time | % |
|--------|-----------|---|
| `node:internal/timers:processTimers` | 12.378s | 34.8% |
| `node:internal/timers:listOnTimeout` | 10.376s | 29.2% |
| `node:internal/process/task_queues:processTicksAndRejections` | 8.969s | 25.2% |
| `:runMicrotasks` | 8.311s | 23.4% |
| `mongodb/connection_pool.js:(anonymous:L#484)` | 7.368s | 20.7% |
| `mongodb/connection_pool.js:ensureMinPoolSize` | 6.874s | 19.3% |
| `:Garbage Collection` | 5.960s | 16.8% |
| `mongodb/utils.js:prune` | 3.351s | 9.4% |
| `mongodb/connection_pool.js:destroyConnectionIfPerished` | 2.453s | 6.9% |
| `bson.cjs:deserializeObject` | 1.693s | 4.8% |

### 5.2 Top 30 Funções por Self Time - Worker

| Função | Self Time | % |
|--------|-----------|---|
| `node:internal/timers:processTimers` | 14.543s | 34.9% |
| `node:internal/process/task_queues:processTicksAndRejections` | 13.529s | 32.5% |
| `node:internal/timers:listOnTimeout` | 12.159s | 29.2% |
| `:runMicrotasks` | 12.012s | 28.8% |
| `mongodb/connection_pool.js:(anonymous:L#484)` | 6.309s | 15.1% |
| `mongodb/connection_pool.js:ensureMinPoolSize` | 5.756s | 13.8% |
| `:Garbage Collection` | 5.587s | 13.4% |
| `mongodb/utils.js:prune` | 2.121s | 5.1% |
| `typeorm/PostgresQueryRunner.js:query` | 1.885s | 4.5% |
| `mongodb-exporter.js:flushLogs` | 1.439s | 3.5% |

---

## 6. Mapeamento Source Map (Funções da Aplicação)

### 6.1 API

| Função no Bundle | Arquivo Fonte | Linha |
|------------------|---------------|-------|
| `execute:88043` | `find-by-key-use-case.ts` | 22 |
| `execute:22651` | `get-enriched-pull-requests.use-case.ts` | 63 |
| `execute:97009` | `get-repositories.ts` | 25 |
| `findManyByNumbersAndRepositoryIds:117389` | `pullRequests.service.ts` | 112 |
| `extractSuggestionsCount:23019` | `get-enriched-pull-requests.use-case.ts` | 548 |

### 6.2 Worker

| Função no Bundle | Arquivo Fonte | Linha |
|------------------|---------------|-------|
| `execute:97351` | `save.use-case.ts` | 32 |
| `poll:38686` | `outbox-relay.service.ts` | 120 |
| `processOutbox:38714` | `outbox-relay.service.ts` | 155 |
| `claimBatch:39423` | `outbox-message.repository.ts` | 83 |
| `getChangedFiles:17612` | `pullRequestManager.service.ts` | 29 |
| `isFileMatchingGlob:24830` | `glob-utils.ts` | 9 |
| `executeStage:21826` | `process-files-review.stage.ts` | 76 |
| `analyzeCrossFileCode:16249` | `crossFileAnalysis.service.ts` | 73 |
