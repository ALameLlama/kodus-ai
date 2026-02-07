import { IsNumber, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ExecuteDryRunDto {
    @IsString()
    @ApiProperty({ example: 'c33ef663-70e7-4f43-9605-0bbef979b8e0' })
    teamId: string;

    @IsString()
    @ApiProperty({ example: '1135722979' })
    repositoryId: string;

    @IsNumber()
    @ApiProperty({ type: Number, example: 128 })
    prNumber: number;
}
