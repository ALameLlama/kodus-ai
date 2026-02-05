import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNewStageWorkflow1768834829951 implements MigrationInterface {
    name = 'AddNewStageWorkflow1768834829951';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum"
            RENAME TO "workflow_jobs_workflowtype_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum" AS ENUM(
                'CODE_REVIEW',
                'CRON_CHECK_PR_APPROVAL',
                'CRON_KODY_LEARNING',
                'CRON_CODE_REVIEW_FEEDBACK',
                'WEBHOOK_PROCESSING',
                'CHECK_SUGGESTION_IMPLEMENTATION'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "kodus_workflow"."workflow_jobs"
            ALTER COLUMN "workflowType" TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum" USING "workflowType"::"text"::"kodus_workflow"."workflow_jobs_workflowtype_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum_old"
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum_old" AS ENUM(
                'CODE_REVIEW',
                'CRON_CHECK_PR_APPROVAL',
                'CRON_KODY_LEARNING',
                'CRON_CODE_REVIEW_FEEDBACK',
                'WEBHOOK_PROCESSING'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "kodus_workflow"."workflow_jobs"
            ALTER COLUMN "workflowType" TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum_old" USING "workflowType"::"text"::"kodus_workflow"."workflow_jobs_workflowtype_enum_old"
        `);
        await queryRunner.query(`
            DROP TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "kodus_workflow"."workflow_jobs_workflowtype_enum_old"
            RENAME TO "workflow_jobs_workflowtype_enum"
        `);
    }
}
