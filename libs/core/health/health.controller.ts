import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';
import { DatabaseHealthIndicator } from './database.health';
import { ApplicationHealthIndicator } from './application.health';

@Controller('health')
export class HealthController {
    constructor(
        private readonly databaseHealthIndicator: DatabaseHealthIndicator,
        private readonly applicationHealthIndicator: ApplicationHealthIndicator,
    ) {}

    @Get()
    async check(@Res() res: Response) {
        try {
            // Verify application
            const appResult =
                await this.applicationHealthIndicator.isApplicationHealthy();
            const appHealthy = appResult.application.status === 'up';

            // Verify database
            const dbResult =
                await this.databaseHealthIndicator.isDatabaseHealthy();
            const dbHealthy = dbResult.database.status === 'up';

            // Both must be UP
            const overallHealthy = appHealthy && dbHealthy;

            const response = {
                status: overallHealthy ? 'ok' : 'error',
                timestamp: new Date().toISOString(),
                details: {
                    application: appResult.application,
                    database: dbResult.database,
                },
            };

            const statusCode = overallHealthy
                ? HttpStatus.OK
                : HttpStatus.SERVICE_UNAVAILABLE;

            return res.status(statusCode).json(response);
        } catch (error) {
            const response = {
                status: 'error',
                error: 'Health check failed: ' + error,
                timestamp: new Date().toISOString(),
            };

            return res.status(HttpStatus.SERVICE_UNAVAILABLE).json(response);
        }
    }

    @Get('ready')
    readyCheck(@Res() res: Response) {
        return this.check(res);
    }

    @Get('simple')
    simpleCheck(@Res() res: Response) {
        return res.status(HttpStatus.OK).json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            message: 'API is running',
            uptime: Math.floor(process.uptime()),
        });
    }

    @Get('live')
    liveCheck(@Res() res: Response) {
        return this.simpleCheck(res);
    }
}
