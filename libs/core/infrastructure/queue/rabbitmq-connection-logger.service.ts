import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { createLogger } from '@kodus/flow';
import {
    Injectable,
    OnModuleDestroy,
    OnModuleInit,
    Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type ManagedConnection = {
    on: (event: string, handler: (...args: any[]) => void) => void;
    off?: (event: string, handler: (...args: any[]) => void) => void;
    removeListener?: (event: string, handler: (...args: any[]) => void) => void;
};

@Injectable()
export class RabbitMQConnectionLoggerService
    implements OnModuleInit, OnModuleDestroy
{
    private readonly logger = createLogger(
        RabbitMQConnectionLoggerService.name,
    );
    private readonly componentType: string;
    private managedConnection?: ManagedConnection;
    private connectHandler?: (args: { connection?: unknown }) => void;
    private disconnectHandler?: (args: { err?: Error }) => void;
    private connectFailedHandler?: (args: { err?: Error }) => void;

    constructor(
        private readonly configService: ConfigService,
        @Optional() private readonly amqpConnection?: AmqpConnection,
    ) {
        this.componentType = this.configService.get<string>(
            'COMPONENT_TYPE',
            'unknown',
        );
    }

    onModuleInit(): void {
        if (!this.amqpConnection) {
            this.logger.debug({
                message:
                    'RabbitMQ connection not available; skipping listeners',
                context: RabbitMQConnectionLoggerService.name,
                metadata: { component: this.componentType },
            });
            return;
        }

        const managedConnection = (this.amqpConnection as any)
            .managedConnection as ManagedConnection | undefined;

        if (!managedConnection || typeof managedConnection.on !== 'function') {
            this.logger.debug({
                message:
                    'RabbitMQ managedConnection not available; skipping listeners',
                context: RabbitMQConnectionLoggerService.name,
                metadata: { component: this.componentType },
            });
            return;
        }

        this.managedConnection = managedConnection;

        this.connectHandler = () => {
            this.logger.log({
                message: 'RabbitMQ connected',
                context: RabbitMQConnectionLoggerService.name,
                metadata: {
                    component: this.componentType,
                    connectionName: this.amqpConnection?.configuration?.name,
                },
            });
        };

        this.disconnectHandler = ({ err }) => {
            this.logger.error({
                message: 'RabbitMQ disconnected',
                context: RabbitMQConnectionLoggerService.name,
                error: err,
                metadata: {
                    component: this.componentType,
                    connectionName: this.amqpConnection?.configuration?.name,
                    errorMessage: err?.message,
                },
            });
        };

        this.connectFailedHandler = ({ err }) => {
            this.logger.warn({
                message: 'RabbitMQ connection failed',
                context: RabbitMQConnectionLoggerService.name,
                error: err,
                metadata: {
                    component: this.componentType,
                    connectionName: this.amqpConnection?.configuration?.name,
                    errorMessage: err?.message,
                },
            });
        };

        managedConnection.on('connect', this.connectHandler);
        managedConnection.on('disconnect', this.disconnectHandler);
        managedConnection.on('connectFailed', this.connectFailedHandler);
    }

    onModuleDestroy(): void {
        if (!this.managedConnection) {
            return;
        }

        const off =
            this.managedConnection.off?.bind(this.managedConnection) ||
            this.managedConnection.removeListener?.bind(this.managedConnection);

        if (!off) {
            return;
        }

        if (this.connectHandler) {
            off('connect', this.connectHandler);
        }
        if (this.disconnectHandler) {
            off('disconnect', this.disconnectHandler);
        }
        if (this.connectFailedHandler) {
            off('connectFailed', this.connectFailedHandler);
        }
    }
}
