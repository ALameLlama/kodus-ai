import 'source-map-support/register';
import { initPyroscope } from '@libs/core/infrastructure/config/profiling/pyroscope';
import { environment } from '@libs/ee/configs/environment';

// Initialize profiling early (before NestJS bootstrap)
initPyroscope({ appName: 'kodus-api' });

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as bodyParser from 'body-parser';
import * as compression from 'compression';
import { useContainer } from 'class-validator';
import expressRateLimit from 'express-rate-limit';
import helmet from 'helmet';
import * as volleyball from 'volleyball';

import { HttpServerConfiguration } from '@libs/core/infrastructure/config/types';
import { ObservabilityService } from '@libs/core/log/observability.service';

import { ApiModule } from './api.module';
import { LoggerWrapperService } from '@libs/core/log/loggerWrapper.service';

declare const module: any;

function handleNestJSWebpackHmr(app: INestApplication, module: any) {
    if (module.hot) {
        module.hot.accept();
        module.hot.dispose(() => app.close());
    }
}

async function bootstrap() {
    process.env.COMPONENT_TYPE = 'api';
    const app = await NestFactory.create<NestExpressApplication>(ApiModule, {
        snapshot: true,
    });

    const logger = app.get(LoggerWrapperService);
    app.useLogger(logger);

    try {
        logger.log('Entering bootstrap try block...', 'Bootstrap');
        logger.log('Initializing API...', 'Bootstrap');

        const configService: ConfigService = app.get(ConfigService);
        await app.get(ObservabilityService).init('api');

        const config = configService.get<HttpServerConfiguration>('server');
        const { host, port, rateLimit } = config;

        app.useGlobalPipes(
            new ValidationPipe({
                transform: true,
                whitelist: true,
                forbidNonWhitelisted: true,
                transformOptions: {
                    enableImplicitConversion: true,
                },
            }),
        );

        app.enableVersioning();
        app.enableCors({
            origin: true,
            methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
            credentials: true,
        });

        app.use(volleyball);
        app.use(helmet());
        app.use(
            compression({
                filter: (req, res) => {
                    if (req.headers['x-no-compression']) {
                        return false;
                    }
                    if (
                        res.getHeader('Content-Type') === 'text/event-stream' ||
                        req.url.includes('/events/')
                    ) {
                        return false;
                    }
                    return compression.filter(req, res);
                },
            }),
        );
        app.use(
            expressRateLimit({
                windowMs: rateLimit.rateInterval,
                max: rateLimit.rateMaxRequest,
                legacyHeaders: false,
            }),
        );

        process.on('uncaughtException', (error) => {
            logger.error({
                message: `Uncaught Exception: ${error.message}`,
                context: 'GlobalExceptionHandler',
                error,
            });
        });

        process.on('unhandledRejection', (reason: any) => {
            logger.error({
                message: `Unhandled Rejection: ${reason?.message || reason}`,
                context: 'GlobalExceptionHandler',
                error:
                    reason instanceof Error
                        ? reason
                        : new Error(String(reason)),
            });
        });

        app.use(bodyParser.json({ limit: '25mb' }));
        app.use(bodyParser.urlencoded({ limit: '25mb', extended: true }));
        app.set('trust proxy', 1);
        app.useStaticAssets('static');
        useContainer(app.select(ApiModule), { fallbackOnErrors: true });

        app.enableShutdownHooks();

        const apiPort = process.env.API_PORT
            ? parseInt(process.env.API_PORT, 10)
            : port;

        console.log(
            `[API] - Running in ${environment.API_CLOUD_MODE ? 'CLOUD' : 'SELF-HOSTED'} mode`,
        );
        await app.listen(apiPort, host, () => {
            console.log(`[API] - Ready on http://${host}:${apiPort}`);
        });

        handleNestJSWebpackHmr(app, module);
    } catch (error) {
        logger.error(
            `Bootstrap failed inside catch block: ${error.message}`,
            error.stack,
            'Bootstrap',
        );
        await app.close();
        process.exit(1);
    }
}

bootstrap();
