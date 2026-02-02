import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddForgejoPlatform1770029746282 implements MigrationInterface {
    name = 'AddForgejoPlatform1770029746282';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Add FORGEJO to the integrations_platform_enum
        await queryRunner.query(`
            ALTER TYPE "public"."integrations_platform_enum" ADD VALUE IF NOT EXISTS 'FORGEJO'
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Note: PostgreSQL does not support removing values from enums directly.
        // To fully reverse this migration, you would need to:
        // 1. Create a new enum type without FORGEJO
        // 2. Update all columns using the old enum to use the new one
        // 3. Drop the old enum type
        // 4. Rename the new enum type to the old name
        // This is left as a manual operation if needed.
        console.log('Warning: Cannot remove enum value FORGEJO from integrations_platform_enum. Manual intervention required if rollback is needed.');
    }
}
