import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createLogger } from '@kodus/flow';
import { MetricsEventModel } from './schemas/metrics-event.schema';
import { IncidentManagerService } from '../incident/incident-manager.service';
import { MetricsCollectorService } from './metrics-collector.service';

@Injectable()
export class ErrorRateMonitorService {
    private readonly logger = createLogger(ErrorRateMonitorService.name);

    private readonly thresholdPercent: number;
    private readonly criticalPercent: number;
    private readonly windowMinutes: number;

    constructor(
        @InjectModel(MetricsEventModel.name)
        private readonly metricsModel: Model<MetricsEventModel>,
        private readonly incidentManager: IncidentManagerService,
        private readonly metricsCollector: MetricsCollectorService,
        private readonly configService: ConfigService,
    ) {
        this.thresholdPercent = this.configService.get<number>(
            'METRICS_ERROR_RATE_THRESHOLD_PERCENT',
            10,
        );
        this.criticalPercent = this.configService.get<number>(
            'METRICS_ERROR_RATE_CRITICAL_PERCENT',
            25,
        );
        this.windowMinutes = this.configService.get<number>(
            'METRICS_ERROR_RATE_WINDOW_MINUTES',
            5,
        );
    }

    @Cron(CronExpression.EVERY_MINUTE)
    async checkErrorRate(): Promise<void> {
        try {
            const since = new Date(
                Date.now() - this.windowMinutes * 60 * 1000,
            );

            const [errorCounts, requestCounts] = await Promise.all([
                this.metricsModel.countDocuments({
                    name: 'http_errors_total',
                    recordedAt: { $gte: since },
                }),
                this.metricsModel.countDocuments({
                    name: 'http_request_total',
                    recordedAt: { $gte: since },
                }),
            ]);

            if (requestCounts === 0) {
                // No requests in window, but still ping to show monitor is alive
                await this.incidentManager.pingHeartbeat(
                    'API_BETTERSTACK_HEARTBEAT_ERROR_RATE_URL',
                );
                return;
            }

            const errorRate = (errorCounts / requestCounts) * 100;

            this.metricsCollector.recordGauge(
                'http_error_rate_percent',
                errorRate,
                { window_minutes: String(this.windowMinutes) },
            );

            if (errorRate >= this.thresholdPercent) {
                await this.incidentManager.failHeartbeat(
                    'API_BETTERSTACK_HEARTBEAT_ERROR_RATE_URL',
                    `HTTP error rate is ${errorRate.toFixed(1)}% (threshold: ${this.thresholdPercent}%) over the last ${this.windowMinutes} minutes. Total errors: ${errorCounts}, total requests: ${requestCounts}.`,
                );
            } else {
                await this.incidentManager.pingHeartbeat(
                    'API_BETTERSTACK_HEARTBEAT_ERROR_RATE_URL',
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Failed to check error rate',
                context: ErrorRateMonitorService.name,
                error: error instanceof Error ? error : undefined,
                metadata: {
                    windowMinutes: this.windowMinutes,
                    thresholdPercent: this.thresholdPercent,
                },
            });
        }
    }

}
