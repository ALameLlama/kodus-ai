import {
    Body,
    Controller,
    Get,
    Inject,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { CreateOrUpdatePullRequestMessagesUseCase } from '@libs/code-review/application/use-cases/pullRequestMessages/create-or-update-pull-request-messages.use-case';
import { FindByRepositoryOrDirectoryIdPullRequestMessagesUseCase } from '@libs/code-review/application/use-cases/pullRequestMessages/find-by-repo-or-directory.use-case';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import {
    checkPermissions,
    checkRepoPermissions,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { IPullRequestMessages } from '@libs/code-review/domain/pullRequestMessages/interfaces/pullRequestMessages.interface';
import {
    ApiBearerAuth,
    ApiBody,
    ApiNoContentResponse,
    ApiOkResponse,
    ApiOperation,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import { PullRequestMessagesUpsertDto } from '../dtos/pull-request-messages-upsert.dto';
import { PullRequestMessagesResponseDto } from '../dtos/pull-request-messages-response.dto';

@ApiTags('Pull Request Messages')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('pull-request-messages')
export class PullRequestMessagesController {
    constructor(
        private readonly createOrUpdatePullRequestMessagesUseCase: CreateOrUpdatePullRequestMessagesUseCase,
        private readonly findByRepositoryOrDirectoryIdPullRequestMessagesUseCase: FindByRepositoryOrDirectoryIdPullRequestMessagesUseCase,

        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    @Post('/')
    @ApiOperation({
        summary: 'Create or update PR messages',
        description:
            'Creates or updates the review message configuration for a repository or directory.',
    })
    @ApiBody({ type: PullRequestMessagesUpsertDto })
    @ApiNoContentResponse({ description: 'Configuration updated' })
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    public async createOrUpdatePullRequestMessages(
        @Body() body: IPullRequestMessages,
    ) {
        return await this.createOrUpdatePullRequestMessagesUseCase.execute(
            this.request.user,
            body,
        );
    }

    @Get('/find-by-repository-or-directory')
    @ApiOperation({
        summary: 'Get PR messages by repository or directory',
        description:
            'Returns the resolved message configuration for the specified repository or directory.',
    })
    @ApiQuery({ name: 'repositoryId', required: true })
    @ApiQuery({ name: 'directoryId', required: false })
    @ApiOkResponse({ type: PullRequestMessagesResponseDto })
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkRepoPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
            repo: {
                key: {
                    query: 'repositoryId',
                },
            },
        }),
    )
    public async findByRepoOrDirectoryId(
        @Query('repositoryId') repositoryId: string,
        @Query('directoryId') directoryId?: string,
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new Error('Organization ID is missing from request');
        }

        return await this.findByRepositoryOrDirectoryIdPullRequestMessagesUseCase.execute(
            organizationId,
            repositoryId,
            directoryId,
        );
    }
}
