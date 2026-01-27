import { Controller, Get, Query } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MetricsEventModel } from './schemas/metrics-event.schema';
import {
    ErrorRateResult,
    ResponseTimeResult,
    PipelinePerformanceResult,
    MetricsSummary,
} from './interfaces/metrics.interfaces';

@Controller('internal/metrics')
export class MetricsController {
    constructor(
        @InjectModel(MetricsEventModel.name)
        private readonly metricsModel: Model<MetricsEventModel>,
    ) {}

    @Get('error-rates')
    async getErrorRates(
        @Query('window') windowParam?: string,
    ): Promise<ErrorRateResult[]> {
        const windowMinutes = Math.min(
            Math.max(parseInt(windowParam ?? '15', 10) || 15, 1),
            1440,
        );
        const since = new Date(Date.now() - windowMinutes * 60 * 1000);

        const pipeline = [
            {
                $match: {
                    name: { $in: ['http_errors_total', 'http_request_total'] },
                    recordedAt: { $gte: since },
                },
            },
            {
                $group: {
                    _id: {
                        component: { $ifNull: ['$labels.component', 'unknown'] },
                        name: '$name',
                    },
                    count: { $sum: '$value' },
                },
            },
        ];

        const results = await this.metricsModel.aggregate(pipeline);

        const componentMap = new Map<
            string,
            { errors: number; requests: number }
        >();

        for (const r of results) {
            const component = r._id.component;
            if (!componentMap.has(component)) {
                componentMap.set(component, { errors: 0, requests: 0 });
            }
            const entry = componentMap.get(component)!;
            if (r._id.name === 'http_errors_total') {
                entry.errors += r.count;
            } else {
                entry.requests += r.count;
            }
        }

        return Array.from(componentMap.entries()).map(
            ([component, { errors, requests }]) => ({
                component,
                totalRequests: requests,
                totalErrors: errors,
                errorRate:
                    requests > 0
                        ? Math.round((errors / requests) * 10000) / 100
                        : 0,
                windowMinutes,
            }),
        );
    }

    @Get('review-response-times')
    async getReviewResponseTimes(
        @Query('hours') hoursParam?: string,
    ): Promise<ResponseTimeResult> {
        const hours = Math.min(
            Math.max(parseInt(hoursParam ?? '24', 10) || 24, 1),
            168,
        );
        const since = new Date(Date.now() - hours * 60 * 60 * 1000);

        const results = await this.metricsModel
            .find({
                name: 'code_review_duration_ms',
                recordedAt: { $gte: since },
            })
            .select('value')
            .lean();

        if (results.length === 0) {
            return {
                p50: 0,
                p95: 0,
                avg: 0,
                max: 0,
                count: 0,
                windowHours: hours,
            };
        }

        const values = results.map((r) => r.value).sort((a, b) => a - b);
        const sum = values.reduce((s, v) => s + v, 0);

        return {
            p50: this.percentile(values, 50),
            p95: this.percentile(values, 95),
            avg: Math.round(sum / values.length),
            max: values[values.length - 1],
            count: values.length,
            windowHours: hours,
        };
    }

    @Get('pipeline-performance')
    async getPipelinePerformance(
        @Query('hours') hoursParam?: string,
    ): Promise<PipelinePerformanceResult[]> {
        const hours = Math.min(
            Math.max(parseInt(hoursParam ?? '24', 10) || 24, 1),
            168,
        );
        const since = new Date(Date.now() - hours * 60 * 60 * 1000);

        const pipeline = [
            {
                $match: {
                    name: 'pipeline_stage_duration_ms',
                    recordedAt: { $gte: since },
                },
            },
            {
                $group: {
                    _id: {
                        pipeline: '$labels.pipeline',
                        stage: '$labels.stage',
                    },
                    avgDurationMs: { $avg: '$value' },
                    count: { $sum: 1 },
                },
            },
            {
                $sort: { '_id.pipeline': 1 as const, avgDurationMs: -1 as const },
            },
        ];

        const results = await this.metricsModel.aggregate(pipeline);

        return results.map((r) => ({
            pipeline: r._id.pipeline ?? 'unknown',
            stage: r._id.stage ?? 'unknown',
            avgDurationMs: Math.round(r.avgDurationMs),
            count: r.count,
        }));
    }

    @Get('summary')
    async getSummary(): Promise<MetricsSummary> {
        const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

        const [errorRates, reviewStats] = await Promise.all([
            this.getErrorRates('15'),
            this.getReviewSummary(oneHourAgo),
        ]);

        return {
            errorRate: errorRates,
            reviewsProcessed: reviewStats.processed,
            reviewsFailed: reviewStats.failed,
            avgReviewDurationMs: reviewStats.avgDuration,
            timestamp: new Date().toISOString(),
        };
    }

    private async getReviewSummary(since: Date): Promise<{
        processed: number;
        failed: number;
        avgDuration: number;
    }> {
        const [durationResults, failedCount] = await Promise.all([
            this.metricsModel
                .find({
                    name: 'code_review_duration_ms',
                    recordedAt: { $gte: since },
                })
                .select('value')
                .lean(),
            this.metricsModel.countDocuments({
                name: 'code_review_errors_total',
                recordedAt: { $gte: since },
            }),
        ]);

        const values = durationResults.map((r) => r.value);
        const avg =
            values.length > 0
                ? Math.round(
                      values.reduce((s, v) => s + v, 0) / values.length,
                  )
                : 0;

        return {
            processed: values.length,
            failed: failedCount,
            avgDuration: avg,
        };
    }

    private percentile(sortedValues: number[], p: number): number {
        if (sortedValues.length === 0) return 0;
        const index = Math.ceil((p / 100) * sortedValues.length) - 1;
        return sortedValues[Math.max(0, index)];
    }
}
