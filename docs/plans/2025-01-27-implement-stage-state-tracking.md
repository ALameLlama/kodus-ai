# Implement Stage State Tracking (Update Logic)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Refactor the pipeline logging to use a "State Machine" approach: Create a log entry on Stage Start, and UPDATE that same entry on Finish/Error, instead of creating duplicate rows.

**Tech Stack:** TypeScript, NestJS, TypeORM.

---

### Task 1: Update Pipeline Context

**Files:**

- Modify: `libs/code-review/pipeline/context/code-review-pipeline.context.ts`

**Step 1:**
Add `currentStageLogId?: string;` to `CodeReviewPipelineContext` interface.

---

### Task 2: Implement Update Log Method in Service

**Files:**

- Modify: `libs/automation/domain/codeReviewExecutions/contracts/codeReviewExecution.service.contract.ts` (Interface)
- Modify: `libs/automation/infrastructure/adapters/services/codeReviewExecution.service.ts` (Implementation)
- Modify: `libs/automation/domain/automationExecution/contracts/automation-execution.service.ts` (Interface - if wrapper needed)
- Modify: `libs/automation/infrastructure/adapters/services/automationExecution.service.ts` (Wrapper)

**Step 1: CodeReviewExecutionService**

- Add `update(uuid: string, data: Partial<CodeReviewExecution>): Promise<CodeReviewExecution>` method.
- Implementation: Call repository update.

**Step 2: AutomationExecutionService**

- Expose a method `updateStageLog(uuid: string, data: Partial<CodeReviewExecution>): Promise<void>` that delegates to `CodeReviewExecutionService.update`.

---

### Task 3: Refactor CodeReviewPipelineObserver

**Files:**

- Modify: `libs/code-review/infrastructure/observers/code-review-pipeline.observer.ts`

**Step 1: onStageStart**

- Call `automationService.createCodeReview(...)` (as before, but capture result).
- Store `result.uuid` into `context.currentStageLogId`.
- Log "Starting..."

**Step 2: onStageFinish**

- Check `context.currentStageLogId`.
- If exists: Call `automationService.updateStageLog(id, { status: SUCCESS, finishedAt: new Date(), message: "Completed" })`.
- If not exists (fallback): Log warning or create new entry (legacy behavior).
- Reset `context.currentStageLogId`.

**Step 3: onStageError / onStageSkipped**

- Similar logic: Update status to ERROR/SKIPPED, set `finishedAt`, set `message`/`metadata`.

---

### Task 4: Verify Tests

**Files:**

- Modify: `libs/code-review/infrastructure/observers/code-review-pipeline.observer.spec.ts`

**Step 1:** Update tests to mock the new `updateStageLog` method and verify the Create -> Update flow.
