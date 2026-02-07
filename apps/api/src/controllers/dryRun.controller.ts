import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Inject,
    OnApplicationShutdown,
    Param,
    Post,
    Query,
    Sse,
    UseGuards,
} from '@nestjs/common';
import { interval, merge, Subject } from 'rxjs';
import { map, takeUntil } from 'rxjs/operators';
import { ExecuteDryRunDto } from '../dtos/execute-dry-run.dto';
import { ExecuteDryRunUseCase } from '@libs/dryRun/application/use-cases/execute-dry-run.use-case';
import { SseDryRunUseCase } from '@libs/dryRun/application/use-cases/sse-dry-run.use-case';
import { GetStatusDryRunUseCase } from '@libs/dryRun/application/use-cases/get-status-dry-run.use-case';
import { GetDryRunUseCase } from '@libs/dryRun/application/use-cases/get-dry-run.use-case';
import { ListDryRunsUseCase } from '@libs/dryRun/application/use-cases/list-dry-runs.use-case';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { REQUEST } from '@nestjs/core';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import {
    checkPermissions,
    checkRepoPermissions,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import {
    ApiBearerAuth,
    ApiCreatedResponse,
    ApiOkResponse,
    ApiOperation,
    ApiProduces,
    ApiTags,
} from '@nestjs/swagger';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import {
    ApiArrayResponseDto,
    ApiObjectResponseDto,
    ApiStringResponseDto,
} from '../dtos/api-response.dto';

@ApiTags('Dry Run')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('dry-run')
export class DryRunController implements OnApplicationShutdown {
    private readonly shutdown$ = new Subject<void>();

    constructor(
        private readonly executeDryRunUseCase: ExecuteDryRunUseCase,
        private readonly getStatusDryRunUseCase: GetStatusDryRunUseCase,
        private readonly sseDryRunUseCase: SseDryRunUseCase,
        private readonly getDryRunUseCase: GetDryRunUseCase,
        private readonly listDryRunsUseCase: ListDryRunsUseCase,

        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    onApplicationShutdown() {
        this.shutdown$.next();
        this.shutdown$.complete();
    }

    @Post('execute')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkRepoPermissions({
            action: Action.Manage,
            resource: ResourceType.CodeReviewSettings,
            repo: {
                key: {
                    body: 'repositoryId',
                },
            },
        }),
    )
    @ApiOperation({
        summary: 'Execute dry run',
        description: 'Start a dry-run execution and return its correlation id.',
    })
    @ApiCreatedResponse({ type: ApiStringResponseDto })
    execute(
        @Body()
        body: ExecuteDryRunDto,
    ) {
        if (!this.request.user?.organization?.uuid) {
            throw new BadRequestException(
                'Organization UUID is missing in the request',
            );
        }

        const correlationId = this.executeDryRunUseCase.execute({
            organizationAndTeamData: {
                organizationId: this.request.user.organization.uuid,
                teamId: body.teamId,
            },
            repositoryId: body.repositoryId,
            prNumber: body.prNumber,
        });

        return correlationId;
    }

    @Get('status/:correlationId')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Manage,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'Get dry run status',
        description: 'Return current status for a dry-run execution.',
    })
    @ApiOkResponse({ type: ApiStringResponseDto })
    status(
        @Param('correlationId') correlationId: string,
        @Query('teamId') teamId: string,
    ) {
        if (!this.request.user?.organization?.uuid) {
            throw new BadRequestException(
                'Organization UUID is missing in the request',
            );
        }

        return this.getStatusDryRunUseCase.execute({
            organizationAndTeamData: {
                organizationId: this.request.user.organization.uuid,
                teamId,
            },
            correlationId,
        });
    }

    @Sse('events/:correlationId')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Manage,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'Stream dry run events',
        description: 'Server-sent events with dry-run pipeline updates.',
    })
    @ApiProduces('text/event-stream')
    events(
        @Param('correlationId') correlationId: string,
        @Query('teamId') teamId: string,
    ) {
        if (!this.request.user?.organization?.uuid) {
            throw new BadRequestException(
                'Organization UUID is missing in the request',
            );
        }

        const stream$ = this.sseDryRunUseCase.execute({
            correlationId,
            organizationAndTeamData: {
                teamId,
                organizationId: this.request.user.organization.uuid,
            },
        });

        const heartbeat$ = interval(15000).pipe(
            map(() => ({ type: 'ping', data: 'heartbeat' })),
        );

        return merge(stream$, heartbeat$).pipe(takeUntil(this.shutdown$));
    }

    @Get('')
    @UseGuards(PolicyGuard)
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Manage,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'List dry runs',
        description: 'Lists dry run executions for the given filters and team.',
    })
    @ApiOkResponse({ type: ApiArrayResponseDto })
    listDryRuns(
        @Query('teamId') teamId: string,
        @Query('repositoryId') repositoryId?: string,
        @Query('directoryId') directoryId?: string,
        @Query('startDate') startDate?: string,
        @Query('endDate') endDate?: string,
        @Query('prNumber') prNumber?: string,
        @Query('status') status?: string,
    ) {
        if (!this.request.user?.organization?.uuid) {
            throw new BadRequestException(
                'Organization UUID is missing in the request',
            );
        }

        return this.listDryRunsUseCase.execute({
            organizationAndTeamData: {
                organizationId: this.request.user.organization.uuid,
                teamId,
            },
            filters: {
                repositoryId,
                directoryId,
                status,
                startDate,
                endDate,
                prNumber,
            },
        });
    }

    @Get(':correlationId')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Manage,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'Get dry run details',
        description: 'Return dry-run details by correlation id.',
    })
    @ApiOkResponse({ type: ApiObjectResponseDto })
    getDryRun(
        @Param('correlationId') correlationId: string,
        @Query('teamId') teamId: string,
    ) {
        if (!this.request.user?.organization?.uuid) {
            throw new BadRequestException(
                'Organization UUID is missing in the request',
            );
        }

        return this.getDryRunUseCase.execute({
            organizationAndTeamData: {
                organizationId: this.request.user.organization.uuid,
                teamId,
            },
            correlationId,
        });
    }
}
