# Refactor ProcessFilesReview to Pure Return

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make `analyzeChangedFilesInBatches` pure by returning errors instead of mutating `context.errors`.

**Files:**

- Modify: `libs/code-review/pipeline/stages/process-files-review.stage.ts`

**Steps:**

1.  **Refactor `analyzeChangedFilesInBatches`:**
    - Return type includes `errors: PipelineError[]`.
    - Create local `errors` array.
    - Accumulate errors from batch results into local array.
    - Return it.
    - Remove `context.errors.push`.

2.  **Refactor `executeStage`:**
    - Destructure `errors` from the result.
    - Push them to `context.errors`.

**Verify:**
Compilation.
