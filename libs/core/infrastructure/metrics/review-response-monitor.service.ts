import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createLogger } from '@kodus/flow';
import { MetricsEventModel } from './schemas/metrics-event.schema';
import { IncidentManagerService } from '../incident/incident-manager.service';
import { MetricsCollectorService } from './metrics-collector.service';

@Injectable()
export class ReviewResponseMonitorService {
    private readonly logger = createLogger(
        ReviewResponseMonitorService.name,
    );

    private readonly p95ThresholdMs: number;
    private readonly p95CriticalMs: number;

    constructor(
        @InjectModel(MetricsEventModel.name)
        private readonly metricsModel: Model<MetricsEventModel>,
        private readonly incidentManager: IncidentManagerService,
        private readonly metricsCollector: MetricsCollectorService,
        private readonly configService: ConfigService,
    ) {
        this.p95ThresholdMs = this.configService.get<number>(
            'REVIEW_RESPONSE_P95_THRESHOLD_MS',
            600_000, // 10 minutes
        );
        this.p95CriticalMs = this.configService.get<number>(
            'REVIEW_RESPONSE_P95_CRITICAL_MS',
            1_200_000, // 20 minutes
        );
    }

    @Cron('*/5 * * * *') // every 5 minutes
    async checkReviewResponseTimes(): Promise<void> {
        try {
            const since = new Date(Date.now() - 30 * 60 * 1000); // last 30 minutes

            const results = await this.metricsModel
                .find({
                    name: 'code_review_duration_ms',
                    recordedAt: { $gte: since },
                })
                .select('value')
                .lean();

            if (results.length === 0) {
                // No reviews in window, but still ping to show monitor is alive
                await this.incidentManager.pingHeartbeat(
                    'API_BETTERSTACK_HEARTBEAT_REVIEW_MONITOR_URL',
                );
                return;
            }

            const values = results
                .map((r) => r.value)
                .sort((a, b) => a - b);

            const p50 = this.percentile(values, 50);
            const p95 = this.percentile(values, 95);
            const avg =
                values.reduce((sum, v) => sum + v, 0) / values.length;

            this.metricsCollector.recordGauge('review_response_p50_ms', p50, {});
            this.metricsCollector.recordGauge('review_response_p95_ms', p95, {});
            this.metricsCollector.recordGauge('review_response_avg_ms', avg, {});

            if (p95 >= this.p95ThresholdMs) {
                await this.incidentManager.failHeartbeat(
                    'API_BETTERSTACK_HEARTBEAT_REVIEW_MONITOR_URL',
                    `Code review p95 response time is ${this.formatDuration(p95)} (threshold: ${this.formatDuration(this.p95ThresholdMs)}). p50=${this.formatDuration(p50)}, avg=${this.formatDuration(avg)}, count=${values.length} in last 30 minutes.`,
                );
            } else {
                await this.incidentManager.pingHeartbeat(
                    'API_BETTERSTACK_HEARTBEAT_REVIEW_MONITOR_URL',
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Failed to check review response times',
                context: ReviewResponseMonitorService.name,
                error: error instanceof Error ? error : undefined,
                metadata: {
                    p95ThresholdMs: this.p95ThresholdMs,
                },
            });
        }
    }

    private percentile(sortedValues: number[], p: number): number {
        if (sortedValues.length === 0) return 0;
        const index = Math.ceil((p / 100) * sortedValues.length) - 1;
        return sortedValues[Math.max(0, index)];
    }

    private formatDuration(ms: number): string {
        if (ms < 1000) return `${ms.toFixed(0)}ms`;
        if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
        return `${(ms / 60_000).toFixed(1)}min`;
    }

}
