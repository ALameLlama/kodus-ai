import {
    IsArray,
    IsEnum,
    IsNotEmpty,
    IsOptional,
    IsString,
    ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { KodyRulesScope } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { KodyRuleSeverity } from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class ImportFastKodyRuleExampleDto {
    @ApiProperty({ example: 'if (value == null) return;' })
    snippet: string;

    @ApiProperty({ example: true })
    isCorrect: boolean;
}

class ImportFastKodyRuleItemDto {
    @ApiProperty({ example: 'Avoid null comparisons' })
    @IsString()
    @IsNotEmpty()
    title: string;

    @ApiProperty({
        example:
            'Avoid comparing to null; prefer strict checks or type guards.',
    })
    @IsString()
    @IsNotEmpty()
    rule: string;

    @ApiProperty({ example: 'src/services/user.service.ts' })
    @IsString()
    @IsNotEmpty()
    path: string;

    @ApiProperty({ example: 'src/services/user.service.ts' })
    @IsString()
    @IsNotEmpty()
    sourcePath: string;

    @ApiProperty({ example: '1135722979' })
    @IsString()
    @IsNotEmpty()
    repositoryId: string;

    @IsOptional()
    @IsEnum(KodyRuleSeverity)
    @ApiPropertyOptional({
        enum: KodyRuleSeverity,
        enumName: 'KodyRuleSeverity',
    })
    severity?: KodyRuleSeverity;

    @IsOptional()
    @IsEnum(KodyRulesScope)
    @ApiPropertyOptional({ enum: KodyRulesScope, enumName: 'KodyRulesScope' })
    scope?: KodyRulesScope;

    @ApiPropertyOptional({
        type: ImportFastKodyRuleExampleDto,
        isArray: true,
        description: 'Example snippets for the rule.',
    })
    @IsOptional()
    examples?: ImportFastKodyRuleExampleDto[];
}

export class ImportFastKodyRulesDto {
    @ApiProperty({
        format: 'uuid',
        example: 'c33ef663-70e7-4f43-9605-0bbef979b8e0',
    })
    @IsString()
    @IsNotEmpty()
    teamId: string;

    @ApiProperty({ type: ImportFastKodyRuleItemDto, isArray: true })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => ImportFastKodyRuleItemDto)
    rules: ImportFastKodyRuleItemDto[];
}
