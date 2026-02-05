# OpenAPI Controller Audit

Checklist de auditoria endpoint a endpoint (entrada, retorno e erros).

Formato: preencher Input/Output/Errors por endpoint, sem alterar comportamento.

## Global Response Wrapper

HTTP responses (exceto `StreamableFile`) são envolvidas por `TransformInterceptor`:

`{ data, statusCode, type }`, onde `type` é o resultado de `ramda type()`.

Regras adicionais:
- `undefined` → resposta `204 No Content`
- `null` → resposta `404 Not Found`

## AgentController

File: `apps/api/src/controllers/agent.controller.ts`

Base Path: `/agent`

Tag: `Agent`

Auth: `Bearer`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/agent/conversation` | `conversation` | Body: `{ prompt: string, organizationAndTeamData: { teamId?: string, organizationId?: string } }` (inline type, sem validação) | `string` (texto/JSON string retornado pelo agent) | 401/403, 500 (organizationId ausente ou erro no agent) | Documentado com `@ApiOkResponse` schema `string` |

## AuthController

File: `apps/api/src/controllers/auth.controller.ts`

Base Path: `/auth`

Tag: `Auth`

Auth: `Mixed`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/auth/login` | `login` | Body: `{ email, password }` | 201 → `{ data: { accessToken, refreshToken }, statusCode: 201, type: "Object" }` | 401 (`api.users.unauthorized`) | Public |
| POST | `/auth/logout` | `logout` | Body: `{ refreshToken }` | 201 → `{ data: { uuid, createdAt, updatedAt, refreshToken, expiryDate, used, authDetails, authProvider }, statusCode: 201, type: "Object" }` | 401 (guard) | Bearer |
| POST | `/auth/refresh` | `refresh` | Body: `{ refreshToken }` | 201 → `{ data: { accessToken, refreshToken }, statusCode: 201, type: "Object" }` | 401 (`Refresh token is invalid or has expired`) | Public |
| POST | `/auth/signUp` | `signUp` | Body: `SignUpDTO` | Não observado (400 em validação) | 400 | Public |
| POST | `/auth/forgot-password` | `forgotPassword` | Body: `{ email }` | 201 → `{ data: { message: "Reset link sent." }, statusCode: 201, type: "Object" }` | 500 | Public |
| POST | `/auth/reset-password` | `resetPassword` | Body: `{ token, newPassword }` | 201 → `{ data: { response, status, options, message, name }, statusCode: 201, type: "Error" }` | 500 | Public |
| POST | `/auth/confirm-email` | `confirmEmail` | Body: `{ token }` | Não observado (500) | 500 | Public |
| POST | `/auth/resend-email` | `resendEmail` | Body: `{ email }` | 201 → `{ data: { message: "Email sent successfully" }, statusCode: 201, type: "Object" }` | 500 | Public |
| POST | `/auth/oauth` | `oAuth` | Body: `CreateUserOrganizationOAuthDto` | 201 → `{ data: { accessToken, refreshToken }, statusCode: 201, type: "Object" }` | 400 | Public |
| GET | `/auth/sso/check` | `checkSSO` | Query: `domain` | 200 → `{ data: { active, organizationId }, statusCode: 200, type: "Object" }` | 500 | Public |
| GET | `/auth/sso/login/:organizationId` | `ssoLogin` | Param: `organizationId` | Guard SAML (500 observado) | 500 | Public |
| POST | `/auth/sso/saml/callback/:organizationId` | `ssoCallback` | Param: `organizationId` + SAML profile | Redirect (cookie `sso_handoff`) (500 observado) | 500 | Public |

## CliReviewController

File: `apps/api/src/controllers/cli-review.controller.ts`

Base Path: `/cli`

Tag: `CLI Review`

