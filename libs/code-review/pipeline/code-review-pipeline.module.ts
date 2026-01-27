import { Module, forwardRef } from '@nestjs/common';

// Stages
import { AggregateResultsStage } from './stages/aggregate-result.stage';
import { CreateFileCommentsStage } from './stages/create-file-comments.stage';
import { CreateGithubCheckStage } from './stages/create-github-check.stage';
import { CreatePrLevelCommentsStage } from './stages/create-pr-level-comments.stage';
import { FetchChangedFilesStage } from './stages/fetch-changed-files.stage';
import { FileContextGateStage } from './stages/file-context-gate.stage';
import { FinalizeGithubCheckStage } from './stages/finalize-github-check.stage';
import { UpdateCommentsAndGenerateSummaryStage } from './stages/finish-comments.stage';
import { RequestChangesOrApproveStage } from './stages/finish-process-review.stage';
import { InitialCommentStage } from './stages/initial-comment.stage';
import { LoadExternalContextStage } from './stages/load-external-context.stage';
import { ProcessFilesPrLevelReviewStage } from './stages/process-files-pr-level-review.stage';
import { ProcessFilesReview } from './stages/process-files-review.stage';
import { ResolveConfigStage } from './stages/resolve-config.stage';
import { ValidateConfigStage } from './stages/validate-config.stage';
import { ValidateNewCommitsStage } from './stages/validate-new-commits.stage';
import { ValidatePrerequisitesStage } from './stages/validate-prerequisites.stage';

// EE Stages

// Interfaces
import { PermissionValidationModule } from '@libs/ee/shared/permission-validation.module';
import { LicenseModule } from '@libs/ee/license/license.module';
import { AIEngineModule } from '@libs/ai-engine/modules/ai-engine.module';
import { AutomationModule } from '@libs/automation/modules/automation.module';
import { WorkflowCoreModule } from '@libs/core/workflow/modules/workflow-core.module';
import { DryRunCoreModule } from '@libs/dryRun/dry-run-core.module';
import { FileReviewModule } from '@libs/ee/codeReview/fileReviewContextPreparation/fileReview.module';
import { CodeAnalysisASTCleanupStage } from '@libs/ee/codeReview/stages/code-analysis-ast-cleanup.stage';
import { CodeAnalysisASTStage } from '@libs/ee/codeReview/stages/code-analysis-ast.stage';
import { KodyFineTuningStage } from '@libs/ee/codeReview/stages/kody-fine-tuning.stage';
import { CodeReviewPipelineStrategyEE } from '@libs/ee/codeReview/strategies/code-review-pipeline.strategy.ee';
import { KodyASTModule } from '@libs/ee/kodyAST/kodyAST.module';
import { KodyASTAnalyzeContextModule } from '@libs/ee/kodyASTAnalyze/kodyAstAnalyzeContext.module';
import { KodyFineTuningContextModule } from '@libs/kodyFineTuning/kodyFineTuningContext.module';
import { OrganizationParametersModule } from '@libs/organization/modules/organizationParameters.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { GithubChecksService } from '@libs/platform/infrastructure/adapters/services/github/github-checks.service';
import { GithubModule } from '@libs/platform/modules/github.module';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { CodebaseModule } from '../modules/codebase.module';
import { PullRequestsModule } from '../modules/pull-requests.module';
import { PullRequestMessagesModule } from '../modules/pullRequestMessages.module';
import { CodeReviewJobProcessorService } from '../workflow/code-review-job-processor.service';
import { LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN } from './stages/contracts/loadExternalContextStage.contract';
import { ValidateSuggestionsStage } from './stages/validate-suggestions.stage';
import { CodeReviewPipelineStrategy } from './strategy/code-review-pipeline.strategy';
import { ImplementationVerificationProcessor } from '../workflow/implementation-verification.processor';
import { CodeReviewPipelineObserver } from '../infrastructure/observers/code-review-pipeline.observer';

@Module({
    imports: [
        forwardRef(() => CodebaseModule),
        forwardRef(() => FileReviewModule),
        forwardRef(() => PullRequestMessagesModule),
        forwardRef(() => PullRequestsModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => OrganizationParametersModule),
        forwardRef(() => AIEngineModule),
        forwardRef(() => PlatformModule),
        forwardRef(() => KodyFineTuningContextModule),
        forwardRef(() => KodyASTAnalyzeContextModule),
        forwardRef(() => KodyASTModule),
        forwardRef(() => AutomationModule),
        forwardRef(() => GithubModule),
        forwardRef(() => PermissionValidationModule),
        forwardRef(() => LicenseModule),
        WorkflowCoreModule,
        DryRunCoreModule,
    ],
    providers: [
        // Strategy
        CodeReviewPipelineStrategyEE,
        CodeReviewPipelineStrategy,

        // Job Processor
        CodeReviewJobProcessorService,

        // Stages
        ValidateNewCommitsStage,
        ValidatePrerequisitesStage,
        ResolveConfigStage,
        ValidateConfigStage,
        FetchChangedFilesStage,
        {
            provide: LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN,
            useExisting: LoadExternalContextStage,
        },
        LoadExternalContextStage,
        FileContextGateStage,
        InitialCommentStage,
        ProcessFilesPrLevelReviewStage,
        ProcessFilesReview,
        CreatePrLevelCommentsStage,
        CreateFileCommentsStage,
        AggregateResultsStage,
        UpdateCommentsAndGenerateSummaryStage,
        RequestChangesOrApproveStage,
        ValidateSuggestionsStage,

        // EE Stages
        KodyFineTuningStage,
        CodeAnalysisASTStage,
        CodeAnalysisASTCleanupStage,

        // For GitHub Checks
        GithubChecksService,
        CreateGithubCheckStage,
        FinalizeGithubCheckStage,

        // Implementation Verification
        ImplementationVerificationProcessor,

        // Observers
        CodeReviewPipelineObserver,
    ],
    exports: [
        CodeReviewPipelineStrategyEE,
        CodeReviewPipelineStrategy,
        CodeReviewJobProcessorService,
        CodeReviewPipelineObserver,
        // Export stages if needed by tests or other modules
        CreateFileCommentsStage,
        CreatePrLevelCommentsStage,
        UpdateCommentsAndGenerateSummaryStage,
        ProcessFilesPrLevelReviewStage,
        ProcessFilesReview,
        ResolveConfigStage,
        ValidateConfigStage,
        ValidateNewCommitsStage,
        ValidatePrerequisitesStage,
        FetchChangedFilesStage,
        InitialCommentStage,
        AggregateResultsStage,
        LoadExternalContextStage,
        LOAD_EXTERNAL_CONTEXT_STAGE_TOKEN,
        ValidateSuggestionsStage,
        CreateGithubCheckStage,
        FinalizeGithubCheckStage,
        ImplementationVerificationProcessor,
    ],
})
export class CodeReviewPipelineModule {}
