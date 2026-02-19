# Kodus Flow - AI Agent Orchestration SDK

Published npm package for building AI agents. Strict 5-layer architecture.

## What Agents Get Wrong

- **Never bypass layer boundaries.** This is the most important rule:

| Layer | Can Use | Cannot Use |
|-------|---------|------------|
| Orchestration (`src/orchestration/`) | Engine, Observability | Runtime, Kernel |
| Engine (`src/engine/`) | Kernel, Runtime (AgentExecutor only), Observability | - |
| Kernel (`src/kernel/`) | Runtime, Observability | - |
| Runtime (`src/runtime/`) | Observability | Kernel, Engine |
| Observability (`src/observability/`) | - | All others |

- Create agents/tools via **orchestration layer** (`orchestration.createAgent()`). Never instantiate Engine directly
- State management via **kernel** (`kernel.setContext()`). Never use `this.state = {}`
- Logging via **`createLogger()`**. Never use `console.log`
- Never duplicate existing systems (events, context, logging already exist in their layers)
- Runtime access from Engine is restricted to **AgentExecutor only**, not AgentEngine

## TypeScript Conventions

- Simple string types for IDs (no branded types)
- Discriminated unions for state management
- `unknown` + type guards instead of `any`
