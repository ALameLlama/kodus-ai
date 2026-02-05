import { Body, Controller, Post } from '@nestjs/common';

import { TrackUseCase } from '@libs/analytics/application/use-cases/segment/track.use-case';
import {
    ApiBearerAuth,
    ApiBody,
    ApiNoContentResponse,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import { SegmentTrackDto } from '../dtos/segment-track.dto';

@ApiTags('Segment')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('segment')
export class SegmentController {
    constructor(private readonly trackUseCase: TrackUseCase) {}

    @Post('/track')
    @ApiOperation({
        summary: 'Send event to Segment',
        description:
            'Registers a tracking event in Segment for the specified user.',
    })
    @ApiBody({ type: SegmentTrackDto })
    @ApiNoContentResponse({ description: 'Event recorded' })
    public async track(@Body() body: any) {
        return this.trackUseCase.execute(body);
    }
}
