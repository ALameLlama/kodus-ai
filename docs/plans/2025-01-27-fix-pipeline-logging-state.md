# Fix Pipeline Logging State Leak

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Fix the issue where logs are overwritten or missing due to state leaking in the `CodeReviewPipelineContext`. Use an internal Map in the Observer to track stage log IDs reliably, supporting sequential and parallel execution.

**Architecture:** Use a `Map<string, string>` in `CodeReviewPipelineObserver` where Key=`${executionId}:${stageName}` and Value=`logUuid`.

**Tech Stack:** TypeScript, NestJS.

---

### Task 1: Remove Unreliable Context Property

**Files:**

- Modify: `libs/code-review/pipeline/context/code-review-pipeline.context.ts`

**Step 1:**
Remove `currentStageLogId` property from interface.

---

### Task 2: Refactor Observer State Management

**Files:**

- Modify: `libs/code-review/infrastructure/observers/code-review-pipeline.observer.ts`

**Step 1: Add Map**
Add `private stageLogMap = new Map<string, string>();` to the class.

**Step 2: Helper for Key**
Create `private getLogKey(context: CodeReviewPipelineContext, stageName: string): string`.

- Return `${context.pipelineMetadata.lastExecution.uuid}:${stageName}`.
- (Handle missing uuid gracefully if needed, though start should ensure it).

**Step 3: Update `onStageStart`**

- Generate Key.
- Create Log (Insert).
- Store ID: `this.stageLogMap.set(key, logUuid)`.

**Step 4: Update `logStage` (used by Finish/Error/Skipped)**

- Generate Key.
- Get ID: `const logId = this.stageLogMap.get(key)`.
- If ID exists -> Update Log.
- If ID missing -> Create Log (Safety fallback).
- **Crucial:** Delete key after update: `this.stageLogMap.delete(key)`.

---

### Task 3: Verify Tests

**Files:**

- Modify: `libs/code-review/infrastructure/observers/code-review-pipeline.observer.spec.ts`

**Step 1:**
Update tests to reflect that context is no longer mutated. Check internal map state (or mock behavior) if possible, or just verify the calls to service are correct (Create then Update).
