import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SegmentTrackDto {
    @ApiProperty({ example: 'user_123' })
    userId: string;

    @ApiProperty({ example: 'repository.connected' })
    event: string;

    @ApiPropertyOptional({
        type: Object,
        description: 'Event properties payload forwarded to Segment.',
        additionalProperties: true,
        example: { repositoryId: '1135722979', provider: 'github' },
    })
    properties?: Record<string, unknown>;
}