Auth: `Public`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/cli/validate-key` | `validateKey` | Header: `x-team-key` ou `Authorization: Bearer <team-key>` | `CliValidateKeyResponseDto` (payload + `data` duplicado) | 401 (payload com `valid=false` e `error`) | Public |
| POST | `/cli/validate-key` | `validateKeyPost` | Header: `x-team-key` ou `Authorization: Bearer <team-key>` | `CliValidateKeyResponseDto` | 401 (payload com `valid=false` e `error`) | Public |
| POST | `/cli/review` | `review` | Body: `CliReviewRequestDto` + header `x-team-key`/`Authorization` | `CliReviewResponseDto` | 401, 403 (domínio não permitido), 429 (rate limit), 500 | Team key (não JWT) |
| POST | `/cli/trial/review` | `trialReview` | Body: `TrialCliReviewRequestDto` (inclui `fingerprint`) | `TrialCliReviewResponseDto` (inclui `rateLimit`) | 400 (fingerprint obrigatório), 429, 500 | Public (trial) |

## CodeBaseController

File: `apps/api/src/controllers/codeBase.controller.ts`

Base Path: `/code-base`

Tag: `Code Base`

Auth: `Bearer`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| - | - | - | N/A | N/A | N/A | Controller has no HTTP routes. |

## CodeManagementController

File: `apps/api/src/controllers/codeManagement.controller.ts`

Base Path: `/code-management`

Tag: `Code Management`

Auth: `Bearer`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/code-management/repositories/org` | `checkPermissions` | Query: `teamId`, `organizationSelected`, `isSelected?`, `page?`, `perPage?` | 200 → `{ data: [{ id, name, full_name, http_url, avatar_url, organizationName, default_branch, language, visibility, selected, lastActivityAt }], statusCode: 200, type: "Array" }` | 401/403, 400 (validação) | |
| GET | `/code-management/repositories/selected` | `checkPermissions` | Query: `teamId`, `page?`, `perPage?` | 200 → `{ data: [{ id, name, full_name, http_url, avatar_url, organizationName, default_branch, language, visibility, selected, lastActivityAt }], statusCode: 200, type: "Array" }` | 401/403, 400 | |
| POST | `/code-management/auth-integration` | `checkPermissions` | Body: integração (não observado) | Não observado (500 com payload vazio) | 401/403, 400, 500 | Requires GitHub OAuth or token-based integration (accounts for pentest should be connected). |
| POST | `/code-management/repositories` | `checkPermissions` | Body: `{ repositories, teamId, type? }` | 201 → `{ data: { status: true }, statusCode: 201, type: "Object" }` | 401/403, 400 | |
| GET | `/code-management/organization-members` | `checkPermissions` | Sem params | 200 → `{ data: [], statusCode: 200, type: "Array" }` | 401/403 | |
| GET | `/code-management/get-prs` | `checkPermissions` | Query: `teamId`, filtros | 200 → `{ data: [{ id, repository: { id, name }, pull_number, title, url }], statusCode: 200, type: "Array" }` | 401/403, 400 | |
| GET | `/code-management/get-prs-repo` | `checkPermissions` | Query: `teamId`, `repositoryId`, filtros | 200 → `{ data: [{ id, repository: { id, name }, pull_number, title, url }], statusCode: 200, type: "Array" }` | 401/403, 400 | Retorno observado vazio |
| POST | `/code-management/finish-onboarding` | `checkPermissions` | Body: `FinishOnboardingDTO` | 204 No Content (use case sem retorno; execução pode ser longa) | 401/403, 400 | Timeout >60s observado com payload válido |
| DELETE | `/code-management/delete-integration` | `checkPermissions` | Query: `teamId` | 204 No Content | 401/403, 400 | |
| DELETE | `/code-management/delete-integration-and-repositories` | `checkPermissions` | Query: `teamId` | 204 No Content | 401/403, 400 | |
| GET | `/code-management/get-repository-tree-by-directory` | `checkRepoPermissions` | Query: `teamId`, `repositoryId`, `directoryPath`, `useCache?` | 200 → `{ data: { repository, parentPath, currentPath, directories }, statusCode: 200, type: "Object" }` | 401/403, 400 | |
| GET | `/code-management/search-users` | `checkPermissions` | Query: `organizationId`, `teamId?`, `q?`, `userId?`, `limit?` | 200 → `{ data: { users: [{ id, name, username, email, avatarUrl, source }] }, statusCode: 200, type: "Object" }` | 401/403, 400 | |
| GET | `/code-management/current-user` | `checkPermissions` | Query: `organizationId`, `teamId?` | 200 → `{ data: { user: { id, name, username, email, avatarUrl, raw } }, statusCode: 200, type: "Object" }` | 401/403, 400 | |
| GET | `/code-management/webhook-status` | `getWebhookStatus` | Query: `organizationId`, `teamId`, `repositoryId` | 200 → `{ data: { active }, statusCode: 200, type: "Object" }` | 401/403, 400 | |

## CodeReviewSettingLogController

File: `apps/api/src/controllers/codeReviewSettingLog.controller.ts`

Base Path: `/user-log`

Tag: `Code Review Logs`

