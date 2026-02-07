import { IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TeamQueryDto {
    @IsUUID()
    @ApiProperty()
    teamId: string;
}
