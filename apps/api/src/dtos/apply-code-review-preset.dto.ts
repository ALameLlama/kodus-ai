import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

import { ReviewPreset } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamDataDto } from '@libs/core/domain/dtos/organizationAndTeamData.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApplyCodeReviewPresetDto {
    @IsEnum(ReviewPreset)
    @ApiProperty({
        enum: ReviewPreset,
        enumName: 'ReviewPreset',
        example: ReviewPreset.SPEED,
    })
    preset: ReviewPreset;

    @IsNotEmpty()
    @IsString()
    @ApiProperty({ example: 'c33ef663-70e7-4f43-9605-0bbef979b8e0' })
    teamId: string;

    @IsOptional()
    @ApiPropertyOptional({
        type: OrganizationAndTeamDataDto,
        example: { teamId: 'c33ef663-70e7-4f43-9605-0bbef979b8e0' },
    })
    organizationAndTeamData?: OrganizationAndTeamDataDto;
}
