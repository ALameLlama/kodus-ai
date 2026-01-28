# User-Centric Pipeline Messages Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Transform pipeline logs from technical errors into user-centric guidance. Create a rich dictionary of reasons including descriptions and actions, and update the formatting helper to present this clearly.

**Architecture:**

- `PipelineReason` Interface: Structure for message, description, action.
- `PipelineReasons` Constant: The dictionary of all possible outcomes.
- Updated `StageMessageHelper`: Formatter that consumes `PipelineReason`.

**Tech Stack:** TypeScript.

---

### Task 1: Create Rich Dictionary

**Files:**

- Create: `libs/core/infrastructure/pipeline/constants/pipeline-reasons.const.ts`
- Create: `libs/core/infrastructure/pipeline/interfaces/pipeline-reason.interface.ts`

**Step 1: Interface**

```typescript
export interface PipelineReason {
    message: string; // The "What" (Short)
    description?: string; // The "Why" (Detailed)
    action?: string; // The "How to Fix" (Call to Action)
}
```

**Step 2: Constants**
Create the dictionary covering:

- **Config:** Disabled, Ignored Title, Draft, Branch Mismatch.
- **Files:** No Changes, All Ignored, Too Many.
- **Commits:** No New Commits, Only Merge.
- **Prerequisites:** PR Closed, PR Locked.

_Focus on friendly, helpful copy._

---

### Task 2: Enhance StageMessageHelper

**Files:**

- Modify: `libs/core/infrastructure/pipeline/utils/stage-message.helper.ts`

**Step 1:**

- Add `skippedWithReason(reason: PipelineReason, techDetail?: string): string`.
- Format: `${reason.message}`.
    - If action: ` ${reason.message} — ${reason.action}`.
    - Tech detail goes in parenthesis or separate if needed.
    - _Goal:_ "Draft PR Skipped — Mark as Ready or check settings (runOnDraft=false)"

---

### Task 3: Apply to ValidateConfigStage

**Files:**

- Modify: `libs/code-review/pipeline/stages/validate-config.stage.ts`

**Step 1:**

- Import `PipelineReasons`.
- Replace manual strings with `PipelineReasons.CONFIG.DRAFT`, etc.
- Use `StageMessageHelper.skippedWithReason(...)`.

---

### Task 4: Apply to Other Stages

**Files:**

- Modify: `libs/code-review/pipeline/stages/validate-new-commits.stage.ts`
- Modify: `libs/code-review/pipeline/stages/fetch-changed-files.stage.ts`

**Step 1:**

- Apply the same pattern using relevant constants (COMMITS, FILES).
