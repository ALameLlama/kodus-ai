import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';

import type { AutomationExecutionModel } from './automationExecution.model';

@Entity('code_review_execution')
@Index('IDX_cre_automation_exec_created', ['automationExecution', 'createdAt'])
@Index('IDX_cre_stage_status', ['stageName', 'status'])
export class CodeReviewExecutionModel extends CoreModel {
    @ManyToOne('AutomationExecutionModel', 'uuid')
    @JoinColumn({
        name: 'automation_execution_id',
        referencedColumnName: 'uuid',
    })
    automationExecution: AutomationExecutionModel;

    @Column({
        type: 'enum',
        enum: AutomationStatus,
        default: AutomationStatus.PENDING,
    })
    status: AutomationStatus;

    @Column({
        type: 'varchar',
        nullable: true,
        name: 'stage_name',
    })
    stageName?: string;

    @Column({
        type: 'text',
        nullable: true,
    })
    message?: string;
}
