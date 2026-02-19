# Kodus Common - LLM Abstraction Layer

Published npm package providing unified LLM integration and shared types.

## What Agents Get Wrong

- This is a **NestJS dynamic module** (`LLMModule.forRoot()`), not a plain utility library
- Three main services: `LLMProviderService` (creates providers), `PromptRunnerService` (executes prompts), `BYOKProviderService` (custom keys)
- Prompt building uses **fluent builder pattern** (`PromptBuilder`, `ConfigurablePromptBuilder<Output, Payload, Mode>`)
- Output parsing supports 4 modes: `STRING`, `JSON`, `ZOD`, `CUSTOM` — choose the right one for your use case
- Provider adapters (OpenAI, Anthropic, Gemini, Vertex AI, Novita) follow a **unified interface** — never call providers directly
- Imported as `@kodus/kodus-common` or `@libs/kodus-common/llm` depending on context
- Types in `types/` are the **source of truth** for organization/team data structures shared across all apps
