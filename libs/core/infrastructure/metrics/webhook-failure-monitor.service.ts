import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createLogger } from '@kodus/flow';
import { WorkflowJobModel } from '@libs/core/workflow/infrastructure/repositories/schemas/workflow-job.model';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { IncidentManagerService } from '../incident/incident-manager.service';

@Injectable()
export class WebhookFailureMonitorService {
    private readonly logger = createLogger(
        WebhookFailureMonitorService.name,
    );

    private readonly thresholdPercent: number;
    private readonly windowMinutes: number;

    constructor(
        @InjectRepository(WorkflowJobModel)
        private readonly jobRepository: Repository<WorkflowJobModel>,
        private readonly incidentManager: IncidentManagerService,
        private readonly configService: ConfigService,
    ) {
        this.thresholdPercent = this.configService.get<number>(
            'WEBHOOK_FAILURE_THRESHOLD_PERCENT',
            10,
        );
        this.windowMinutes = this.configService.get<number>(
            'WEBHOOK_FAILURE_WINDOW_MINUTES',
            30,
        );
    }

    @Cron('*/5 * * * *') // every 5 minutes
    async checkWebhookFailureRate(): Promise<void> {
        try {
            const since = new Date(
                Date.now() - this.windowMinutes * 60 * 1000,
            );

            const result = await this.jobRepository
                .createQueryBuilder('job')
                .select(
                    "COUNT(*) FILTER (WHERE job.status = 'FAILED')",
                    'failed',
                )
                .addSelect(
                    "COUNT(*) FILTER (WHERE job.status IN ('COMPLETED', 'FAILED'))",
                    'total',
                )
                .where('job.workflowType = :type', {
                    type: WorkflowType.WEBHOOK_PROCESSING,
                })
                .andWhere('job.updatedAt >= :since', { since })
                .getRawOne();

            const failed = parseInt(result?.failed ?? '0', 10);
            const total = parseInt(result?.total ?? '0', 10);

            if (total === 0) {
                await this.incidentManager.pingHeartbeat(
                    'API_BETTERSTACK_HEARTBEAT_WEBHOOK_URL',
                );
                return;
            }

            const failureRate = (failed / total) * 100;

            if (failureRate >= this.thresholdPercent) {
                await this.incidentManager.failHeartbeat(
                    'API_BETTERSTACK_HEARTBEAT_WEBHOOK_URL',
                    `Webhook failure rate is ${failureRate.toFixed(1)}% (threshold: ${this.thresholdPercent}%) over the last ${this.windowMinutes} minutes. Failed: ${failed}, Total: ${total}.`,
                );
            } else {
                await this.incidentManager.pingHeartbeat(
                    'API_BETTERSTACK_HEARTBEAT_WEBHOOK_URL',
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Failed to check webhook failure rate',
                context: WebhookFailureMonitorService.name,
                error: error instanceof Error ? error : undefined,
                metadata: {
                    windowMinutes: this.windowMinutes,
                    thresholdPercent: this.thresholdPercent,
                },
            });
        }
    }

}
