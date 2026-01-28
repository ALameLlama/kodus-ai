import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { Injectable } from '@nestjs/common';
import { createLogger } from '@kodus/flow';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { FileContextAugmentationService } from '@libs/ai-engine/infrastructure/adapters/services/context/file-context-augmentation.service';

@Injectable()
export class FileContextGateStage extends BasePipelineStage<CodeReviewPipelineContext> {
    private readonly logger = createLogger(FileContextGateStage.name);
    readonly stageName = 'FileContextGateStage';
    readonly visibility = StageVisibility.SECONDARY;

    constructor(
        private readonly fileContextAugmentationService: FileContextAugmentationService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        if (!context.changedFiles?.length) {
            return context;
        }

        const mcpDependencies =
            context.sharedContextPack?.dependencies?.filter(
                (dep) => dep.type === 'mcp',
            ) ?? [];

        if (!mcpDependencies.length) {
            return context;
        }

        const augmentationsByFile =
            await this.fileContextAugmentationService.augmentFiles(
                context.changedFiles,
                context,
                mcpDependencies,
            );

        return this.updateContext(context, (draft) => {
            draft.augmentationsByFile = augmentationsByFile;
        });
    }
}
