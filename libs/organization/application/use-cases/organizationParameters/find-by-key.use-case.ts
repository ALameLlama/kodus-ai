import { decrypt } from '@libs/common/utils/crypto';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@kodus/flow';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersEntity } from '@libs/organization/domain/organizationParameters/entities/organizationParameters.entity';
import { IOrganizationParameters } from '@libs/organization/domain/organizationParameters/interfaces/organizationParameters.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class FindByKeyOrganizationParametersUseCase implements IUseCase {
    private readonly logger = createLogger(
        FindByKeyOrganizationParametersUseCase.name,
    );
    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
    ) {}

    async execute(
        organizationParametersKey: OrganizationParametersKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IOrganizationParameters | null> {
        try {
            const parameter =
                await this.organizationParametersService.findByKey(
                    organizationParametersKey,
                    organizationAndTeamData,
                );

            if (!parameter) {
                return null;
            }

            // Process BYOK configuration by masking API keys
            if (
                organizationParametersKey ===
                OrganizationParametersKey.BYOK_CONFIG
            ) {
                const configValue = parameter.configValue;

                if (
                    configValue &&
                    typeof configValue === 'object' &&
                    (configValue.main?.apiKey || configValue.fallback?.apiKey)
                ) {
                    try {
                        const processedConfig = { ...configValue };

                        // Process main if it exists and has apiKey
                        if (configValue.main?.apiKey) {
                            const decryptedMainApiKey = decrypt(
                                configValue.main.apiKey,
                            );
                            const maskedMainApiKey =
                                this.maskApiKey(decryptedMainApiKey);

                            processedConfig.main = {
                                ...configValue.main,
                                apiKey: maskedMainApiKey,
                            };
                        } else {
                            processedConfig.main = null;
                        }

                        if (configValue.fallback?.apiKey) {
                            const decryptedFallbackApiKey = decrypt(
                                configValue.fallback.apiKey,
                            );
                            const maskedFallbackApiKey = this.maskApiKey(
                                decryptedFallbackApiKey,
                            );

                            processedConfig.fallback = {
                                ...configValue.fallback,
                                apiKey: maskedFallbackApiKey,
                            };
                        } else {
                            processedConfig.fallback = null;
                        }

                        return {
                            uuid: parameter.uuid,
                            configKey: parameter.configKey,
                            configValue: processedConfig,
                            organization: parameter.organization,
                        };
                    } catch (error) {
                        this.logger.error({
                            message: 'Error decrypting API key',
                            context:
                                FindByKeyOrganizationParametersUseCase.name,
                            error: error,
                        });
                        // Return original value in case of decryption error
                        return this.getUpdatedParameters(parameter);
                    }
                }
            }

            const updatedParameters = this.getUpdatedParameters(parameter);

            return updatedParameters;
        } catch (error) {
            this.logger.error({
                message: 'Error finding organization parameters by key',
                context: FindByKeyOrganizationParametersUseCase.name,
                error: error,
                metadata: {
                    organizationParametersKey,
                    organizationAndTeamData,
                },
            });

            throw error;
        }
    }

    private getUpdatedParameters(parameter: OrganizationParametersEntity) {
        return {
            uuid: parameter.uuid,
            configKey: parameter.configKey,
            configValue: parameter.configValue,
            organization: parameter.organization,
        };
    }

    private maskApiKey(apiKey: string): string {
        if (apiKey.length <= 6) {
            return apiKey;
        }
        const firstTwo = apiKey.substring(0, 2);
        const lastThree = apiKey.substring(apiKey.length - 3);
        return `${firstTwo}...${lastThree}`;
    }
}
