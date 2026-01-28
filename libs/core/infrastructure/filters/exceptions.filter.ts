import { createLogger } from '@kodus/flow';
import {
    Catch,
    ExceptionFilter,
    ExecutionContext,
    HttpException,
    Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/nestjs';
import { StatusCodes, getReasonPhrase } from 'http-status-codes';
import { MetricsCollectorService } from '@libs/core/infrastructure/metrics/metrics-collector.service';

interface ExceptionResponse {
    statusCode?: number;
    message?: string | string[];
    error?: string;
    error_key?: string;
}

@Catch()
export class ExceptionsFilter implements ExceptionFilter {
    private readonly loggerService = createLogger(ExceptionsFilter.name);
    private readonly componentType: string;
    constructor(
        private readonly configService: ConfigService,
        @Optional() private readonly metricsCollector?: MetricsCollectorService,
    ) {
        this.componentType = this.configService.get<string>('COMPONENT_TYPE', 'unknown');
    }

    catch(exception: unknown, context: ExecutionContext): void {
        const response = context.switchToHttp().getResponse();
        const request = context.switchToHttp().getRequest();
        const status =
            exception instanceof HttpException
                ? exception.getStatus()
                : StatusCodes.INTERNAL_SERVER_ERROR;

        const requestId = request?.requestId || 'unknown-request-id';

        Sentry.withScope((scope) => {
            scope.setTag('requestId', requestId);
            scope.setExtra('path', request?.url);
            scope.setExtra('method', request?.method);

            if (exception instanceof HttpException) {
                scope.setTag('statusCode', exception?.getStatus());
                scope.setExtra('response', exception?.getResponse());
            }

            Sentry.captureException(exception);
        });

        const errorResponse =
            exception instanceof HttpException ? exception.getResponse() : {};
        let message = 'An unexpected error occurred';
        let error_key: string | undefined;
        if (typeof errorResponse === 'string') {
            message = errorResponse;
        } else if (
            errorResponse &&
            typeof errorResponse === 'object' &&
            'message' in errorResponse
        ) {
            const typedErrorResponse = errorResponse as ExceptionResponse;
            message = Array.isArray(typedErrorResponse.message)
                ? typedErrorResponse.message.join(', ')
                : typedErrorResponse.message || message;

            error_key = typedErrorResponse?.error_key;
        }

        const error =
            exception instanceof HttpException
                ? getReasonPhrase(status)
                : 'Internal Server Error';

        this.loggerService.error({
            message: `[${status}] ${error}: ${message}`,
            context: 'ExceptionsFilter',
            serviceName: 'ExceptionsFilter',
            error: exception instanceof Error ? exception : undefined,
            metadata: {
                path: request.url,
                method: request.method,
                status,
                requestId: request.requestId,
                exceptionType: exception.constructor.name,
            },
        });

        // Record metrics for 5xx errors
        if (status >= 500) {
            const component = this.componentType;
            this.metricsCollector?.recordCounter('http_errors_total', 1, {
                component,
                path: request.url,
                statusCode: String(status),
            });
        }

        response.status(status).json({
            statusCode: status,
            timestamp: new Date().toISOString(),
            path: request.url,
            error,
            message,
            ...(error_key ? { error_key } : {}),
        });
    }
}
