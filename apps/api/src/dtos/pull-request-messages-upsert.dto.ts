import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    ConfigLevel,
    PullRequestMessageStatus,
} from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';

export class PullRequestMessageContentUpsertDto {
    @ApiProperty({ example: 'Thanks for the changes! Reviewing now.' })
    content: string;

    @ApiProperty({
        enum: PullRequestMessageStatus,
        enumName: 'PullRequestMessageStatus',
        example: PullRequestMessageStatus.ACTIVE,
    })
    status: PullRequestMessageStatus;
}

export class PullRequestMessagesGlobalSettingsUpsertDto {
    @ApiPropertyOptional({ example: false })
    hideComments?: boolean;

    @ApiPropertyOptional({ example: true })
    suggestionCopyPrompt?: boolean;
}

export class PullRequestMessagesUpsertDto {
    @ApiPropertyOptional({
        description:
            'Optional. It will be replaced by the authenticated user organization.',
        example: '585e32e5-242e-4381-bef4-d2dfc61375f9',
    })
    organizationId?: string;

    @ApiProperty({
        enum: ConfigLevel,
        enumName: 'ConfigLevel',
        example: ConfigLevel.REPOSITORY,
    })
    configLevel: ConfigLevel;

    @ApiPropertyOptional({ example: '1135722979' })
    repositoryId?: string;

    @ApiPropertyOptional({ example: 'src/services' })
    directoryId?: string;

    @ApiPropertyOptional({ type: PullRequestMessageContentUpsertDto })
    startReviewMessage?: PullRequestMessageContentUpsertDto;

    @ApiPropertyOptional({ type: PullRequestMessageContentUpsertDto })
    endReviewMessage?: PullRequestMessageContentUpsertDto;

    @ApiPropertyOptional({ type: PullRequestMessagesGlobalSettingsUpsertDto })
    globalSettings?: PullRequestMessagesGlobalSettingsUpsertDto;
}