Auth: `Mixed`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/user-log/status-change` | `registerStatusChange` | Body: `UserStatusDto` | 204 No Content | - | Public |
| GET | `/user-log/code-review-settings` | `checkPermissions` | Query: `teamId?`, `action?`, `configLevel?`, `userId?`, `userEmail?`, `repositoryId?`, `startDate?`, `endDate?`, `page?`, `limit?`, `skip?` | 200 → `{ data: { logs: [ ... ], total, page, limit, totalPages }, statusCode: 200, type: "Object" }` | 401/403 | |

## DryRunController

File: `apps/api/src/controllers/dryRun.controller.ts`

Base Path: `/dry-run`

Tag: `Dry Run`

Auth: `Bearer`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/dry-run/execute` | `checkRepoPermissions` | Body: `{ teamId, repositoryId, prNumber }` | 201 → `{ data: "corr_*", statusCode: 201, type: "String" }` | 401/403, 400 | |
| GET | `/dry-run/status/:correlationId` | `checkPermissions` | Param: `correlationId` + Query: `teamId` | 200 → `{ data: "COMPLETED", statusCode: 200, type: "String" }` | 401/403, 404 | |
| SSE | `/dry-run/events/:correlationId` | `checkPermissions` | Param: `correlationId` + Query: `teamId` | 200 → `text/event-stream` (eventos `IDryRunEvent` do pipeline) | 401/403 | |
| GET | `/dry-run` | `checkPermissions` | Query: `teamId`, `repositoryId?`, `directoryId?`, `startDate?`, `endDate?`, `prNumber?`, `status?` | 200 → `{ data: [], statusCode: 200, type: "Array" }` | 401/403 | |
| GET | `/dry-run/:correlationId` | `checkPermissions` | Param: `correlationId` + Query: `teamId` | 200 → `{ data: { id, prNumber, provider, prTitle, repositoryId, repositoryName, status, files, prLevelSuggestions, createdAt, updatedAt, dependents, configHashes, messages, config, pullRequestMessages, description, events, directoryId }, statusCode: 200, type: "Object" }` | 401/403, 404 | |

## IntegrationController

File: `apps/api/src/controllers/integration.controller.ts`

Base Path: `/integration`

Tag: `Integration`

Auth: `Bearer`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/integration/clone-integration` | `checkPermissions` | Body: `{ teamId, teamIdClone, integrationData { platform, category } }` | 201 → `{ data: { status: boolean }, statusCode: 201, type: "Object" }` | 401/403/400 | |
| GET | `/integration/check-connection-platform` | `checkPermissions` | Query: (varia) | 200 → `{ data: boolean, statusCode: 200, type: "Boolean" }` | 401/403 | |
| GET | `/integration/organization-id` | `checkPermissions` | Sem params | 200 → `{ data: string, statusCode: 200, type: "String" }` | 401/403 | |
| GET | `/integration/connections` | `checkPermissions` | Query: `teamId` | 200 → `{ data: [], statusCode: 200, type: "Array" }` | 401/403 | |

## IntegrationConfigController

File: `apps/api/src/controllers/integrationConfig.controller.ts`

Base Path: `/integration-config`

Tag: `Integration Config`

Auth: `Bearer`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/integration-config/get-integration-configs-by-integration-category` | `checkPermissions` | Query: `integrationCategory`, `teamId` | 200 → `{ data: [], statusCode: 200, type: "Array" }` | 401/403 | |

## IssuesController

File: `apps/api/src/controllers/issues.controller.ts`

Base Path: `/issues`

Tag: `Issues`

