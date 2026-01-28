# Refactor ProcessFilesReview to Return Pattern

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Remove prop drilling of `context.errors` in `ProcessFilesReviewStage`. Instead, internal methods should return an error object if they fail, and the main `executeStage` method will aggregate them into the context.

**Architecture:** Functional return pattern. Methods return `{ result?, error? }`.

**Tech Stack:** TypeScript.

---

### Task 1: Define Internal Result Interface

**Files:**

- Modify: `libs/code-review/pipeline/stages/process-files-review.stage.ts`

**Step 1:**
Define a type (or modify existing return types) for file analysis:

```typescript
interface FileProcessingResult {
    file: FileChange;
    suggestions: Partial<CodeSuggestion>[];
    discarded: Partial<CodeSuggestion>[];
    error?: PipelineError;
}
```

---

### Task 2: Refactor `executeFileAnalysis`

**Files:**

- Modify: `libs/code-review/pipeline/stages/process-files-review.stage.ts`

**Step 1:**

- Remove `errors` argument.
- In `catch` block: Instead of pushing to array, return object with `error` property populated.

---

### Task 3: Refactor Batch Processing Chain

**Files:**

- Modify: `libs/code-review/pipeline/stages/process-files-review.stage.ts`

**Step 1:**

- Update `processSingleBatch`, `processBatchesSequentially`, `runBatches` to bubble up the `FileProcessingResult[]`.
- Remove `errors` argument from their signatures.

---

### Task 4: Aggregate in `executeStage`

**Files:**

- Modify: `libs/code-review/pipeline/stages/process-files-review.stage.ts`

**Step 1:**

- In `analyzeChangedFilesInBatches` (or where the results come back):
- Iterate over results.
- If `result.error` exists -> `context.errors.push(result.error)`.
- If `result.suggestions` exists -> Add to `validSuggestions`.

**Verify:**
Tests should still pass (or update tests to expect clean signatures).
