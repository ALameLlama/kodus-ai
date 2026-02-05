import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { createLogger } from '@kodus/flow';
import { Injectable, OnModuleInit, Optional } from '@nestjs/common';

/**
 * Declares DLQ queues/bindings so messages published to `<base>.dlx` are not dropped.
 *
 * NOTE: This runs on every connection (re)setup via amqp-connection-manager.
 */
@Injectable()
export class RabbitMQDLQInitializer implements OnModuleInit {
    private readonly logger = createLogger(RabbitMQDLQInitializer.name);

    constructor(@Optional() private readonly amqpConnection?: AmqpConnection) {}

    async onModuleInit(): Promise<void> {
        if (!this.amqpConnection) {
            this.logger.warn({
                message:
                    'RabbitMQ connection not available; skipping DLQ setup',
                context: RabbitMQDLQInitializer.name,
            });
            return;
        }

        // managedChannel exists when RabbitMQModule is enabled
        const managedChannel: any = (this.amqpConnection as any).managedChannel;
        if (!managedChannel?.addSetup) {
            this.logger.warn({
                message:
                    'RabbitMQ managedChannel not available; skipping DLQ setup',
                context: RabbitMQDLQInitializer.name,
            });
            return;
        }

        managedChannel.addSetup(async (channel: any) => {
            // Exchanges are also declared in rabbitmq-topology.config.ts, but asserting here is safe/idempotent.
            await channel.assertExchange('workflow.exchange.dlx', 'topic', {
                durable: true,
            });
            await channel.assertExchange('workflow.events.dlx', 'topic', {
                durable: true,
            });
            await channel.assertExchange('orchestrator.exchange.dlx', 'topic', {
                durable: true,
            });

            // Workflow jobs DLQ (captures workflow.job.failed, etc.)
            await channel.assertQueue('workflow.jobs.dlq', {
                durable: true,
                arguments: { 'x-queue-type': 'quorum' },
            });
            await channel.bindQueue(
                'workflow.jobs.dlq',
                'workflow.exchange.dlx',
                '#',
            );

            // Workflow events DLQ (captures workflow.events.dlq, etc.)
            await channel.assertQueue('workflow.events.dlq', {
                durable: true,
                arguments: { 'x-queue-type': 'quorum' },
            });
            await channel.bindQueue(
                'workflow.events.dlq',
                'workflow.events.dlx',
                '#',
            );

            // Orchestrator DLQ (captures orchestrator.exchange.dlx messages)
            await channel.assertQueue('orchestrator.dlq', {
                durable: true,
                arguments: { 'x-queue-type': 'quorum' },
            });
            await channel.bindQueue(
                'orchestrator.dlq',
                'orchestrator.exchange.dlx',
                '#',
            );

            this.logger.log({
                message: 'DLQ queues/bindings asserted',
                context: RabbitMQDLQInitializer.name,
                metadata: {
                    queues: [
                        'workflow.jobs.dlq',
                        'workflow.events.dlq',
                        'orchestrator.dlq',
                    ],
                },
            });
        });
    }
}