Auth: `Bearer`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/issues` | `checkPermissions` | Query: filtros | 200 → `{ data: [], statusCode: 200, type: "Array" }` | 401/403 | |
| GET | `/issues/count` | `checkPermissions` | Query: filtros | 200 → `{ data: 0, statusCode: 200, type: "Number" }` | 401/403 | |
| GET | `/issues/:id` | `checkPermissions` | Param: `id` | Não observado (sem issues na org) | 401/403, 404 | |
| PATCH | `/issues/:id` | `checkPermissions` | Param: `id` + Body | Não observado (sem issues na org) | 401/403, 404 | |

## KodyRulesController

File: `apps/api/src/controllers/kodyRules.controller.ts`

Base Path: `/kody-rules`

Tag: `Kody Rules`

Auth: `Mixed`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/kody-rules/create-or-update` | `checkPermissions` | Body: `CreateKodyRuleDto` | 201 → `{ data: { uuid, title, rule, severity, status, origin, scope, inheritance, createdAt, updatedAt, ... }, statusCode: 201, type: "Object" }` | 401/403, 400 | |
| GET | `/kody-rules/find-by-organization-id` | `checkPermissions` | Sem params | 200 → `{ data: { _uuid, _organizationId, _rules: [rule], _createdAt, _updatedAt }, statusCode: 200, type: "Object" }` | 401/403 | |
| GET | `/kody-rules/limits` | `checkPermissions` | Sem params | 200 → `{ data: { total }, statusCode: 200, type: "Object" }` | 401/403 | |
| GET | `/kody-rules/suggestions` | `checkPermissions` | Query: `ruleId` | 200 → `{ data: [], statusCode: 200, type: "Array" }` | 401/403, 404 | |
| GET | `/kody-rules/find-rules-in-organization-by-filter` | `checkPermissions` | Query: `key`, `value`, `repositoryId?`, `directoryId?` | 200 → `{ data: [], statusCode: 200, type: "Array" }` | 401/403 | |
| DELETE | `/kody-rules/delete-rule-in-organization-by-id` | `checkPermissions` | Query: `ruleId` | 200 → `{ data: boolean, statusCode: 200, type: "Boolean" }` | 401/403 | |
| GET | `/kody-rules/find-library-kody-rules` | `findLibraryKodyRules` | Query: filtros | 200 → `{ data: { data: [rule], pagination }, statusCode: 200, type: "Object" }` | 400 | Public |
| GET | `/kody-rules/find-library-kody-rules-with-feedback` | `findLibraryKodyRulesWithFeedback` | Query: filtros | 200 → `{ data: { data: [rule], pagination }, statusCode: 200, type: "Object" }` | 401/403, 400 | |
| GET | `/kody-rules/find-library-kody-rules-buckets` | `findLibraryKodyRulesBuckets` | Sem params | 200 → `{ data: [{ slug, title, description, rulesCount }], statusCode: 200, type: "Array" }` | 400 | Public |
| GET | `/kody-rules/find-recommended-kody-rules` | `checkPermissions` | Query: `limit?` | 200 → `{ data: [], statusCode: 200, type: "Array" }` | 401/403 | |
| POST | `/kody-rules/add-library-kody-rules` | `checkPermissions` | Body: `AddLibraryKodyRulesDto` | 201 → `{ data: [rule], statusCode: 201, type: "Array" }` | 401/403, 400 | |
| POST | `/kody-rules/generate-kody-rules` | `checkPermissions` | Body: `GenerateKodyRulesDTO` | 201 → `{ data: [], statusCode: 201, type: "Array" }` | 401/403, 400 | |
| POST | `/kody-rules/change-status-kody-rules` | `checkPermissions` | Body: `ChangeStatusKodyRulesDTO` | 201 → `{ data: [rule], statusCode: 201, type: "Array" }` | 401/403, 400 | |
| GET | `/kody-rules/check-sync-status` | `checkPermissions` | Query: `teamId`, `repositoryId?` | 200 → `{ data: { ideRulesSyncEnabledFirstTime, kodyRulesGeneratorEnabledFirstTime }, statusCode: 200, type: "Object" }` | 401/403 | |
| POST | `/kody-rules/sync-ide-rules` | `checkPermissions` | Body: `{ teamId, repositoryId }` | 204 No Content | 401/403, 500 | |
| POST | `/kody-rules/fast-sync-ide-rules` | `checkPermissions` | Body: `{ teamId, repositoryId, maxFiles?, maxFileSizeBytes?, maxTotalBytes? }` | 201 → `{ data: { rules: [rule], skippedFiles: [], errors: [] }, statusCode: 201, type: "Object" }` | 401/403, 500 | |
| GET | `/kody-rules/pending-ide-rules` | `checkPermissions` | Query: `teamId`, `repositoryId?` | 200 → `{ data: [], statusCode: 200, type: "Array" }` | 401/403 | |
| POST | `/kody-rules/import-fast-ide-rules` | `checkPermissions` | Body: `ImportFastKodyRulesDto` | 201 → `{ data: [rule], statusCode: 201, type: "Array" }` | 401/403, 400 | |
| POST | `/kody-rules/review-fast-ide-rules` | `checkPermissions` | Body: `ReviewFastKodyRulesDto` | 201 → `{ data: {}, statusCode: 201, type: "Object" }` | 401/403, 500 | |
| GET | `/kody-rules/inherited-rules` | `checkRepoPermissions` | Query: `teamId`, `repositoryId`, `directoryId?` | 200 → `{ data: { globalRules: [rule], repoRules: [rule], directoryRules: [] }, statusCode: 200, type: "Object" }` | 401/403 | |
| POST | `/kody-rules/resync-ide-rules` | `checkPermissions` | Body: `{ teamId, repositoryId }` | 204 No Content | 401/403, 500 | |

## OrganizationController

File: `apps/api/src/controllers/organization.controller.ts`

Base Path: `/organization`

Tag: `Organization`

