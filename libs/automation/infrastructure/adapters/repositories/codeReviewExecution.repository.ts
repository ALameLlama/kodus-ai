import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository, In } from 'typeorm';

import { ICodeReviewExecutionRepository } from '@libs/automation/domain/codeReviewExecutions/contracts/codeReviewExecution.repository.contract';
import { CodeReviewExecutionEntity } from '@libs/automation/domain/codeReviewExecutions/entities/codeReviewExecution.entity';
import { CodeReviewExecution } from '@libs/automation/domain/codeReviewExecutions/interfaces/codeReviewExecution.interface';
import { createLogger } from '@kodus/flow';
import {
    mapSimpleModelsToEntities,
    mapSimpleModelToEntity,
} from '@libs/core/infrastructure/repositories/mappers';
import { createNestedConditions } from '@libs/core/infrastructure/repositories/model/filters';

import { CodeReviewExecutionModel } from './schemas/codeReviewExecution.model';

@Injectable()
export class CodeReviewExecutionRepository<
    T,
> implements ICodeReviewExecutionRepository<T> {
    private readonly logger = createLogger(CodeReviewExecutionRepository.name);

    constructor(
        @InjectRepository(CodeReviewExecutionModel)
        private readonly codeReviewExecutionRepository: Repository<CodeReviewExecutionModel>,
    ) {}

    async create(
        codeReviewExecution: Omit<
            CodeReviewExecution<T>,
            'uuid' | 'createdAt' | 'updatedAt'
        >,
    ): Promise<CodeReviewExecutionEntity<T> | null> {
        try {
            const newObj =
                this.codeReviewExecutionRepository.create(codeReviewExecution);

            if (!newObj) {
                this.logger.warn({
                    message: 'Failed to create code review execution model',
                    context: CodeReviewExecutionRepository.name,
                    metadata: { codeReviewExecution },
                });

                return null;
            }

            const saved = await this.codeReviewExecutionRepository.save(newObj);

            if (!saved) {
                this.logger.warn({
                    message: 'Failed to save code review execution model',
                    context: CodeReviewExecutionRepository.name,
                    metadata: { codeReviewExecution },
                });

                return null;
            }

            return mapSimpleModelToEntity(saved, CodeReviewExecutionEntity);
        } catch (error) {
            this.logger.error({
                message: 'Error creating code review execution',
                error,
                context: CodeReviewExecutionRepository.name,
                metadata: { codeReviewExecution },
            });

            return null;
        }
    }

    async update(
        filter: Partial<CodeReviewExecution<T>>,
        codeReviewExecution: Partial<
            Omit<CodeReviewExecution<T>, 'uuid' | 'createdAt' | 'updatedAt'>
        >,
    ): Promise<CodeReviewExecutionEntity<T> | null> {
        try {
            const conditions = this.getFilterConditions(filter);

            const update = await this.codeReviewExecutionRepository.update(
                conditions,
                codeReviewExecution,
            );

            if (update.affected === 0) {
                this.logger.warn({
                    message: `No code review execution updated`,
                    context: CodeReviewExecutionRepository.name,
                    metadata: { conditions, codeReviewExecution },
                });
                return null;
            }

            const updated = await this.codeReviewExecutionRepository.findOne({
                where: conditions,
            });

            if (!updated) {
                this.logger.warn({
                    message: `No code review execution found after update`,
                    context: CodeReviewExecutionRepository.name,
                    metadata: { conditions, codeReviewExecution },
                });
                return null;
            }

            return mapSimpleModelToEntity(updated, CodeReviewExecutionEntity);
        } catch (error) {
            this.logger.error({
                message: 'Error updating code review execution',
                error,
                context: CodeReviewExecutionRepository.name,
                metadata: { filter, codeReviewExecution },
            });

            return null;
        }
    }

    async find(
        filter?: Partial<CodeReviewExecution<T>>,
    ): Promise<CodeReviewExecutionEntity<T>[]> {
        try {
            const conditions = this.getFilterConditions(filter);

            const found = await this.codeReviewExecutionRepository.find({
                where: conditions,
            });

            if (!found || found.length === 0) {
                this.logger.warn({
                    message: 'No code review executions found',
                    context: CodeReviewExecutionRepository.name,
                    metadata: { filter },
                });

                return [];
            }

            return mapSimpleModelsToEntities(found, CodeReviewExecutionEntity);
        } catch (error) {
            this.logger.error({
                message: 'Error finding code review executions',
                error,
                context: CodeReviewExecutionRepository.name,
                metadata: { filter },
            });

            return [];
        }
    }

    async findOne(
        filter?: Partial<CodeReviewExecution<T>>,
    ): Promise<CodeReviewExecutionEntity<T> | null> {
        try {
            const conditions = this.getFilterConditions(filter);

            const found = await this.codeReviewExecutionRepository.findOne({
                where: conditions,
            });

            if (!found) {
                this.logger.warn({
                    message: 'Code review execution not found',
                    context: CodeReviewExecutionRepository.name,
                    metadata: { filter },
                });

                return null;
            }

            return mapSimpleModelToEntity(found, CodeReviewExecutionEntity);
        } catch (error) {
            this.logger.error({
                message: 'Error finding code review execution',
                error,
                context: CodeReviewExecutionRepository.name,
                metadata: { filter },
            });

            return null;
        }
    }

    async findManyByAutomationExecutionIds(
        uuids: string[],
    ): Promise<CodeReviewExecutionEntity<T>[]> {
        if (!uuids.length) {
            return [];
        }

        try {
            const found = await this.codeReviewExecutionRepository.find({
                select: {
                    uuid: true,
                    createdAt: true,
                    updatedAt: true,
                    status: true,
                    stageName: true,
                    message: true,
                    automationExecution: {
                        uuid: true,
                    },
                },
                relations: ['automationExecution'],
                where: {
                    automationExecution: { uuid: In(uuids) },
                } as FindOptionsWhere<CodeReviewExecutionModel>,
            });

            return mapSimpleModelsToEntities(found, CodeReviewExecutionEntity);
        } catch (error) {
            this.logger.error({
                message:
                    'Error finding code review executions by automation ids',
                error,
                context: CodeReviewExecutionRepository.name,
                metadata: { uuids },
            });
            return [];
        }
    }

    async delete(uuid: string): Promise<boolean> {
        try {
            const res = await this.codeReviewExecutionRepository.delete({
                uuid,
            });

            return res.affected > 0;
        } catch (error) {
            this.logger.error({
                message: 'Error deleting code review execution',
                error,
                context: CodeReviewExecutionRepository.name,
                metadata: { uuid },
            });

            return false;
        }
    }

    private getFilterConditions(
        filter: Partial<CodeReviewExecution<T>>,
    ): FindOptionsWhere<CodeReviewExecutionModel> {
        const { automationExecution, ...restFilter } = filter || {};

        const automationExecutionCondition = createNestedConditions(
            'automationExecution',
            automationExecution,
        );

        return {
            ...restFilter,
            ...automationExecutionCondition,
        };
    }
}
