import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStageNameCodeReviewpipeline1769537769049 implements MigrationInterface {
    name = 'AddStageNameCodeReviewpipeline1769537769049';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "code_review_execution"
            ADD "stage_name" character varying
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_cre_stage_status" ON "code_review_execution" ("stage_name", "status")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_cre_automation_exec_created" ON "code_review_execution" ("automation_execution_id", "createdAt")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX IF EXISTS "public"."IDX_cre_automation_exec_created"
        `);
        await queryRunner.query(`
            DROP INDEX IF EXISTS "public"."IDX_cre_stage_status"
        `);
        await queryRunner.query(`
            ALTER TABLE "code_review_execution" DROP COLUMN "stage_name"
        `);
    }
}
