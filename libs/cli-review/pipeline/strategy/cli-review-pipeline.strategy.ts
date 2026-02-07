import { Injectable } from '@nestjs/common';
import { IPipelineStrategy } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-strategy.interface';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { CliReviewPipelineContext } from '../context/cli-review-pipeline.context';

// Reused stages from code-review pipeline
import { ProcessFilesReview } from '@libs/code-review/pipeline/stages/process-files-review.stage';
import { AggregateResultsStage } from '@libs/code-review/pipeline/stages/aggregate-result.stage';

// CLI-specific stages
import { PrepareCliFilesStage } from '../stages/prepare-cli-files.stage';
import { FormatCliOutputStage } from '../stages/format-cli-output.stage';

/**
 * Pipeline strategy for CLI code review
 * Configures a simplified pipeline that reuses core analysis stages
 * Config is already resolved in the use case before pipeline execution
 */
@Injectable()
export class CliReviewPipelineStrategy implements IPipelineStrategy<CliReviewPipelineContext> {
    constructor(
        // Reused stages from code-review pipeline
        private readonly processFilesReview: ProcessFilesReview,
        private readonly aggregateResultsStage: AggregateResultsStage,

        // CLI-specific stages
        private readonly prepareCliFilesStage: PrepareCliFilesStage,
        private readonly formatCliOutputStage: FormatCliOutputStage,
    ) {}

    /**
     * Configure the pipeline stages in execution order
     * 4 stages total (vs 14 in PR pipeline):
     * 1. PrepareCliFiles - Validate FileChange objects
     * 2. ProcessFilesReview - Core LLM analysis (HEAVY_MODE uses fileContent)
     * 3. AggregateResults - Collect all suggestions
     * 4. FormatCliOutput - Convert to CLI response format
     *
     * Note: Config resolution/validation happens in the use case before pipeline
     */
    configureStages(): BasePipelineStage<CliReviewPipelineContext>[] {
        return [
            this.prepareCliFilesStage,
            this.processFilesReview as any, // ⭐ Core analysis - reused!
            this.aggregateResultsStage as any,
            this.formatCliOutputStage,
        ];
    }

    getPipelineName(): string {
        return 'CliReviewPipeline';
    }
}
