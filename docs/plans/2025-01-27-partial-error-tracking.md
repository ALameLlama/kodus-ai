# Implement Partial Error Tracking

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Capture and log partial errors (e.g., failed file analysis) without stopping the pipeline, ensuring transparency for the user.

**Architecture:** Use `context.errors` to collect exceptions during execution. The Observer reads this collection on stage completion and persists it to the DB metadata.

**Tech Stack:** TypeScript.

---

### Task 1: Capture Errors in ProcessFilesReview

**Files:**

- Modify: `libs/code-review/pipeline/stages/process-files-review.stage.ts`

**Steps:**

1.  Locate `executeFileAnalysis` method (where the try/catch is).
2.  In the `catch` block:
    - Construct a `PipelineError` object.
    - Push it to `context.errors`.
    - (Keep the existing logger calls).

**Details:**

```typescript
context.errors.push({
    stage: this.stageName,
    substage: file.filename,
    error: error instanceof Error ? error : new Error(String(error)),
    metadata: {
        filename: file.filename,
    },
});
```

---

### Task 2: Persist Errors in Observer

**Files:**

- Modify: `libs/code-review/infrastructure/observers/code-review-pipeline.observer.ts`

**Steps:**

1.  In `onStageFinish`:
    - Filter `context.errors` by `stageName` (so we only log errors from the current stage).
    - If errors exist:
        - Map them to a clean JSON structure (e.g., `{ file: string, message: string }`).
        - Add this list to `metadata.partialErrors`.
        - (Optional) Append "with errors" to the success message.

**Verify:**
Updates tests to ensure errors appear in metadata.
