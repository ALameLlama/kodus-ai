import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsArray,
    IsNotEmpty,
    IsOptional,
    IsString,
    Min,
    Max,
} from 'class-validator';

export class OnboardingReviewModeSignalsQueryDto {
    @IsNotEmpty()
    @IsString()
    @ApiProperty()
    teamId: string;

    @IsArray()
    @IsString({ each: true })
    @Transform(({ value }) => {
        if (Array.isArray(value)) return value;
        if (typeof value === 'string') {
            return value
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean);
        }
        return [];
    })
    @ApiProperty()
    repositoryIds: string[];

    @IsOptional()
    @Transform(({ value }) => parseInt(value))
    @Min(1)
    @Max(50)
    @ApiPropertyOptional()
    limit?: number = 10;
}