Auth: `Bearer`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/organization/name` | `getOrganizationName` | Sem params | 200 → `{ data: string, statusCode: 200, type: "String" }` | 401/403 | |
| PATCH | `/organization/update-infos` | `checkPermissions` | Body: `UpdateInfoOrganizationAndPhoneDto` | 200 → `{ data: boolean, statusCode: 200, type: "Boolean" }` | 401/403, 400 | |
| GET | `/organization/domain` | `getOrganizationsByDomain` | Query: `domain` | 200 → `{ data: [], statusCode: 200, type: "Array" }` | 401/403, 400 | |
| GET | `/organization/language` | `getOrganizationLanguage` | Query: `teamId`, `repositoryId?`, `sampleSize?` | 200 → `{ data: { language: string \| null }, statusCode: 200, type: "Object" }` | 401/403, 400 | |

## OrganizationParametersController

File: `apps/api/src/controllers/organizationParameters.controller.ts`

Base Path: `/organization-parameters`

Tag: `Organization Parameters`

Auth: `Bearer`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/organization-parameters/create-or-update` | `checkPermissions` | Body: `{ key, configValue }` | 201 → `{ data: { _uuid, _configKey, _configValue }, statusCode: 201, type: "Object" }` | 401/403, 400 | |
| GET | `/organization-parameters/find-by-key` | `checkPermissions` | Query: `key` | Não observado (404/200 variou) | 401/403 | |
| GET | `/organization-parameters/list-providers` | `listProviders` | Sem params | 200 → `{ data: { providers: [{ id, name, description, requiresApiKey, requiresBaseUrl }] }, statusCode: 200, type: "Object" }` | 401/403 | |
| GET | `/organization-parameters/list-models` | `listModels` | Query: `provider` | 200 → `{ data: { provider, models: [{ id, name, supportsReasoning?, reasoningConfig? }] }, statusCode: 200, type: "Object" }` | 401/403, 400 | |
| DELETE | `/organization-parameters/delete-byok-config` | `deleteByokConfig` | Query: `configType` (`main` \| `fallback`) | 400 → `{ statusCode: 400, error: "Bad Request", message: "BYOK configuration not found" }` | 401/403, 400 | |
| GET | `/organization-parameters/cockpit-metrics-visibility` | `checkPermissions` | Sem params | 200 → `{ data: { summary, details }, statusCode: 200, type: "Object" }` | 401/403 | |
| POST | `/organization-parameters/cockpit-metrics-visibility` | `checkPermissions` | Body: `{ teamId?, config }` | 201 → `{ data: { _uuid, _configKey, _configValue }, statusCode: 201, type: "Object" }` | 401/403, 400 | |
| POST | `/organization-parameters/ignore-bots` | `checkPermissions` | Body: `{ teamId }` | 204 No Content | 401/403, 400 | |
| POST | `/organization-parameters/auto-license/allowed-users` | `checkPermissions` | Body: `{ teamId?, includeCurrentUser? }` | 201 → `{ data: true, statusCode: 201, type: "Boolean" }` | 401/403, 400 | |

## ParametersController

File: `apps/api/src/controllers/parameters.controller.ts`

Base Path: `/parameters`

Tag: `Parameters`

Auth: `Bearer`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/parameters/create-or-update` | `checkPermissions` | Body: `{ key, configValue, organizationAndTeamData }` | 201 → `{ data: { _uuid, _configKey, _configValue, _createdAt, _updatedAt, _version }, statusCode: 201, type: "Object" }` | 401/403, 500 | |
| GET | `/parameters/find-by-key` | `checkPermissions` | Query: `key`, `teamId` | 404 → empty body | 401/403, 404 | |
| GET | `/parameters/list-code-review-automation-labels` | `checkPermissions` | Query: `codeReviewVersion?`, `teamId?`, `repositoryId?` | 200 → `{ data: { labels: [{ type, name, description }] }, statusCode: 200, type: "Object" }` | 401/403 | |
| POST | `/parameters/create-or-update-code-review` | `checkPermissions` | Body: `CreateOrUpdateCodeReviewParameterDto` | 400 → validation error (e.g. `configValue.property configs should not exist`, `configValue.customMessages.globalSettings.property suggestionCopyPrompt should not exist`) | 401/403, 400 | DTO expects `CodeReviewConfigWithoutLLMProviderDto` (flat config). |
| POST | `/parameters/apply-code-review-preset` | `checkPermissions` | Body: `ApplyCodeReviewPresetDto` | 201 → `{ data: { id, name, configs, isSelected, repositories }, statusCode: 201, type: "Object" }` | 401/403, 500 | |
| POST | `/parameters/update-code-review-parameter-repositories` | `checkPermissions` | Body: `{ organizationAndTeamData }` | 201 → `{ data: { _uuid, _configKey, _configValue }, statusCode: 201, type: "Object" }` | 401/403, 500 | |
| GET | `/parameters/code-review-parameter` | `checkPermissions` | Query: `teamId` | 200 → `{ data: { uuid, configKey, configValue, isSelected, repositories }, statusCode: 200, type: "Object" }` | 401/403, 500 | |
| GET | `/parameters/default-code-review-parameter` | `checkPermissions` | Sem params | 200 → `{ data: <code review config>, statusCode: 200, type: "Object" }` | 401/403 | |
| GET | `/parameters/generate-kodus-config-file` | `checkPermissions` | Query: `teamId`, `repositoryId?`, `directoryId?` | 200 → YAML (string) | 401/403 | `application/x-yaml` |
| POST | `/parameters/delete-repository-code-review-parameter` | `checkRepoPermissions` | Body: `DeleteRepositoryCodeReviewParameterDto` | 201 → `{ data: { _uuid, _configKey, _configValue }, statusCode: 201, type: "Object" }` | 401/403 | |
| POST | `/parameters/preview-pr-summary` | `checkPermissions` | Body: `PreviewPrSummaryDto` | 201 → `{ data: "<!-- kody-pr-summary:start -->...<!-- kody-pr-summary:end -->", statusCode: 201, type: "String" }` | 401/403, 400 | |

## PermissionsController

File: `apps/api/src/controllers/permissions.controller.ts`

Base Path: `/permissions`

Tag: `Permissions`

Auth: `Bearer`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/permissions` | `getPermissions` | Sem params | 200 → `{ data: { [resource]: { manage/create/read/update/delete: { organizationId } } }, statusCode: 200, type: "Object" }` | 401/403 | |
| GET | `/permissions/can-access` | `can` | Query: `action`, `resource` | 200 → `{ data: boolean, statusCode: 200, type: "Boolean" }` | 401/403 | |
| GET | `/permissions/assigned-repos` | `getAssignedRepos` | Query: `userId?` | 200 → `{ data: string[], statusCode: 200, type: "Array" }` | 401/403 | |
| POST | `/permissions/assign-repos` | `checkPermissions` | Body: `{ repositoryIds: string[], userId: string, teamId: string }` | 201 → `{ data: [repositoryId], statusCode: 201, type: "Array" }` | 401/403/500 | |

