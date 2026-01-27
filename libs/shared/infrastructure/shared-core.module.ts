import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtAuthGuard } from '@libs/identity/infrastructure/adapters/services/auth/jwt-auth.guard';
import { ExceptionsFilter } from '@libs/core/infrastructure/filters/exceptions.filter';
import { LoggingInterceptor } from '@libs/core/infrastructure/interceptors/logging.interceptor';
import { TransformInterceptor } from '@libs/core/infrastructure/interceptors/transform.interceptor';
import { MetricsCollectorService } from '@libs/core/infrastructure/metrics/metrics-collector.service';

@Module({
    providers: [
        {
            provide: APP_GUARD,
            useClass: JwtAuthGuard,
        },
        {
            provide: APP_FILTER,
            useFactory: (metrics: MetricsCollectorService) => {
                return new ExceptionsFilter(metrics);
            },
            inject: [MetricsCollectorService],
        },
        {
            provide: APP_INTERCEPTOR,
            useClass: TransformInterceptor,
        },
        {
            provide: APP_INTERCEPTOR,
            useClass: LoggingInterceptor,
        },
    ],
})
export class SharedCoreModule {}
