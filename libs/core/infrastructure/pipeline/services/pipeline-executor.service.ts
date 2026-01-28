import { v4 as uuid } from 'uuid';
import { produce } from 'immer';
import { PipelineContext } from '../interfaces/pipeline-context.interface';
import { createLogger } from '@kodus/flow';
import { PipelineStage } from '../interfaces/pipeline.interface';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { MetricsCollectorService } from '@libs/core/infrastructure/metrics/metrics-collector.service';
import { IPipelineObserver } from '../interfaces/pipeline-observer.interface';

type SkipDecision = 'EXECUTE_STAGE' | 'SKIP_STAGE' | 'ABORT_PIPELINE';

export class PipelineExecutor<TContext extends PipelineContext> {
    private readonly logger = createLogger(PipelineExecutor.name);

    constructor(private readonly metricsCollector?: MetricsCollectorService) {}

    async execute(
        context: TContext,
        stages: PipelineStage<TContext>[],
        pipelineName = 'UnnamedPipeline',
        parentPipelineId?: string,
        rootPipelineId?: string,
        observers: IPipelineObserver[] = [],
    ): Promise<TContext> {
        const pipelineId = uuid();

        context.pipelineMetadata = {
            ...(context.pipelineMetadata || {}),
            pipelineId,
            parentPipelineId,
            rootPipelineId: rootPipelineId || pipelineId,
            pipelineName,
        };

        this.logger.log({
            message: `Starting pipeline: ${pipelineName} (ID: ${pipelineId})`,
            context: PipelineExecutor.name,
            serviceName: PipelineExecutor.name,
            metadata: {
                ...context?.pipelineMetadata,
                correlationId: (context as any)?.correlationId ?? null,
                organizationAndTeamData:
                    (context as any)?.organizationAndTeamData ?? null,
                status: context.statusInfo,
            },
        });

        for (const stage of stages) {
            // Check if we need to handle skip/jump logic
            if (context.statusInfo.status === AutomationStatus.SKIPPED) {
                const result = await this.handleSkipOrJump(
                    context,
                    stage,
                    pipelineName,
                    pipelineId,
                    observers,
                );

                context = result.newContext;

                if (result.decision === 'ABORT_PIPELINE') {
                    break;
                }

                if (result.decision === 'SKIP_STAGE') {
                    continue;
                }
            }

            const start = Date.now();

            await this.notifyObservers(
                observers,
                (obs) =>
                    obs.onStageStart(
                        stage.stageName,
                        context,
                        stage.visibility,
                    ),
                'onStageStart',
            );

            try {
                context = await stage.execute(context);

                await this.notifyObservers(
                    observers,
                    (obs) => obs.onStageFinish(stage.stageName, context),
                    'onStageFinish',
                );

                const stageDurationMs = Date.now() - start;
                this.metricsCollector?.recordHistogram(
                    'pipeline_stage_duration_ms',
                    stageDurationMs,
                    { pipeline: pipelineName, stage: stage.stageName },
                );

                this.logger.log({
                    message: `Stage '${stage.stageName}' completed in ${stageDurationMs}ms: ${pipelineId}`,
                    context: PipelineExecutor.name,
                    serviceName: PipelineExecutor.name,
                    metadata: {
                        ...context?.pipelineMetadata,
                        stage: stage.stageName,
                        correlationId: (context as any)?.correlationId ?? null,
                        organizationAndTeamData:
                            (context as any)?.organizationAndTeamData ?? null,
                        status: context.statusInfo,
                    },
                });
            } catch (error) {
                await this.notifyObservers(
                    observers,
                    (obs) => obs.onStageError(stage.stageName, error, context),
                    'onStageError',
                );

                this.metricsCollector?.recordCounter(
                    'pipeline_stage_errors_total',
                    1,
                    { pipeline: pipelineName, stage: stage.stageName },
                );

                this.logger.error({
                    message: `Stage '${stage.stageName}' failed: ${error.message}`,
                    context: PipelineExecutor.name,
                    serviceName: PipelineExecutor.name,
                    error: error,
                    metadata: {
                        correlationId: (context as any)?.correlationId ?? null,
                        ...context?.pipelineMetadata,
                        stage: stage.stageName,
                        organizationAndTeamData:
                            (context as any)?.organizationAndTeamData ?? null,
                        status: context.statusInfo,
                    },
                });

                this.logger.warn({
                    message: `Pipeline '${pipelineName}:${pipelineId}' continuing despite error in stage '${stage.stageName}'`,
                    context: PipelineExecutor.name,
                    serviceName: PipelineExecutor.name,
                    metadata: {
                        ...context?.pipelineMetadata,
                        stage: stage.stageName,
                        correlationId: (context as any)?.correlationId ?? null,
                        organizationAndTeamData:
                            (context as any)?.organizationAndTeamData ?? null,
                        status: context.statusInfo,
                    },
                });
            }
        }

        // Restore skipped status if needed (for historical accuracy)
        if (context.statusInfo.skippedReason) {
            context = produce(context, (draft) => {
                const reason = draft.statusInfo.skippedReason!;
                draft.statusInfo.status = reason.status;

                if (reason.message) {
                    draft.statusInfo.message = reason.message;
                }
            });
        }

        this.logger.log({
            message: `Finished pipeline: ${pipelineName} (ID: ${pipelineId})`,
            context: PipelineExecutor.name,
            serviceName: PipelineExecutor.name,
            metadata: {
                ...context?.pipelineMetadata,
                correlationId: (context as any)?.correlationId ?? null,
                organizationAndTeamData:
                    (context as any)?.organizationAndTeamData ?? null,
            },
        });

        return context;
    }

