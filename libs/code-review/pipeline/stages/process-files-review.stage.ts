import { Inject, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import pLimit from 'p-limit';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { PipelineError } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-context.interface';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';

import {
    ISuggestionService,
    SUGGESTION_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/SuggestionService.contract';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import {
    FILE_REVIEW_CONTEXT_PREPARATION_TOKEN,
    IFileReviewContextPreparation,
} from '@libs/core/domain/interfaces/file-review-context-preparation.interface';
import {
    IKodyFineTuningContextPreparationService,
    KODY_FINE_TUNING_CONTEXT_PREPARATION_TOKEN,
} from '@libs/core/domain/interfaces/kody-fine-tuning-context-preparation.interface';
import {
    IKodyASTAnalyzeContextPreparationService,
    KODY_AST_ANALYZE_CONTEXT_PREPARATION_TOKEN,
} from '@libs/core/domain/interfaces/kody-ast-analyze-context-preparation.interface';
import { createLogger } from '@kodus/flow';
import {
    AIAnalysisResult,
    AnalysisContext,
    CodeReviewConfig,
    CodeReviewVersion,
    CodeSuggestion,
    FileChange,
    IFinalAnalysisResult,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { createOptimizedBatches } from '@libs/common/utils/batch.helper';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';
import { TaskStatus } from '@libs/ee/kodyAST/interfaces/code-ast-analysis.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { CodeAnalysisOrchestrator } from '@libs/ee/codeBase/codeAnalysisOrchestrator.service';
import {
    CodeReviewPipelineContext,
    FileContextAgentResult,
} from '../context/code-review-pipeline.context';

interface FileProcessingResult {
    file: FileChange;
    validSuggestionsToAnalyze: Partial<CodeSuggestion>[];
    discardedSuggestionsBySafeGuard: Partial<CodeSuggestion>[];
    error?: PipelineError;
    reviewMode?: any;
    codeReviewModelUsed?: any;
}

@Injectable()
export class ProcessFilesReview extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'FileAnalysisStage';
    readonly label = 'Reviewing File Level';
    readonly visibility = StageVisibility.PRIMARY;

    private readonly concurrencyLimit = 30;
    private readonly logger = createLogger(ProcessFilesReview.name);

    constructor(
        @Inject(SUGGESTION_SERVICE_TOKEN)
        private readonly suggestionService: ISuggestionService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestService: IPullRequestsService,

        @Inject(FILE_REVIEW_CONTEXT_PREPARATION_TOKEN)
        private readonly fileReviewContextPreparation: IFileReviewContextPreparation,

        @Inject(KODY_FINE_TUNING_CONTEXT_PREPARATION_TOKEN)
        private readonly kodyFineTuningContextPreparation: IKodyFineTuningContextPreparationService,

        @Inject(KODY_AST_ANALYZE_CONTEXT_PREPARATION_TOKEN)
        private readonly kodyAstAnalyzeContextPreparation: IKodyASTAnalyzeContextPreparationService,

        private readonly codeAnalysisOrchestrator: CodeAnalysisOrchestrator,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        if (!context.changedFiles || context.changedFiles.length === 0) {
            this.logger.warn({
                message: `No files to analyze for PR#${context.pullRequest.number}`,
                context: this.stageName,
            });
            return context;
        }

        try {
            const {
                validSuggestions,
                discardedSuggestions,
                fileMetadata,
                tasks,
                errors,
            } = await this.analyzeChangedFilesInBatches(context);

            return this.updateContext(context, (draft) => {
                draft.validSuggestions = validSuggestions;
                draft.discardedSuggestions = discardedSuggestions;
                draft.fileMetadata = fileMetadata;
                draft.tasks = tasks;
                if (errors?.length > 0) {
                    draft.errors.push(...errors);
                }
            });
        } catch (error) {
            this.logger.error({
                message: 'Error analyzing files in batches',
                error,
                context: this.stageName,
                metadata: {
                    pullRequestNumber: context.pullRequest.number,
                    repositoryName: context.repository.name,
                    batchCount: context.batches?.length || 0,
                },
            });

            // Mesmo em caso de erro, retornamos o contexto para que o pipeline continue
            return this.updateContext(context, (draft) => {
                draft.validSuggestions = [];
                draft.discardedSuggestions = [];
                draft.fileMetadata = new Map();
            });
        }
    }

    async analyzeChangedFilesInBatches(
        context: CodeReviewPipelineContext,
    ): Promise<{
        validSuggestions: Partial<CodeSuggestion>[];
        discardedSuggestions: Partial<CodeSuggestion>[];
        fileMetadata: Map<string, any>;
        validCrossFileSuggestions: CodeSuggestion[];
        tasks: AnalysisContext['tasks'];
        errors: PipelineError[];
    }> {
        const { organizationAndTeamData, pullRequest, changedFiles } = context;
        const analysisContext =
            this.createAnalysisContextFromPipelineContext(context);

        try {
            this.logger.log({
                message: `Starting batch analysis of ${changedFiles.length} files`,
                context: ProcessFilesReview.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    pullRequestNumber: pullRequest.number,
                },
            });

            const batches = this.createOptimizedBatches(changedFiles);

            const { results, tasks } = await this.runBatches(
                batches,
                analysisContext,
            );

            // Create collections
            const validSuggestions: Partial<CodeSuggestion>[] = [];
            const discardedSuggestions: Partial<CodeSuggestion>[] = [];
            const fileMetadata = new Map<string, any>();
            const errors: PipelineError[] = [];

            // Process results
            results.forEach((result) => {
                if (result.error) {
                    errors.push(result.error);
                }

                this.collectFileProcessingResult(
                    result,
                    validSuggestions,
                    discardedSuggestions,
                    fileMetadata,
                );
            });

            this.logger.log({
                message: `Finished all batches - Analysis complete for PR#${pullRequest.number}`,
                context: ProcessFilesReview.name,
                metadata: {
                    validSuggestionsCount: validSuggestions.length,
                    discardedCount: discardedSuggestions.length,
                    tasks: tasks,
                    organizationAndTeamData: organizationAndTeamData,
                },
            });

            // Retornar apenas os dados analisados sem criar comentários
            return {
                validSuggestions: validSuggestions,
                discardedSuggestions: discardedSuggestions,
                fileMetadata: fileMetadata,
                validCrossFileSuggestions:
                    analysisContext.validCrossFileSuggestions || [],
                tasks: tasks,
                errors: errors,
            };
        } catch (error) {
            this.logProcessingError(
                error,
                organizationAndTeamData,
                pullRequest,
            );
            return {
                validSuggestions: [],
                discardedSuggestions: [],
                fileMetadata: new Map(),
                validCrossFileSuggestions: [],
                tasks: { ...context.tasks },
                errors: [],
            };
        }
    }

    /**
     * Logs processing errors
     * @param error The error that occurred
     * @param organizationAndTeamData Organization and team data
     * @param pullRequest Pull request data
     */
    private logProcessingError(
        error: any,
        organizationAndTeamData: OrganizationAndTeamData,
        pullRequest: { number: number },
    ): void {
        this.logger.error({
            message: `Error in batch file processing`,
            error,
            context: ProcessFilesReview.name,
            metadata: {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                pullRequestNumber: pullRequest.number,
            },
        });
    }

    private async runBatches(
        batches: FileChange[][],
        context: AnalysisContext,
    ): Promise<{
        results: FileProcessingResult[];
        tasks: AnalysisContext['tasks'];
    }> {
        const tasks: AnalysisContext['tasks'] = {
            astAnalysis: {
                ...context.tasks.astAnalysis,
            },
        };

        const results = await this.processBatchesSequentially(
            batches,
            context,
            tasks,
        );

        return {
            results,
            tasks,
        };
    }

    /**
     * Creates optimized batches of files for parallel processing
     * @param files Array of files to be processed
     * @returns Array of file batches
     */
    private createOptimizedBatches(files: FileChange[]): FileChange[][] {
        const batches = createOptimizedBatches(files, {
            minBatchSize: 20,
            maxBatchSize: 30,
        });

        this.validateBatchIntegrity(batches, files.length);

        return batches;
    }

    /**
     * Validates the integrity of the batches to ensure all files are processed
     * @param batches Batches created for processing
     * @param totalFileCount Original total number of files
     */
    private validateBatchIntegrity(
        batches: FileChange[][],
        totalFileCount: number,
    ): void {
        const totalFilesInBatches = batches.reduce(
            (sum, batch) => sum + batch.length,
            0,
        );
        if (totalFilesInBatches !== totalFileCount) {
            this.logger.warn({
                message: `Potential file processing mismatch! Total files: ${totalFileCount}, files in batches: ${totalFilesInBatches}`,
                context: ProcessFilesReview.name,
            });
            // Ensure all files are processed even in case of mismatch
            if (totalFilesInBatches < totalFileCount) {
                // If we identify that files might be missing, process all at once
                batches.length = 0;
                batches.push(Array.from({ length: totalFileCount }));
            }
        }
    }

    private async processBatchesSequentially(
        batches: FileChange[][],
        context: AnalysisContext,
        tasks: AnalysisContext['tasks'],
    ): Promise<FileProcessingResult[]> {
        const allResults: FileProcessingResult[] = [];

        for (const [index, batch] of batches.entries()) {
            this.logger.log({
                message: `Processing batch ${index + 1}/${batches.length} with ${batch.length} files`,
                context: ProcessFilesReview.name,
            });

            try {
                const batchResults = await this.processSingleBatch(
                    batch,
                    context,
                    index,
                    tasks,
                );

                allResults.push(...batchResults);
            } catch (error) {
                this.logger.error({
                    message: `Error processing batch ${index + 1}`,
                    error,
                    context: ProcessFilesReview.name,
                    metadata: {
                        batchIndex: index,
                        batchSize: batch.length,
                        pullRequestNumber: context.pullRequest.number,
                    },
                });
            }
        }

        return allResults;
    }

    private async processSingleBatch(
        batch: FileChange[],
        context: AnalysisContext,
        batchIndex: number,
        tasks: AnalysisContext['tasks'],
    ): Promise<FileProcessingResult[]> {
        const { organizationAndTeamData, pullRequest } = context;

        const preparedFiles = await this.filterAndPrepareFiles(batch, context);

        const astFailed = preparedFiles.find((file) => {
            const task = file.fileContext.tasks?.astAnalysis;
            return task && task.status !== TaskStatus.TASK_STATUS_COMPLETED;
        });

        if (astFailed) {
            tasks.astAnalysis.status =
                astFailed?.fileContext?.tasks?.astAnalysis?.status ||
                TaskStatus.TASK_STATUS_FAILED;
        }

        const results = await Promise.allSettled(
            preparedFiles.map(({ fileContext }) =>
                this.executeFileAnalysis(fileContext),
            ),
        );

        const batchResults: FileProcessingResult[] = [];

        results.forEach((result) => {
            if (result.status === 'fulfilled') {
                batchResults.push(result.value);
            } else {
                this.logger.error({
                    message: `Error processing file in batch ${batchIndex + 1}`,
                    error: result.reason,
                    context: ProcessFilesReview.name,
                    metadata: {
                        organizationId: organizationAndTeamData.organizationId,
                        teamId: organizationAndTeamData.teamId,
                        pullRequestNumber: pullRequest.number,
                        batchIndex,
                    },
                });
            }
        });

        return batchResults;
    }

    /**
     * Collects and organizes the results of file processing
     * @param fileProcessingResult Result of the file processing
     * @param validSuggestionsToAnalyze Array to store the valid suggestions found
     * @param discardedSuggestionsBySafeGuard Array to store the discarded suggestions
     * @param fileMetadata Map to store file metadata
     */
    private collectFileProcessingResult(
        fileProcessingResult: IFinalAnalysisResult & { file: FileChange },
        validSuggestionsToAnalyze: Partial<CodeSuggestion>[],
        discardedSuggestionsBySafeGuard: Partial<CodeSuggestion>[],
        fileMetadata: Map<string, any>,
    ): void {
        if (fileProcessingResult?.validSuggestionsToAnalyze?.length > 0) {
            validSuggestionsToAnalyze.push(
                ...fileProcessingResult.validSuggestionsToAnalyze,
            );
        }

        if (fileProcessingResult?.discardedSuggestionsBySafeGuard?.length > 0) {
            discardedSuggestionsBySafeGuard.push(
                ...fileProcessingResult.discardedSuggestionsBySafeGuard,
            );
        }

        if (fileProcessingResult?.file?.filename) {
            fileMetadata.set(fileProcessingResult.file.filename, {
                reviewMode: fileProcessingResult.reviewMode,
                codeReviewModelUsed: fileProcessingResult.codeReviewModelUsed,
            });
        }
    }

    private async filterAndPrepareFiles(
        batch: FileChange[],
        context: AnalysisContext,
    ): Promise<Array<{ fileContext: AnalysisContext }>> {
        const limit = pLimit(this.concurrencyLimit);

        const settledResults = await Promise.allSettled(
            batch.map((file) =>
                limit(() => {
                    const perFileContext: AnalysisContext = {
                        ...context,
                        fileAugmentations:
                            context.augmentationsByFile?.[file.filename] ?? {},
                    };

                    return this.fileReviewContextPreparation.prepareFileContext(
                        file,
                        perFileContext,
                    );
                }),
            ),
        );

        settledResults?.forEach((res, index) => {
            if (res.status === 'rejected') {
                this.logger.error({
                    message: `Error preparing the file "${batch[index]?.filename}" for analysis`,
                    error: res.reason,
                    context: ProcessFilesReview.name,
                    metadata: {
                        ...context.organizationAndTeamData,
                        pullRequestNumber: context.pullRequest.number,
                    },
                });
            }
        });

        return settledResults
            ?.filter(
                (
                    res,
                ): res is PromiseFulfilledResult<{
                    fileContext: AnalysisContext;
                }> => res.status === 'fulfilled' && res.value !== null,
            )
            ?.map((res) => res.value);
    }

    private async executeFileAnalysis(
        baseContext: AnalysisContext,
    ): Promise<FileProcessingResult> {
        const { reviewModeResponse } = baseContext;
        const { file, relevantContent, patchWithLinesStr, hasRelevantContent } =
            baseContext.fileChangeContext;

        try {
            const context: AnalysisContext = {
                ...baseContext,
                reviewModeResponse: reviewModeResponse,
                fileChangeContext: {
                    file,
                    relevantContent,
                    patchWithLinesStr,
                    hasRelevantContent,
                },
            };

            const standardAnalysisResult =
                await this.codeAnalysisOrchestrator.executeStandardAnalysis(
                    context.organizationAndTeamData,
                    context.pullRequest.number,
                    {
                        file,
                        relevantContent,
                        patchWithLinesStr,
                        hasRelevantContent,
                    },
                    reviewModeResponse,
                    context,
                );

            const finalResult = await this.processAnalysisResult(
                standardAnalysisResult,
                context,
            );

            return { ...finalResult, file };
        } catch (error) {
            this.logger.error({
                message: `Error analyzing file ${file.filename}`,
                error,
                context: ProcessFilesReview.name,
                metadata: {
                    filename: file.filename,
                    organizationId:
                        baseContext.organizationAndTeamData.organizationId,
                    teamId: baseContext.organizationAndTeamData.teamId,
                    pullRequestNumber: baseContext.pullRequest.number,
                },
            });

            return {
                validSuggestionsToAnalyze: [],
                discardedSuggestionsBySafeGuard: [],
                file,
                error: {
                    stage: this.stageName,
                    substage: file.filename,
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    metadata: {
                        filename: file.filename,
                    },
                },
            };
        }
    }

    private async processAnalysisResult(
        result: AIAnalysisResult,
        context: AnalysisContext,
    ): Promise<IFinalAnalysisResult> {
        const { reviewModeResponse } = context;
        const { file, relevantContent, patchWithLinesStr } =
            context.fileChangeContext;

        const validSuggestionsToAnalyze: Partial<CodeSuggestion>[] = [];
        const discardedSuggestionsBySafeGuard: Partial<CodeSuggestion>[] = [];
        let safeguardLLMProvider = '';

        const crossFileAnalysisSuggestions =
            context?.validCrossFileSuggestions || [];

        const validCrossFileSuggestions = crossFileAnalysisSuggestions?.filter(
            (suggestion) => suggestion.relevantFile === file.filename,
        );

        const initialFilterResult = await this.initialFilterSuggestions(
            result,
            context,
            validCrossFileSuggestions,
            patchWithLinesStr,
        );

        const kodyFineTuningResult = await this.applyKodyFineTuningFilter(
            initialFilterResult.filteredSuggestions,
            context,
        );

        const discardedSuggestionsByCodeDiff =
            initialFilterResult.discardedSuggestionsByCodeDiff;
        const discardedSuggestionsByKodyFineTuning =
            kodyFineTuningResult.discardedSuggestionsByKodyFineTuning;
        const keepedSuggestions = kodyFineTuningResult.keepedSuggestions;

        // Separar sugestões cross-file das demais
        const crossFileIds = new Set(
            validCrossFileSuggestions?.map((suggestion) => suggestion.id),
        );

        const filteredCrossFileSuggestions = keepedSuggestions.filter(
            (suggestion) => crossFileIds?.has(suggestion.id),
        );

        const filteredKeepedSuggestions = keepedSuggestions.filter(
            (suggestion) => !crossFileIds?.has(suggestion.id),
        );

        // Aplicar safeguard apenas nas sugestões não cross-file
        const safeGuardResult = await this.applySafeguardFilter(
            filteredKeepedSuggestions,
            context,
            file,
            relevantContent,
            patchWithLinesStr,
            reviewModeResponse,
        );

        safeguardLLMProvider = safeGuardResult.safeguardLLMProvider;

        discardedSuggestionsBySafeGuard.push(
            ...safeGuardResult.allDiscardedSuggestions,
            ...discardedSuggestionsByCodeDiff,
            ...discardedSuggestionsByKodyFineTuning,
        );

        const suggestionsWithSeverity =
            await this.suggestionService.analyzeSuggestionsSeverity(
                context?.organizationAndTeamData,
                context?.pullRequest?.number,
                safeGuardResult.safeguardSuggestions,
                context?.codeReviewConfig?.reviewOptions,
                context?.codeReviewConfig?.codeReviewVersion,
                context?.codeReviewConfig?.byokConfig,
            );

        const crossFileSuggestionsWithSeverity =
            await this.suggestionService.analyzeSuggestionsSeverity(
                context?.organizationAndTeamData,
                context?.pullRequest?.number,
                filteredCrossFileSuggestions,
                context?.codeReviewConfig?.reviewOptions,
                context?.codeReviewConfig?.codeReviewVersion,
                context?.codeReviewConfig?.byokConfig,
            );

        // Apply severity level filter to cross-file suggestions
        // This is needed because cross-file suggestions skip applySafeguardFilter,
        // which contains the severity pre-filter for v2 (and is the only severity
        // level gate when limitationType is SEVERITY, since it overrides
        // severityLevelFilter to LOW in the downstream prioritizeSuggestionsLegacy)
        let filteredCrossFileFinal = crossFileSuggestionsWithSeverity;

        const severityLevelFilter =
            context?.codeReviewConfig?.suggestionControl?.severityLevelFilter;

        if (
            severityLevelFilter &&
            crossFileSuggestionsWithSeverity?.length > 0
        ) {
            const prioritizedCrossFile =
                await this.suggestionService.filterSuggestionsBySeverityLevel(
                    crossFileSuggestionsWithSeverity,
                    severityLevelFilter,
                    context?.organizationAndTeamData,
                    context?.pullRequest?.number,
                );

            const discardedCrossFileBySeverity = prioritizedCrossFile.filter(
                (suggestion) =>
                    suggestion.priorityStatus ===
                    PriorityStatus.DISCARDED_BY_SEVERITY,
            );

            if (discardedCrossFileBySeverity.length > 0) {
                discardedSuggestionsBySafeGuard.push(
                    ...discardedCrossFileBySeverity,
                );
            }

            filteredCrossFileFinal = prioritizedCrossFile.filter(
                (suggestion) =>
                    suggestion.priorityStatus === PriorityStatus.PRIORITIZED,
            );
        }

        let mergedSuggestions = [];

        const kodyRulesSuggestions =
            await this.codeAnalysisOrchestrator.executeKodyRulesAnalysis(
                context?.organizationAndTeamData,
                context?.pullRequest?.number,
                { file, patchWithLinesStr },
                context,
                {
                    codeSuggestions: suggestionsWithSeverity,
                },
            );

        if (kodyRulesSuggestions?.codeSuggestions?.length > 0) {
            mergedSuggestions.push(...kodyRulesSuggestions.codeSuggestions);
        }

        // Se tem sugestões com severidade, adiciona também
        if (
            !kodyRulesSuggestions?.codeSuggestions?.length &&
            suggestionsWithSeverity?.length > 0
        ) {
            mergedSuggestions.push(...suggestionsWithSeverity);
        }

        const kodyASTSuggestions =
            await this.kodyAstAnalyzeContextPreparation.prepareKodyASTAnalyzeContext(
                context,
            );

        // Garantir que as sugestões do AST tenham IDs
        const kodyASTSuggestionsWithId = await this.addSuggestionsId(
            kodyASTSuggestions?.codeSuggestions || [],
        );

        mergedSuggestions = [
            ...mergedSuggestions,
            ...kodyASTSuggestionsWithId,
            ...filteredCrossFileFinal,
        ];

        const VALID_ACTIONS = [
            'synchronize',
            'update',
            'updated',
            'git.pullrequest.updated',
        ];

        // If it's a commit, validate repeated suggestions
        // We keep it here to ensure immediate feedback within the review session context, but avoid race conditions
        // by checking if the async job will likely cover it (though redundancy is generally safe as operations are idempotent).
        if (context?.action && VALID_ACTIONS.includes(context.action)) {
            const savedSuggestions =
                await this.pullRequestService.findSuggestionsByPRAndFilename(
                    context?.pullRequest?.number,
                    context?.pullRequest?.base?.repo?.fullName,
                    file.filename,
                    context.organizationAndTeamData,
                );

            if (savedSuggestions?.length > 0 && mergedSuggestions?.length > 0) {
                mergedSuggestions =
                    await this.suggestionService.removeSuggestionsRelatedToSavedFiles(
                        context?.organizationAndTeamData,
                        context?.pullRequest?.number.toString(),
                        savedSuggestions,
                        mergedSuggestions,
                    );
            }
        }

        if (mergedSuggestions?.length > 0) {
            await Promise.all(
                mergedSuggestions.map(async (suggestion) => {
                    suggestion.rankScore =
                        await this.suggestionService.calculateSuggestionRankScore(
                            suggestion,
                        );
                }),
            );
        }

        validSuggestionsToAnalyze.push(...mergedSuggestions);

        return {
            validSuggestionsToAnalyze,
            discardedSuggestionsBySafeGuard:
                discardedSuggestionsBySafeGuard || [],
            reviewMode: reviewModeResponse,
            codeReviewModelUsed: {
                generateSuggestions:
                    result?.codeReviewModelUsed?.generateSuggestions,
                safeguard: safeguardLLMProvider,
            },
        };
    }

    private async addSuggestionsId(suggestions: any[]): Promise<any[]> {
        return suggestions?.map((suggestion) => ({
            ...suggestion,
            id: suggestion?.id || uuidv4(),
        }));
    }

    private async initialFilterSuggestions(
        result: AIAnalysisResult,
        context: AnalysisContext,
        crossFileAnalysis: CodeSuggestion[],
        patchWithLinesStr: string,
    ): Promise<{
        filteredSuggestions: Partial<CodeSuggestion>[];
        discardedSuggestionsByCodeDiff: Partial<CodeSuggestion>[];
    }> {
        // Combinar sugestões regulares com cross-file suggestions
        const allSuggestions = [
            ...(result.codeSuggestions || []),
            ...crossFileAnalysis,
        ];

        // Adicionar IDs apenas uma vez, aqui
        const suggestionsWithId = await this.addSuggestionsId(allSuggestions);

        const combinedResult = {
            ...result,
            codeSuggestions: suggestionsWithId,
        };

        const filteredSuggestionsByOptions =
            this.suggestionService.filterCodeSuggestionsByReviewOptions(
                context?.codeReviewConfig?.reviewOptions,
                combinedResult,
            );

        const filterSuggestionsCodeDiff =
            await this.suggestionService.filterSuggestionsCodeDiff(
                patchWithLinesStr,
                filteredSuggestionsByOptions.codeSuggestions,
            );

        const discardedSuggestionsByCodeDiff =
            this.suggestionService.getDiscardedSuggestions(
                filteredSuggestionsByOptions.codeSuggestions,
                filterSuggestionsCodeDiff,
                PriorityStatus.DISCARDED_BY_CODE_DIFF,
            );

        return {
            filteredSuggestions: filterSuggestionsCodeDiff,
            discardedSuggestionsByCodeDiff,
        };
    }

    private async applyKodyFineTuningFilter(
        filteredSuggestions: any[],
        context: AnalysisContext,
    ): Promise<{
        keepedSuggestions: Partial<CodeSuggestion>[];
        discardedSuggestionsByKodyFineTuning: Partial<CodeSuggestion>[];
    }> {
        const getDataPipelineKodyFineTunning =
            await this.kodyFineTuningContextPreparation.prepareKodyFineTuningContext(
                context?.organizationAndTeamData.organizationId,
                context?.pullRequest?.number,
                {
                    id: context?.pullRequest?.repository?.id || '',
                    full_name: context?.pullRequest?.repository?.fullName || '',
                },
                filteredSuggestions,
                context?.codeReviewConfig?.kodyFineTuningConfig?.enabled,
                context?.clusterizedSuggestions,
            );

        const keepedSuggestions: Partial<CodeSuggestion>[] =
            getDataPipelineKodyFineTunning?.keepedSuggestions;

        const discardedSuggestions: Partial<CodeSuggestion>[] =
            getDataPipelineKodyFineTunning?.discardedSuggestions;

        const discardedSuggestionsByKodyFineTuning = discardedSuggestions.map(
            (suggestion) => {
                suggestion.priorityStatus =
                    PriorityStatus.DISCARDED_BY_KODY_FINE_TUNING;
                return suggestion;
            },
        );

        return {
            keepedSuggestions,
            discardedSuggestionsByKodyFineTuning,
        };
    }

    private async applySafeguardFilter(
        suggestions: Partial<CodeSuggestion>[],
        context: AnalysisContext,
        file: any,
        relevantContent,
        patchWithLinesStr: string,
        reviewModeResponse: any,
    ): Promise<{
        safeguardSuggestions: Partial<CodeSuggestion>[];
        allDiscardedSuggestions: Partial<CodeSuggestion>[];
        safeguardLLMProvider: string;
    }> {
        let filteredSuggestions = suggestions;
        let discardedSuggestionsBySeverity = [];

        if (
            context?.codeReviewConfig?.codeReviewVersion ===
            CodeReviewVersion.v2
        ) {
            const prioritizedSuggestions =
                await this.prioritizeSuggestionsBySeverityBeforeSafeGuard(
                    suggestions,
                    context,
                );

            filteredSuggestions = prioritizedSuggestions.filter(
                (suggestion) =>
                    suggestion.priorityStatus === PriorityStatus.PRIORITIZED,
            );

            discardedSuggestionsBySeverity = prioritizedSuggestions.filter(
                (suggestion) =>
                    suggestion.priorityStatus ===
                    PriorityStatus.DISCARDED_BY_SEVERITY,
            );
        }

        const safeGuardResponse =
            await this.suggestionService.filterSuggestionsSafeGuard(
                context?.organizationAndTeamData,
                context?.pullRequest?.number,
                file,
                relevantContent,
                patchWithLinesStr,
                filteredSuggestions,
                context?.codeReviewConfig?.languageResultPrompt,
                reviewModeResponse,
                context?.codeReviewConfig?.byokConfig,
            );

        const safeguardLLMProvider =
            safeGuardResponse?.codeReviewModelUsed?.safeguard || '';

        const discardedSuggestionsBySafeGuard =
            this.suggestionService.getDiscardedSuggestions(
                filteredSuggestions,
                safeGuardResponse?.suggestions || [],
                PriorityStatus.DISCARDED_BY_SAFEGUARD,
            );

        const allDiscardedSuggestions = [
            ...discardedSuggestionsBySeverity,
            ...discardedSuggestionsBySafeGuard,
        ];

        return {
            safeguardSuggestions: safeGuardResponse?.suggestions || [],
            allDiscardedSuggestions,
            safeguardLLMProvider,
        };
    }

    private async prioritizeSuggestionsBySeverityBeforeSafeGuard(
        suggestions: Partial<CodeSuggestion>[],
        context: AnalysisContext,
    ): Promise<Partial<CodeSuggestion>[]> {
        const prioritizedSuggestions =
            await this.suggestionService.filterSuggestionsBySeverityLevel(
                suggestions,
                context?.codeReviewConfig?.suggestionControl
                    ?.severityLevelFilter,
                context?.organizationAndTeamData,
                context?.pullRequest?.number,
            );

        return prioritizedSuggestions;
    }

    private createAnalysisContextFromPipelineContext(
        context: CodeReviewPipelineContext,
    ): AnalysisContext {
        return {
            organizationAndTeamData: context.organizationAndTeamData,
            repository: context.repository,
            pullRequest: context.pullRequest,
            action: context.action,
            platformType: context.platformType,
            codeReviewConfig: context.codeReviewConfig,
            clusterizedSuggestions: context.clusterizedSuggestions,
            validCrossFileSuggestions:
                context.prAnalysisResults?.validCrossFileSuggestions || [],
            tasks: context.tasks,
            externalPromptContext: context.externalPromptContext,
            externalPromptLayers: context.externalPromptLayers,
            correlationId: context.correlationId,
            sharedContextPack: context.sharedContextPack,
            augmentationsByFile: context.augmentationsByFile,
            filePromptOverrides: this.buildFilePromptOverrides(
                context.fileContextMap,
            ),
        };
    }

    private buildFilePromptOverrides(
        fileContextMap?: Record<string, FileContextAgentResult>,
    ): Record<string, CodeReviewConfig['v2PromptOverrides']> | undefined {
        if (!fileContextMap) {
            return undefined;
        }

        const map: Record<string, CodeReviewConfig['v2PromptOverrides']> = {};
        for (const [fileName, entry] of Object.entries(fileContextMap)) {
            if (entry?.resolvedPromptOverrides) {
                map[fileName] = entry.resolvedPromptOverrides;
            }
        }

        return Object.keys(map).length ? map : undefined;
    }
}
