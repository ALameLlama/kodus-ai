# Implement Stage Visibility Levels

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Allow frontend to filter stages by importance (Primary vs Secondary) by adding a visibility property to stages and persisting it in execution logs metadata.

**Architecture:** Add `visibility` property to `PipelineStage` interface. Update `BasePipelineStage` with default. Override in specific stages. Observer saves it to DB metadata.

**Tech Stack:** TypeScript, NestJS.

---

### Task 1: Define Enum and Update Interface

**Files:**

- Create: `libs/core/infrastructure/pipeline/enums/stage-visibility.enum.ts`
- Modify: `libs/core/infrastructure/pipeline/interfaces/pipeline.interface.ts`
- Modify: `libs/core/infrastructure/pipeline/abstracts/base-stage.abstract.ts`

**Step 1: Enum**

```typescript
export enum StageVisibility {
    PRIMARY = 'primary', // Show in main progress
    SECONDARY = 'secondary', // Show in details
    INTERNAL = 'internal', // Show only for admins
}
```

**Step 2: Interface**

- Add `visibility: StageVisibility;` to `PipelineStage`.

**Step 3: Base Class**

- Add `visibility: StageVisibility = StageVisibility.PRIMARY;` (Default).

---

### Task 2: Configure Specific Stages (Overrides)

**Files:**

- Modify technical stages to set `visibility = StageVisibility.SECONDARY`.
- Targets:
    - `libs/code-review/pipeline/stages/resolve-config.stage.ts`
    - `libs/code-review/pipeline/stages/load-external-context.stage.ts`
    - `libs/code-review/pipeline/stages/file-context-gate.stage.ts`
    - `libs/code-review/pipeline/stages/create-batch.stage.ts`
    - (Any other "internal plumbing" stages)

**Step 1:** In each class, override the property:

```typescript
visibility = StageVisibility.SECONDARY;
```

---

### Task 3: Update Observer to Persist Visibility

**Files:**

- Modify: `libs/core/infrastructure/pipeline/interfaces/pipeline-observer.interface.ts`
- Modify: `libs/core/infrastructure/pipeline/services/pipeline-executor.service.ts`
- Modify: `libs/code-review/infrastructure/observers/code-review-pipeline.observer.ts`

**Step 1: Update Observer Interface**

- `onStageStart(stageName: string, context: TContext, visibility: StageVisibility)`
- (Need to pass visibility from Executor to Observer)

**Step 2: Update Executor**

- In `onStageStart` call, pass `stage.visibility`.

**Step 3: Update CodeReviewPipelineObserver**

- Receive `visibility` argument.
- Add it to the `metadata` object passed to `createCodeReview`.
- `metadata: { ...existing, visibility }`.

---

### Task 4: Verification

**Files:**

- `libs/code-review/infrastructure/observers/code-review-pipeline.observer.spec.ts`

**Step 1:** Update tests to match new interface signature and verify metadata is saved.