    private async notifyObservers(
        observers: IPipelineObserver[],
        callback: (observer: IPipelineObserver) => Promise<void>,
        actionName: string,
    ): Promise<void> {
        for (const observer of observers) {
            try {
                await callback(observer);
            } catch (error) {
                this.logger.error({
                    message: `Observer ${actionName} failed`,
                    error: error as Error,
                    context: PipelineExecutor.name,
                    serviceName: PipelineExecutor.name,
                });
            }
        }
    }

    private async handleSkipOrJump(
        context: TContext,
        stage: PipelineStage<TContext>,
        pipelineName: string,
        pipelineId: string,
        observers: IPipelineObserver[],
    ): Promise<{ decision: SkipDecision; newContext: TContext }> {
        const targetStage = context.statusInfo.jumpToStage;

        if (!targetStage) {
            this.logger.log({
                message: `Pipeline '${pipelineName}' skipped due to SKIP status ${pipelineId}`,
                context: PipelineExecutor.name,
                serviceName: PipelineExecutor.name,
                metadata: {
                    ...context?.pipelineMetadata,
                    stage: stage.stageName,
                    correlationId: (context as any)?.correlationId ?? null,
                    organizationAndTeamData:
                        (context as any)?.organizationAndTeamData ?? null,
                    status: context.statusInfo,
                },
            });

            return { decision: 'ABORT_PIPELINE', newContext: context };
        }

        if (stage.stageName !== targetStage) {
            await this.notifyObservers(
                observers,
                (obs) =>
                    obs.onStageSkipped(
                        stage.stageName,
                        `Skipping stage '${stage.stageName}' while looking for '${targetStage}'`,
                        context,
                    ),
                'onStageSkipped',
            );

            this.logger.log({
                message: `Skipping stage '${stage.stageName}' while looking for '${targetStage}'`,
                context: PipelineExecutor.name,
                serviceName: PipelineExecutor.name,
                metadata: {
                    ...context?.pipelineMetadata,
                    stage: stage.stageName,
                    correlationId: (context as any)?.correlationId ?? null,
                    status: context.statusInfo,
                },
            });
            return { decision: 'SKIP_STAGE', newContext: context };
        }

        const newContext = produce(context, (draft) => {
            draft.statusInfo.skippedReason = {
                status: context.statusInfo.status,
                message: context.statusInfo.message,
                stageName: stage.stageName,
                jumpToStage: context.statusInfo.jumpToStage,
            };

            draft.statusInfo.jumpToStage = undefined;
            draft.statusInfo.status = AutomationStatus.IN_PROGRESS;
        });

        return { decision: 'EXECUTE_STAGE', newContext };
    }
}
