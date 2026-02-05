import { Transform, Type } from 'class-transformer';
import {
    IsOptional,
    IsString,
    Min,
    Max,
    IsBoolean,
    IsInt,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class EnrichedPullRequestsQueryDto {
    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    repositoryId?: string;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    repositoryName?: string;

    @IsOptional()
    @Transform(({ value }) => parseInt(value))
    @Min(1)
    @Max(100)
    @ApiPropertyOptional()
    limit?: number = 30;

    @IsOptional()
    @Transform(({ value }) => parseInt(value))
    @Min(1)
    @ApiPropertyOptional()
    page?: number = 1;

    @IsOptional()
    @IsBoolean()
    @Type(() => String)
    @Transform(({ value }) => {
        if (value === undefined || value === null || value === '') {
            return undefined;
        }

        const normalized = String(value).trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;

        return undefined;
    })
    @ApiPropertyOptional()
    hasSentSuggestions?: boolean;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    pullRequestTitle?: string;

    @IsOptional()
    @Transform(({ value }) => parseInt(value))
    @IsInt()
    @ApiPropertyOptional()
    pullRequestNumber?: number;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    teamId?: string;
}
