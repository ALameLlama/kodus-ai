# Stage Message UX Improvement Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Standardize and enhance stage execution messages (skips/errors) using Markdown and a centralized helper, improving UX and actionability.

**Tech Stack:** TypeScript.

---

### Task 1: Create Message Helper

**Files:**

- Create: `libs/core/infrastructure/pipeline/utils/stage-message.helper.ts`

**Content:**

```typescript
export class StageMessageHelper {
    static skipped(userMsg: string, techReason?: string): string {
        const reason = techReason ? `\n> *Tech Reason: ${techReason}*` : '';
        return `${userMsg}${reason}`;
    }

    static error(userMsg: string, error?: Error): string {
        const details = error ? `\n\n\`\`\`\n${error.message}\n\`\`\`` : '';
        return `**Error:** ${userMsg}${details}`;
    }

    // Helper to format config links if needed
    static configLink(text: string, url: string): string {
        return `[${text}](${url})`;
    }
}
```

_(Note: Using Markdown syntax like `_`, `\*_`, `>`)._

---

### Task 2: Apply to ValidateConfigStage

**Files:**

- Modify: `libs/code-review/pipeline/stages/validate-config.stage.ts`

**Steps:**

1.  Import `StageMessageHelper`.
2.  Update `shouldExecuteReview`:
    - Disabled: `StageMessageHelper.skipped('Automated review is disabled.', 'automatedReviewActive is false')`
    - Ignored: `StageMessageHelper.skipped('Title contains ignored keyword.', 'Match: "wip"')`
    - Draft: `StageMessageHelper.skipped('Draft PRs are ignored.', 'runOnDraft is false')`
    - Branch: `StageMessageHelper.skipped('Branch pattern mismatch.', 'Target: dev')`

**Logic Update:**
You will need to update the call site in `evaluateReviewCadence` to use the helper IF `shouldExecuteReview` returns raw parts, OR update `shouldExecuteReview` to return the formatted string directly in `details.message`.
_Decision:_ Let `shouldExecuteReview` return raw parts in `IStageValidationResult` (as it does now), and update `evaluateReviewCadence` (or the consuming logic) to use the Helper to FORMAT the final string before returning/saving.

**Wait, actually:**
The `IStageValidationResult` has `message` and `technicalReason` separate.
The formatting happens in `evaluateReviewCadence`:

```typescript
const message = basicValidation.details
    ? `${basicValidation.details.message} (${basicValidation.details.technicalReason || ''})`
```

**Action:** Change THIS line to use `StageMessageHelper.skipped(...)`.

---

### Task 3: Apply to Other Stages (Optional but Good)

**Files:**

- Modify: `libs/code-review/pipeline/stages/validate-new-commits.stage.ts`
- Modify: `libs/code-review/pipeline/stages/fetch-changed-files.stage.ts`

**Steps:**

- Locate where the message string is constructed (or where `context.statusInfo.message` is set).
- Use `StageMessageHelper`.
