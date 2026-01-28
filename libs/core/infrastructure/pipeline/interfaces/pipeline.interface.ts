import { PipelineContext } from './pipeline-context.interface';
import { StageVisibility } from '../enums/stage-visibility.enum';

export interface PipelineStage<TContext extends PipelineContext> {
    stageName: string;
    visibility: StageVisibility;
    execute(context: TContext): Promise<TContext>;
}

export interface IPipeline<TContext extends PipelineContext> {
    pipeLineName: string;
    execute(context: TContext): Promise<TContext>;
}
