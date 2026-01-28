# Fix Pipeline Logging (Stateless DB Approach)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Fix the issue of duplicate logs by removing reliance on in-memory state (Map/Context). Instead, query the database to find the active stage log before updating it.

**Strategy:**

- Start: Insert log.
- Finish: Query DB for latest `IN_PROGRESS` log for this stage -> Update it.

**Tech Stack:** TypeScript, NestJS, TypeORM.

---

### Task 1: Add Find Method to Service

**Files:**

- Modify: `libs/automation/domain/codeReviewExecutions/contracts/codeReviewExecution.service.contract.ts`
- Modify: `libs/automation/infrastructure/adapters/services/codeReviewExecution.service.ts`
- Modify: `libs/automation/domain/automationExecution/contracts/automation-execution.service.ts`
- Modify: `libs/automation/infrastructure/adapters/services/automationExecution.service.ts`

**Step 1: Repo/Service (Child)**

- Add `findLatestInProgress(executionId: string, stageName: string): Promise<CodeReviewExecution | null>`.
- Impl: `repository.findOne({ where: { automationExecution: { uuid: executionId }, stageName, status: IN_PROGRESS }, order: { createdAt: 'DESC' } })`.

**Step 2: Service (Parent)**

- Add `findStageLog` wrapper.

---

### Task 2: Refactor Observer

**Files:**

- Modify: `libs/code-review/infrastructure/observers/code-review-pipeline.observer.ts`

**Step 1:**

- Remove `stageLogMap`.
- Remove `getLogKey`.

**Step 2: Update `logStage`**

- If status is `IN_PROGRESS` (Start): Just Create.
- If status is `SUCCESS/ERROR` (Finish):
    - Call `service.findLatestInProgress(...)`.
    - If found -> Update.
    - If not found -> Create (Fallback).

---

### Task 3: Verify Tests

**Files:**

- Modify: `libs/code-review/infrastructure/observers/code-review-pipeline.observer.spec.ts`

**Step 1:**

- Update mocks to handle `findLatestInProgress`.
- Verify flow.
