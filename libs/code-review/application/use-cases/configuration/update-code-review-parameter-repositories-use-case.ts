import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { createLogger } from '@kodus/flow';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    CODE_REVIEW_SETTINGS_LOG_SERVICE_TOKEN,
    ICodeReviewSettingsLogService,
} from '@libs/ee/codeReviewSettingsLog/domain/contracts/codeReviewSettingsLog.service.contract';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ParametersEntity } from '@libs/organization/domain/parameters/entities/parameters.entity';
import { IntegrationConfigKey, ParametersKey } from '@libs/core/domain/enums';
import { CodeReviewParameter } from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';
import {
    ActionType,
    ConfigLevel,
} from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';

interface ICodeRepository {
    avatar_url?: string;
    default_branch: string;
    http_url: string;
    id: string;
    language: string;
    name: string;
    organizationName: string;
    selected: string;
    visibility: 'private' | 'public';
}

@Injectable()
export class UpdateCodeReviewParameterRepositoriesUseCase {
    private readonly logger = createLogger(
        UpdateCodeReviewParameterRepositoriesUseCase.name,
    );

    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(CODE_REVIEW_SETTINGS_LOG_SERVICE_TOKEN)
        private readonly codeReviewSettingsLogService: ICodeReviewSettingsLogService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: {
                organization: { uuid: string };
                uuid: string;
                email: string;
            };
        },
    ) {}

    async execute(body: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<ParametersEntity<ParametersKey.CODE_REVIEW_CONFIG> | boolean> {
        try {
            const { organizationAndTeamData } = body;

            const codeReviewConfigs = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                organizationAndTeamData,
            );

            if (!codeReviewConfigs) {
                return false;
            }

            const codeRepositories =
                await this.integrationConfigService.findIntegrationConfigFormatted<
                    ICodeRepository[]
                >(IntegrationConfigKey.REPOSITORIES, organizationAndTeamData);

            const filteredRepositories = codeRepositories.map((repository) => {
                return {
                    id: repository.id,
                    name: repository.name,
                };
            });

            const codeReviewRepositories =
                codeReviewConfigs.configValue.repositories;

            const commonRepositories = codeReviewRepositories.filter(
                (repository) =>
                    filteredRepositories.some(
                        (filteredRepo) => filteredRepo.id === repository.id,
                    ),
            );

            const codeReviewRepositoryIds = codeReviewRepositories.map(
                (repo) => repo.id,
            );

            const newRepositories = filteredRepositories.filter(
                (repository) =>
                    !codeReviewRepositoryIds.includes(repository.id),
            );

            const updatedRepositories = Array.from(
                new Map(
                    [...commonRepositories, ...newRepositories].map((repo) => [
                        repo.id,
                        repo,
                    ]),
                ).values(),
            );
            const updatedCodeReviewConfigValue = {
                ...codeReviewConfigs.configValue,
                repositories: updatedRepositories,
            } as CodeReviewParameter;

            const result = await this.createOrUpdateParametersUseCase.execute(
                ParametersKey.CODE_REVIEW_CONFIG,
                updatedCodeReviewConfigValue,
                organizationAndTeamData,
            );

            // Identificar repositories adicionados e removidos para o log
            const addedRepositories = newRepositories;
            const removedRepositories = codeReviewRepositories.filter(
                (repository) =>
                    !commonRepositories.some(
                        (commonRepo) => commonRepo.id === repository.id,
                    ),
            );

            try {
                if (
                    addedRepositories.length > 0 ||
                    removedRepositories.length > 0
                ) {
                    const actionType =
                        addedRepositories.length > 0 &&
                        removedRepositories.length > 0
                            ? ActionType.EDIT
                            : addedRepositories.length > 0
                              ? ActionType.ADD
                              : ActionType.DELETE;

                    this.codeReviewSettingsLogService.registerRepositoriesLog({
                        organizationAndTeamData: {
                            ...body.organizationAndTeamData,
                            organizationId: this.request.user.organization.uuid,
                        },
                        userInfo: {
                            userId: this.request.user.uuid,
                            userEmail: this.request.user.email,
                        },
                        actionType: actionType,
                        addedRepositories,
                        removedRepositories,
                        configLevel: ConfigLevel.GLOBAL,
                    });
                }
            } catch (error) {
                this.logger.error({
                    message: 'Error saving code review settings log',
                    error: error,
                    context: UpdateCodeReviewParameterRepositoriesUseCase.name,
                    metadata: {
                        organizationAndTeamData: organizationAndTeamData,
                    },
                });
            }

            return result;
        } catch (error) {
            this.logger.error({
                message:
                    'Error creating or updating code review parameter repositories',
                context: UpdateCodeReviewParameterRepositoriesUseCase.name,
                error: error,
                metadata: {
                    parametersKey: ParametersKey.CODE_REVIEW_CONFIG,
                    organizationAndTeamData: body.organizationAndTeamData,
                },
            });
            throw new Error('Error creating or updating parameters');
        }
    }
}
