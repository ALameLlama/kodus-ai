import { trace } from '@opentelemetry/api';
import pino from 'pino';
import { LogArguments, LogProcessor, ExecutionContext } from './types.js';
import { LogLevel } from '@/core/types/allTypes.js';

let pinoLogger: pino.Logger | null = null;
let globalLogProcessors: LogProcessor[] = [];
let spanContextProvider:
    | (() => { traceId: string; spanId: string } | undefined)
    | null = null;
let observabilityContextProvider:
    | (() =>
          | {
                correlationId?: string;
                tenantId?: string;
                sessionId?: string;
            }
          | undefined)
    | null = null;

function getPinoLogger(): pino.Logger {
    if (!pinoLogger) {
        const shouldPrettyPrint =
            (process.env.API_LOG_PRETTY || 'false') === 'true';
        const isProduction =
            (process.env.API_NODE_ENV || 'production') === 'production';

        const baseConfig: pino.LoggerOptions = {
            level: process.env.API_LOG_LEVEL || 'info',
            formatters: {
                level: (label) => ({ level: label }),
            },
            serializers: {
                error: pino.stdSerializers.err,
                err: pino.stdSerializers.err,
                req: pino.stdSerializers.req,
                res: pino.stdSerializers.res,
            },
            redact: {
                paths: [
                    'password',
                    'token',
                    'secret',
                    'apiKey',
                    'authorization',
                    '*.password',
                    '*.token',
                    '*.secret',
                    '*.apiKey',
                    '*.authorization',
                    'req.headers.authorization',
                    'req.headers[\"x-api-key\"]',
                    'user.sensitiveInfo',
                ],
                censor: '[REDACTED]',
            },
            timestamp: pino.stdTimeFunctions.isoTime,
            base: {
                pid: process.pid,
                hostname: undefined,
            },
        };

        let transport;
        if (isProduction && !shouldPrettyPrint) {
            // Production JSON logging to stdout
            transport = pino.transport({
                targets: [
                    {
                        target: 'pino/file',
                        options: {
                            destination: 1, // stdout
                            mkdir: false,
                        },
                        level: process.env.API_LOG_LEVEL || 'info',
                    },
                ],
            });
        } else {
            // Development pretty-printed logging
            transport = pino.transport({
                targets: [
                    {
                        target: 'pino-pretty',
                        options: {
                            colorize: true,
                            translateTime: 'SYS:standard',
                            ignore: 'pid,hostname,environment,metadata,traceId,spanId,correlationId,tenantId,sessionId',
                            levelFirst: true,
                            errorProps: 'message,stack',
                            messageFormat:
                                'SYS:[{serviceName}] {level} - {context} - {msg}',
                        },
                        level: process.env.API_LOG_LEVEL || 'info',
                    },
                ],
            });
        }

        transport.on('error', (err) => {
            console.error('Pino transport failure:', err);
        });

        pinoLogger = pino(baseConfig, transport);
    }
    return pinoLogger;
}

export class SimpleLogger {
    private defaultServiceName: string;

    constructor(serviceName: string) {
        this.defaultServiceName = serviceName;
    }

    public log(args: LogArguments) {
        this.handleLog('info', args);
    }

    public error(args: LogArguments) {
        this.handleLog('error', args);
    }

    public warn(args: LogArguments) {
        this.handleLog('warn', args);
    }

    public debug(args: LogArguments) {
        this.handleLog('debug', args);
    }

    private handleLog(
        level: LogLevel,
        { message, context, serviceName, error, metadata = {} }: LogArguments,
    ) {
        if (this.shouldSkipLog(context)) {
            return;
        }

        const effectiveServiceName = serviceName || this.defaultServiceName;
        const contextStr = this.extractContextInfo(context);
        const baseLogger = getPinoLogger();

        // Respect API_LOG_LEVEL for both stdout and processors (Mongo exporter).
        if (!baseLogger.isLevelEnabled(level)) {
            return;
        }

        const childLogger = baseLogger.child({
            serviceName: effectiveServiceName,
            context: contextStr,
        });

        const logObject = this.buildLogObject(
            effectiveServiceName,
            metadata,
            error,
        );

        if (error) {
            childLogger[level]({ ...logObject, err: error }, message);
        } else {
            childLogger[level](logObject, message);
        }

        for (const processor of globalLogProcessors) {
            try {
                processor.process(
                    level,
                    message,
                    { ...metadata, component: effectiveServiceName },
                    error,
                );
            } catch {}
        }
    }

    private extractContextInfo(
        context: ExecutionContext | string | undefined,
    ): string {
        if (!context) return 'unknown';
        if (typeof context === 'string') return context;
        try {
            const request = context.switchToHttp().getRequest();
            return request.url || 'unknown';
        } catch {
            return 'unknown';
        }
    }

    private shouldSkipLog(context: ExecutionContext | string | undefined) {
        return (
            typeof context === 'undefined' ||
            (typeof context === 'string' &&
                ['RouterExplorer', 'RoutesResolver'].includes(context))
        );
    }

    private buildLogObject(
        serviceName: string,
        metadata: Record<string, any>,
        error?: Error,
    ) {
        const logObject: Record<string, any> = {
            environment: process.env.API_NODE_ENV || 'unknown',
            serviceName,
            ...metadata,
            metadata,
            ...this.getTraceContext(),
            ...this.getObservabilityContext(),
        };

        if (error) {
            logObject.error = { message: error.message, stack: error.stack };
        }

        return logObject;
    }

    private getTraceContext() {
        if (spanContextProvider) {
            const sc = spanContextProvider();
            if (sc) return sc;
        }

        const currentSpan = trace.getActiveSpan();
        if (!currentSpan) {
            return { traceId: null, spanId: null };
        }

        const ctx = currentSpan.spanContext();
        return {
            traceId: ctx.traceId,
            spanId: ctx.spanId,
        };
    }

    private getObservabilityContext() {
        if (observabilityContextProvider) {
            return observabilityContextProvider() || {};
        }
        return {};
    }
}

export function createLogger(component: string): SimpleLogger {
    return new SimpleLogger(component);
}

export function addLogProcessor(processor: LogProcessor): void {
    globalLogProcessors.push(processor);
}

export function removeLogProcessor(processor: LogProcessor): void {
    const index = globalLogProcessors.indexOf(processor);
    if (index > -1) {
        globalLogProcessors.splice(index, 1);
    }
}

export function clearLogProcessors(): void {
    globalLogProcessors = [];
}

export function setGlobalLogLevel(level: LogLevel | string): void {
    getPinoLogger().level = level as any;
}

export function setSpanContextProvider(
    provider: (() => { traceId: string; spanId: string } | undefined) | null,
): void {
    spanContextProvider = provider;
}

export function setObservabilityContextProvider(
    provider:
        | (() =>
              | {
                    correlationId?: string;
                    tenantId?: string;
                    sessionId?: string;
                }
              | undefined)
        | null,
): void {
    observabilityContextProvider = provider;
}