## PullRequestController

File: `apps/api/src/controllers/pullRequest.controller.ts`

Base Path: `/pull-requests`

Tag: `Pull Requests`

Auth: `Unknown`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/pull-requests/executions` | `checkPermissions` | Query: filtros + `teamId` | 200 → `{ data: { data: [execution], pagination }, statusCode: 200, type: "Object" }` | 401/403, 400 | |
| GET | `/pull-requests/suggestions` | `getSuggestionsByPullRequest` | Query: `prUrl`/`prNumber` etc + header `x-team-key` | 200 → `{ data: { prNumber, repositoryId, repositoryFullName, suggestions: { files: [], prLevel: [] } }, statusCode: 200, type: "Object" }` | 401/403, 404 | |
| POST | `/pull-requests/cli/suggestions` | `getSuggestionsByPullRequestWithKey` | Body: filtros + header `x-team-key` | 201 → `{ data: { prNumber, repositoryId, repositoryFullName, suggestions: { files: [], prLevel: [] } }, statusCode: 201, type: "Object" }` | 401, 404 | |
| GET | `/pull-requests/cli/suggestions` | `getSuggestionsByPullRequestWithKeyGet` | Query: filtros + header `x-team-key` | 200 → `{ data: { prNumber, repositoryId, repositoryFullName, suggestions: { files: [], prLevel: [] } }, statusCode: 200, type: "Object" }` | 401, 404 | |
| GET | `/pull-requests/onboarding-signals` | `checkPermissions` | Query: `teamId`, `repositoryIds`, `limit?` | 200 → `{ data: [{ repositoryId, sampleSize, metrics, recommendation }], statusCode: 200, type: "Array" }` | 401/403, 400 | |
| POST | `/pull-requests/backfill` | `checkPermissions` | Body: `BackfillPRsDto` | 201 → `{ data: { success, message, repositoriesCount }, statusCode: 201, type: "Object" }` | 401/403, 400 | |

## PullRequestMessagesController

File: `apps/api/src/controllers/pullRequestMessages.controller.ts`

Base Path: `/pull-request-messages`

Tag: `Pull Request Messages`

Auth: `Bearer`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/pull-request-messages` | `checkPermissions` | Body: `{ configLevel, repositoryId?, directoryId?, startReviewMessage?, endReviewMessage?, globalSettings? }` | 204 No Content | 401/403 | |
| GET | `/pull-request-messages/find-by-repository-or-directory` | `checkRepoPermissions` | Query: `repositoryId` (obrigatório), `directoryId?` | 200 → `{ data: { organizationId, repositoryId, globalSettings, startReviewMessage, endReviewMessage }, statusCode: 200, type: "Object" }` | 401/403 | |

## RuleLikeController

File: `apps/api/src/controllers/ruleLike.controller.ts`

Base Path: `/rule-like`

Tag: `Rule Likes`

Auth: `Bearer`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/rule-like/:ruleId/feedback` | `setFeedback` | Param: `ruleId` + Body: `{ feedback: "positive" | "negative" }` | 201 → `{ data: { ruleId, userId, feedback, createdAt, updatedAt }, statusCode: 201, type: "Object" }` | 401/403 | |
| DELETE | `/rule-like/:ruleId/feedback` | `removeFeedback` | Param: `ruleId` | 200 → `{ data: true, statusCode: 200, type: "Boolean" }` | 401/403 | |

## SegmentController

File: `apps/api/src/controllers/segment.controller.ts`

Base Path: `/segment`

Tag: `Segment`

Auth: `Bearer`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/segment/track` | `track` | Body: `{ userId, event, properties? }` | 204 No Content | 401/403 | |

## SSOConfigController

File: `apps/api/src/controllers/ssoConfig.controller.ts`

Base Path: `/sso-config`

Tag: `SSO Config`

