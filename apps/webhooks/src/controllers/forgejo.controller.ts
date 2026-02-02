import { createLogger } from '@kodus/flow';
import { Controller, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { EnqueueWebhookUseCase } from '@libs/platform/application/use-cases/webhook/enqueue-webhook.use-case';

@Controller('forgejo')
export class ForgejoController {
    private readonly logger = createLogger(ForgejoController.name);
    constructor(
        private readonly enqueueWebhookUseCase: EnqueueWebhookUseCase,
    ) {}

    @Post('/webhook')
    handleWebhook(@Req() req: Request, @Res() res: Response) {
        // Forgejo uses X-Forgejo-Event header, but also supports X-Gitea-Event for backwards compatibility
        const event = (req.headers['x-forgejo-event'] || req.headers['x-gitea-event']) as string;
        const payload = req.body as any;

        // Filter unsupported events before enqueueing
        // TODO: see if these are correct
        const supportedEvents = [
            'pull_request',
            'issue_comment',
            'pull_request_review',
            'pull_request_review_comment',
        ];

        if (!supportedEvents.includes(event)) {
            return res
                .status(HttpStatus.OK)
                .send('Webhook ignored (event not supported)');
        }

        res.status(HttpStatus.OK).send('Webhook received');

        setImmediate(() => {
            void this.enqueueWebhookUseCase
                .execute({
                    platformType: PlatformType.FORGEJO,
                    event,
                    payload,
                })
                .then(() => {
                    this.logger.log({
                        message: `Webhook enqueued, ${event}`,
                        context: ForgejoController.name,
                        metadata: {
                            event,
                            repository: payload?.repository?.name,
                            action: payload?.action,
                        },
                    });
                })
                .catch((error) => {
                    this.logger.error({
                        message: 'Error enqueuing webhook',
                        context: ForgejoController.name,
                        error,
                        metadata: {
                            event,
                            platformType: PlatformType.FORGEJO,
                        },
                    });
                });
        });
    }
}
