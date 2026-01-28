# Cleanup and Metadata Migration Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Clean up the previous migration attempts and generate a single, consolidated migration that adds `stage_name`, `metadata`, and `finished_at` to `code_review_execution`, along with proper indexing.

**Architecture:** Use TypeORM migrations. Update entities first, then sync DB.

**Tech Stack:** TypeORM, PostgreSQL.

---

### Task 1: Revert & Cleanup Migrations

**Goal:** Ensure the database and filesystem are clean before generating the new migration.

**Steps:**

1.  Run `yarn migration:revert`.
2.  Delete `libs/core/infrastructure/database/typeorm/migrations/1769537769049-addStageNameCodeReviewpipeline.ts`.
3.  **Manual DB Check (Safety):** Execute SQL to drop `stage_name` column from `code_review_execution` if revert didn't catch it (just to be safe). `ALTER TABLE code_review_execution DROP COLUMN IF EXISTS stage_name;`

---

### Task 2: Update Code Review Execution Entities

**Goal:** Add `metadata` and `finishedAt` properties to the entity and model.

**Files:**

- Modify: `libs/automation/infrastructure/adapters/repositories/schemas/codeReviewExecution.model.ts`
- Modify: `libs/automation/domain/codeReviewExecutions/entities/codeReviewExecution.entity.ts`
- Modify: `libs/automation/domain/codeReviewExecutions/interfaces/codeReviewExecution.interface.ts`

**Step 1: Interface Update**

- Add `metadata?: Record<string, any>;`
- Add `finishedAt?: Date;`

**Step 2: Entity Update**

- Add private properties `_metadata`, `_finishedAt`.
- Add getters/setters/constructor logic.
- Update `toObject`.

**Step 3: Model Update**

- Add `@Column({ type: 'jsonb', nullable: true }) metadata: Record<string, any>;`
- Add `@Column({ type: 'timestamp', nullable: true }) finishedAt: Date;`

---

### Task 3: Generate Unified Migration

**Goal:** Generate the final migration file.

**Steps:**

1.  Run `yarn migration:generate addStageTrackingToCodeReviewExecution`.
2.  **Sanitize:** Read the file. Remove `IDX_integration_configs_value_gin` drops if present.
3.  **Verify:** Ensure it has `ADD stage_name`, `ADD metadata`, `ADD finishedAt`, and `CREATE INDEX` for stage/status.
