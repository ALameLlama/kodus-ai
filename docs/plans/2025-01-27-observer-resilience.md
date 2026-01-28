# Implement Observer Resilience

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Ensure the `CodeReviewPipelineObserver` can find the `executionUuid` even if it is missing from the context metadata, preventing duplicate log entries.

**Strategy:**
If `executionUuid` is missing in `logStage`, attempt to find an active `AutomationExecution` for the PR/Repo using the service.

**Tech Stack:** TypeScript, NestJS.

---

### Task 1: Enhance Observer

**Files:**

- Modify: `libs/code-review/infrastructure/observers/code-review-pipeline.observer.ts`

**Steps:**

1.  **Modify `logStage`:**
    - If `executionUuid` is undefined:
    - Get `pullRequestNumber` and `repositoryId` from context.
    - Call `this.automationExecutionService.findLatestExecutionByFilters({ pullRequestNumber, repositoryId, status: AutomationStatus.IN_PROGRESS })`.
    - If found, use `found.uuid` as `executionUuid`.
2.  **Logic Flow:**
    - Try Context UUID.
    - If missing -> Try DB Lookup.
    - If both fail -> Fallback to Create (Legacy).
    - If found -> Proceed to `findLatestStageLog` -> Update.

**Verify:**
Ensure imports are correct.