Auth: `Bearer`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/sso-config` | `checkPermissions` | Body: `{ uuid?, protocol?, providerConfig?, active?, domains? }` | TBD | 401/403, 400 | |
| GET | `/sso-config` | `checkPermissions` | Query: `protocol?`, `active?` | 404 Not Found (body vazio quando não existe config) | 401/403, 404 | |

## TeamCliKeyController

File: `apps/api/src/controllers/team-cli-key.controller.ts`

Base Path: `/teams/:teamId/cli-keys`

Tag: `Team CLI Key`

Auth: `Bearer`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/teams/:teamId/cli-keys` | `checkRole` | Body: `{ name }` | 201 → `{ data: { key, message }, statusCode: 201, type: "Object" }` | 401/403, 400 | |
| GET | `/teams/:teamId/cli-keys` | `checkRole` | Sem params | 200 → `{ data: [{ uuid, name, active, lastUsedAt, createdAt, createdBy? }], statusCode: 200, type: "Array" }` | 401/403 | |
| DELETE | `/teams/:teamId/cli-keys/:keyId` | `checkRole` | Param: `keyId` | 200 → `{ data: { message }, statusCode: 200, type: "Object" }` | 401/403, 404 | |

## TeamController

File: `apps/api/src/controllers/team.controller.ts`

Base Path: `/team`

Tag: `Team`

Auth: `Bearer`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/team` | `list` | Sem params | 200 → `{ data: [{ uuid, name, status, cliConfig }], statusCode: 200, type: "Array" }` | 401/403 | |
| GET | `/team/list-with-integrations` | `listWithIntegrations` | Sem params | 200 → `{ data: [], statusCode: 200, type: "Array" }` | 401/403 | |

## TeamMembersController

File: `apps/api/src/controllers/teamMembers.controller.ts`

Base Path: `/team-members`

Tag: `Team Members`

Auth: `Bearer`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/team-members` | `checkPermissions` | Query: `teamId` | 200 → `{ data: { members: [] }, statusCode: 200, type: "Object" }` | 401/403 | |
| POST | `/team-members` | `checkPermissions` | Body: `{ members, teamId }` | 201 → `{ data: { success: true, results: [{ email, status, message }] }, statusCode: 201, type: "Object" }` | 401/403/500 | |
| DELETE | `/team-members/:uuid` | `checkPermissions` | Param: `uuid`, Query: `removeAll?` | Não observado (nenhum uuid retornado no invite) | 401/403/500 | |

## TokenUsageController

File: `apps/api/src/controllers/tokenUsage.controller.ts`

Base Path: `/usage`

Tag: `Token Usage`

Auth: `Bearer`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/usage/tokens/summary` | `getSummary` | Query: `startDate`, `endDate`, `byok`, `models?`, `prNumber?`, `timezone?`, `developer?` | 200 → `{ data: { input, output, total, outputReasoning, model }, statusCode: 200, type: "Object" }` | 401/403, 400 | |
| GET | `/usage/tokens/daily` | `getDaily` | Query: `startDate`, `endDate`, `byok`, `models?`, `prNumber?`, `timezone?`, `developer?` | 200 → `{ data: [{ date, input, output, total, outputReasoning, model }], statusCode: 200, type: "Array" }` | 401/403, 400 | |
| GET | `/usage/tokens/by-pr` | `getUsageByPr` | Query: `startDate`, `endDate`, `byok`, `models?`, `prNumber?`, `timezone?`, `developer?` | 200 → `{ data: [{ prNumber, input, output, total, outputReasoning, model }], statusCode: 200, type: "Array" }` | 401/403, 400 | |
| GET | `/usage/tokens/daily-by-pr` | `getDailyUsageByPr` | Query: `startDate`, `endDate`, `byok`, `models?`, `prNumber?`, `timezone?`, `developer?` | 200 → `{ data: [{ date, prNumber, input, output, total, outputReasoning, model }], statusCode: 200, type: "Array" }` | 401/403, 400 | |
| GET | `/usage/tokens/by-developer` | `getUsageByDeveloper` | Query: `startDate`, `endDate`, `byok`, `models?`, `prNumber?`, `timezone?`, `developer?` | 200 → `{ data: [{ developer, input, output, total, outputReasoning, model }], statusCode: 200, type: "Array" }` | 401/403, 400 | |
| GET | `/usage/tokens/daily-by-developer` | `getDailyByDeveloper` | Query: `startDate`, `endDate`, `byok`, `models?`, `prNumber?`, `timezone?`, `developer?` | 200 → `{ data: [{ date, developer, input, output, total, outputReasoning, model }], statusCode: 200, type: "Array" }` | 401/403, 400 | |
| GET | `/usage/tokens/pricing` | `getPricing` | Query: `model`, `provider` | 200 → `{ data: {}, statusCode: 200, type: "Object" }` | 401/403 | |
| GET | `/usage/cost-estimate` | `getCostEstimate` | Sem params | 200 → `{ data: { estimatedMonthlyCost, costPerDeveloper, developerCount, tokenUsage, periodDays, projectionDays }, statusCode: 200, type: "Object" }` | 401/403 | |

## UsersController

File: `apps/api/src/controllers/user.controller.ts`

Base Path: `/user`

Tag: `User`

Auth: `Unknown`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/user/email` | `getEmail` | Query: `email` | 200 → `{ data: boolean, statusCode: 200, type: "Boolean" }` | 400 | Public |
| GET | `/user/invite` | `getInviteDate` | Query: `userId` | 200 → `{ data: {}, statusCode: 200, type: "Object" }` | 400 | Public |
| POST | `/user/invite/complete-invitation` | `completeInvitation` | Body: `AcceptUserInvitationDto` | 500 → `{ statusCode: 500, error: "Internal Server Error", message: "An unexpected error occurred" }` (invalid uuid) | 400/500 | Public |
| POST | `/user/join-organization` | `checkPermissions` | Body: `JoinOrganizationDto` | 201 → `{ data: { _uuid, _email, _role, _organization, _teamMember, _permissions }, statusCode: 201, type: "Object" }` | 401/403, 400 | |
| PATCH | `/user/:targetUserId` | `checkPermissions` | Param: `targetUserId` + Body: `UpdateAnotherUserDto` | 200 → `{ data: { uuid, email, role, status }, statusCode: 200, type: "Object" }` | 401/403, 500 | |
| GET | `/user/info` | `show` | Sem params | 200 → `{ data: { uuid, email, role, organization, status, teamMember, permissions }, statusCode: 200, type: "Object" }` | 401/403 | |

