import { Module } from '@nestjs/common';
import { DevtoolsModule } from '@nestjs/devtools-integration';
import { SharedMongoModule } from '@libs/shared/database/shared-mongo.module';
import { SharedPostgresModule } from '@libs/shared/database/shared-postgres.module';
import { SharedConfigModule } from '@libs/shared/infrastructure/shared-config.module';
import { SharedLogModule } from '@libs/shared/infrastructure/shared-log.module';
import { RabbitMQWrapperModule } from '@libs/core/infrastructure/queue/rabbitmq.module';
import { LLMModule } from '@kodus/kodus-common/llm';
import { LoggerWrapperService } from '@libs/core/log/loggerWrapper.service';
import { AutomationModule } from '@libs/automation/modules/automation.module';
import { CodebaseModule } from '@libs/code-review/modules/codebase.module';
import { CodeReviewFeedbackModule } from '@libs/code-review/modules/codeReviewFeedback.module';
import { PlatformModule } from '@libs/platform/modules/platform.module';

import { SharedObservabilityModule } from '@libs/shared/infrastructure/shared-observability.module';
import { IncidentModule } from '@libs/core/infrastructure/incident/incident.module';
import { MetricsModule } from '@libs/core/infrastructure/metrics/metrics.module';
import { ErrorRateMonitorService } from '@libs/core/infrastructure/metrics/error-rate-monitor.service';
import { ReviewResponseMonitorService } from '@libs/core/infrastructure/metrics/review-response-monitor.service';
import { WorkflowModule } from '@libs/core/workflow/modules/workflow.module';
import { OutboxRelayService } from '@libs/core/workflow/infrastructure/outbox-relay.service';
import { ScheduleModule } from '@nestjs/schedule';
import { WorkerDrainService } from './worker-drain.service';

import { ConfigService } from '@nestjs/config';

@Module({
    imports: [
        DevtoolsModule.registerAsync({
            imports: [SharedConfigModule],
            useFactory: (configService: ConfigService) => ({
                http: configService.get('NODE_ENV') !== 'production',
                port: 8001,
            }),
            inject: [ConfigService],
        }),
        ScheduleModule.forRoot(),
        SharedConfigModule,
        SharedLogModule,
        SharedObservabilityModule,
        IncidentModule,
        MetricsModule,
        SharedPostgresModule.forRoot({ poolSize: 12 }),
        SharedMongoModule.forRoot(),
        RabbitMQWrapperModule.register({ enableConsumers: true }),

        LLMModule.forRoot({
            logger: LoggerWrapperService,
        }),

        WorkflowModule.register({ type: 'worker' }),
        CodebaseModule,
        CodeReviewFeedbackModule,
        AutomationModule,
        PlatformModule,
    ],
    providers: [
        OutboxRelayService,
        WorkerDrainService,
        ErrorRateMonitorService,
        ReviewResponseMonitorService,
    ],
})
export class WorkerModule {}
