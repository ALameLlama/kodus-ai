import { PipelineContext } from './pipeline-context.interface';
import { StageVisibility } from '../enums/stage-visibility.enum';

export interface IPipelineObserver {
    onStageStart(
        stageName: string,
        context: PipelineContext,
        visibility?: StageVisibility,
    ): Promise<void>;
    onStageFinish(stageName: string, context: PipelineContext): Promise<void>;
    onStageError(
        stageName: string,
        error: Error,
        context: PipelineContext,
    ): Promise<void>;
    onStageSkipped(
        stageName: string,
        reason: string,
        context: PipelineContext,
    ): Promise<void>;
}