## HealthController

File: `libs/core/health/health.controller.ts`

Base Path: `/health`

Tag: `Health`

Auth: `Public`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/health` | `check` | Sem params | 200 → `{ status, timestamp, details: { application, database } }` | 503 | |
| GET | `/health/ready` | `readyCheck` | Sem params | 200 → `{ status, timestamp, details: { application, database } }` | 503 | |
| GET | `/health/simple` | `simpleCheck` | Sem params | 200 → `{ status, timestamp, message, uptime }` | - | |
| GET | `/health/live` | `liveCheck` | Sem params | 200 → `{ status, timestamp, message, uptime }` | - | |

## WebhookHealthController

File: `apps/api/src/controllers/webhook-health.controller.ts`

Base Path: `/health`

Tag: `Webhook Health`

Auth: `Public`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/health` | `check` | Sem params | Não observado (rota sobreposta pelo core health) | 503 | |
| GET | `/health/simple` | `simpleCheck` | Sem params | Não observado (rota sobreposta pelo core health) | - | |

## MetricsController

File: `libs/core/infrastructure/metrics/metrics.controller.ts`

Base Path: `/internal/metrics`

Tag: `Internal Metrics`

Auth: `Bearer`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/internal/metrics/error-rates` | `getErrorRates` | Query: `window?` | 200 → `{ data: [{ component, totalRequests, totalErrors, errorRate, windowMinutes }], statusCode: 200, type: "Array" }` | 401/403 | |
| GET | `/internal/metrics/review-response-times` | `getReviewResponseTimes` | Query: `hours?` | 200 → `{ data: { p50, p95, avg, max, count, windowHours }, statusCode: 200, type: "Object" }` | 401/403 | |
| GET | `/internal/metrics/pipeline-performance` | `getPipelinePerformance` | Query: `hours?` | 200 → `{ data: [{ pipeline, stage, avgDurationMs, count }], statusCode: 200, type: "Array" }` | 401/403 | |
| GET | `/internal/metrics/summary` | `getSummary` | Sem params | 200 → `{ data: { errorRate: [...], reviewsProcessed, reviewsFailed, avgReviewDurationMs, timestamp }, statusCode: 200, type: "Object" }` | 401/403 | |

## McpController

File: `libs/mcp-server/controllers/mcp.controller.ts`

Base Path: `/mcp`

Tag: `MCP`

Auth: `Bearer` (guardado por feature flag)

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/mcp` | `handleClientRequest` | Headers: `mcp-session-id?`, `Accept: application/json, text/event-stream` + Body: JSON-RPC `initialize` | 200 → SSE `event: message` + header `mcp-session-id` | 400/406/500 | Requires `API_MCP_SERVER_ENABLED=true`. Init payload must include `protocolVersion`, `capabilities`, `clientInfo`. |
| GET | `/mcp` | `handleServerNotifications` | Headers: `mcp-session-id`, `Accept: text/event-stream` | 200 → SSE stream | 400/406 | |
| DELETE | `/mcp` | `handleSessionTermination` | Header: `mcp-session-id` | 204 No Content | 400 | |

## WorkflowQueueController

File: `apps/api/src/controllers/workflow-queue.controller.ts`

Base Path: `/workflow-queue`

Tag: `Workflow Queue`

Auth: `Bearer`

| Method | Route | Handler | Input | Output | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/workflow-queue/jobs/:jobId` | `checkPermissions` | TBD | TBD | TBD | Controller não está registrado em `apps/api/src/api.module.ts` (comentado) |
| GET | `/workflow-queue/jobs/:jobId/detail` | `checkPermissions` | TBD | TBD | TBD | Controller não está registrado em `apps/api/src/api.module.ts` (comentado) |
| GET | `/workflow-queue/metrics` | `checkPermissions` | TBD | TBD | TBD | Controller não está registrado em `apps/api/src/api.module.ts` (comentado) |
