import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { WebhookEnqueueModule } from './webhook-enqueue.module';

@Module({
    imports: [
        ConfigModule.forRoot(),
        EventEmitterModule.forRoot(),
        WebhookEnqueueModule,
    ],
})
export class WebhookHandlerBaseModule {}
