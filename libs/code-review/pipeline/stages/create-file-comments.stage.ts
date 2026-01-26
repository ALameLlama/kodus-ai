import { createLogger } from '@kodus/flow';
import {
    COMMENT_MANAGER_SERVICE_TOKEN,
    ICommentManagerService,
} from '@libs/code-review/domain/contracts/CommentManagerService.contract';
import {
    ISuggestionService,
    SUGGESTION_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/SuggestionService.contract';
import { PlatformType } from '@libs/core/domain/enums';
import {
    ClusteringType,
    CodeReviewConfig,
    CodeSuggestion,
    CommentResult,
    FileChange,
    Repository,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { Commit } from '@libs/core/infrastructure/config/types/general/commit.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import {
    DRY_RUN_SERVICE_TOKEN,
    IDryRunService,
} from '@libs/dryRun/domain/contracts/dryRun.service.contract';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { ICommit } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';

@Injectable()
export class CreateFileCommentsStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'CreateFileCommentsStage';
    private readonly logger = createLogger(CreateFileCommentsStage.name);

    constructor(
        @Inject(COMMENT_MANAGER_SERVICE_TOKEN)
        private readonly commentManagerService: ICommentManagerService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestService: IPullRequestsService,

        @Inject(SUGGESTION_SERVICE_TOKEN)
        private readonly suggestionService: ISuggestionService,

        @Inject(DRY_RUN_SERVICE_TOKEN)
        private readonly dryRunService: IDryRunService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        // Validações fundamentais de segurança
        if (!context?.organizationAndTeamData) {
            this.logger.error({
                message: 'Missing organizationAndTeamData in context',
                context: this.stageName,
            });
            return context;
        }

        if (!context?.pullRequest?.number) {
            this.logger.error({
                message: 'Missing pullRequest data in context',
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });
            return context;
        }

        if (!context?.repository?.name || !context?.repository?.id) {
            this.logger.error({
                message: 'Missing repository data in context',
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                },
            });
            return context;
        }

        // Verificar se há sugestões para processar
        const validSuggestions = context?.validSuggestions || [];
        const discardedSuggestions = context?.discardedSuggestions || [];
        const changedFiles = context?.changedFiles || [];

        // Resolve comments that refer to suggestions partially or fully implemented
        await this.suggestionService.resolveImplementedSuggestionsOnPlatform({
            organizationAndTeamData: context.organizationAndTeamData,
            repository: context.repository,
            prNumber: context.pullRequest.number,
            platformType: context.platformType as PlatformType,
            dryRun: context.dryRun,
        });

        if (validSuggestions.length === 0) {
            this.logger.log({
                message: `No file-level suggestions to process for PR#${context.pullRequest.number}`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                    discardedSuggestionsCount: discardedSuggestions.length,
                },
            });

            // Usar todos os commits para determinar o lastAnalyzedCommit
            const allCommits = context.prAllCommits;

            if (!allCommits?.length) {
                return context;
            }

            const lastAnalyzedCommit = allCommits[allCommits.length - 1];

            return this.updateContext(context, (draft) => {
                draft.lineComments = [];
                draft.lastAnalyzedCommit = lastAnalyzedCommit;
            });
        }

        try {
            this.logger.log({
                message: `Starting file comments creation for PR#${context.pullRequest.number}`,
                context: this.stageName,
                metadata: {
                    validSuggestionsCount: validSuggestions.length,
                    discardedSuggestionsCount: discardedSuggestions.length,
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                },
            });

            const { lineComments, lastAnalyzedCommit } =
                await this.finalizeReviewProcessing(
                    context,
                    changedFiles,
                    validSuggestions,
                    discardedSuggestions,
                );

            this.logger.log({
                message: `Successfully processed file comments for PR#${context.pullRequest.number}`,
                context: this.stageName,
                metadata: {
                    lineCommentsCreated: lineComments.length,
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                },
            });

            return this.updateContext(context, (draft) => {
                draft.lineComments = lineComments;
                draft.lastAnalyzedCommit = lastAnalyzedCommit;
            });
        } catch (error) {
            this.logger.error({
                message: `Error during file comments creation for PR#${context.pullRequest.number}`,
                context: this.stageName,
                error,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    validSuggestionsCount: validSuggestions.length,
                },
            });

            // Em caso de erro, retorna contexto com valores padrão
            return this.updateContext(context, (draft) => {
                draft.lineComments = [];
                draft.lastAnalyzedCommit = null;
            });
        }
    }

    /**
     * Finalizes the code review process by generating comments and saving suggestions
     * @param context Pipeline context
     * @param changedFiles Files changed in the PR
     * @param validSuggestionsToAnalyze Valid suggestions found
     * @param discardedSuggestionsBySafeGuard Discarded suggestions
     * @returns Processing result with comments and suggestions
     */
    private async finalizeReviewProcessing(
        context: CodeReviewPipelineContext,
        changedFiles: FileChange[],
        validSuggestionsToAnalyze: Partial<CodeSuggestion>[],
        discardedSuggestionsBySafeGuard: Partial<CodeSuggestion>[],
    ): Promise<{
        lineComments: Array<CommentResult>;
        lastAnalyzedCommit: any;
    }> {
        const {
            organizationAndTeamData,
            pullRequest,
            codeReviewConfig,
            repository,
            platformType,
            dryRun,
        } = context;

        // Sort and prioritize suggestions
        const { sortedPrioritizedSuggestions, allDiscardedSuggestions } =
            await this.suggestionService.sortAndPrioritizeSuggestions(
                organizationAndTeamData,
                codeReviewConfig,
                pullRequest,
                validSuggestionsToAnalyze,
                discardedSuggestionsBySafeGuard,
            );

        // Create line comments
        const { commentResults, lastAnalyzedCommit } =
            await this.createLineComments(
                organizationAndTeamData,
                pullRequest,
                sortedPrioritizedSuggestions,
                repository,
                codeReviewConfig,
                dryRun,
                context.pipelineMetadata?.lastExecution?.dataExecution
                    ?.lastAnalyzedCommit || null,
                context.pullRequestMessagesConfig?.globalSettings
                    ?.suggestionCopyPrompt,
            );

        // Save pull request suggestions
        await this.savePullRequestSuggestions(
            organizationAndTeamData,
            pullRequest,
            repository,
            changedFiles,
            commentResults,
            sortedPrioritizedSuggestions,
            allDiscardedSuggestions,
            platformType,
            context.fileMetadata,
            dryRun,
            context.prAllCommits,
        );

        return {
            lineComments: commentResults,
            lastAnalyzedCommit,
        };
    }

    private calculateStartLine(suggestion: any) {
        if (
            suggestion.relevantLinesStart === undefined ||
            suggestion.relevantLinesStart === suggestion.relevantLinesEnd
        ) {
            return undefined;
        }
        return suggestion.relevantLinesStart + 15 > suggestion.relevantLinesEnd
            ? suggestion.relevantLinesStart
            : undefined;
    }

    private calculateEndLine(suggestion: any) {
        if (
            suggestion.relevantLinesStart === undefined ||
            suggestion.relevantLinesStart === suggestion.relevantLinesEnd
        ) {
            return suggestion.relevantLinesEnd;
        }
        return suggestion.relevantLinesStart + 15 > suggestion.relevantLinesEnd
            ? suggestion.relevantLinesEnd
            : suggestion.relevantLinesStart;
    }

    private async createLineComments(
        organizationAndTeamData: OrganizationAndTeamData,
        pullRequest: { number: number },
        sortedPrioritizedSuggestions: any[],
        repository: Partial<Repository>,
        codeReviewConfig: CodeReviewConfig,
        dryRun: CodeReviewPipelineContext['dryRun'],
        lastAnalyzedCommitFromContext: any,
        suggestionCopyPrompt?: boolean,
    ) {
        try {
            const lineComments = sortedPrioritizedSuggestions
                .filter(
                    (suggestion) =>
                        suggestion.clusteringInformation?.type !==
                        ClusteringType.RELATED,
                )
                .map((suggestion) => {
                    return {
                        path: suggestion.relevantFile,
                        body: {
                            language: repository?.language,
                            improvedCode: suggestion?.improvedCode,
                            suggestionContent: suggestion?.suggestionContent,
                            actionStatement:
                                suggestion?.clusteringInformation
                                    ?.actionStatement || '',
                        },
                        start_line: this.calculateStartLine(suggestion),
                        line: this.calculateEndLine(suggestion),
                        side: 'RIGHT',
                        suggestion,
                    };
                });

            const { lastAnalyzedCommit, commentResults } =
                await this.commentManagerService.createLineComments(
                    organizationAndTeamData,
                    pullRequest?.number,
                    {
                        name: repository.name,
                        id: repository.id,
                        language: repository.language,
                    },
                    lineComments,
                    codeReviewConfig?.languageResultPrompt,
                    dryRun,
                    suggestionCopyPrompt,
                );

            return { lastAnalyzedCommit, commentResults };
        } catch (error) {
            this.logger.error({
                message: `Error when trying to create line comments for PR#${pullRequest.number}`,
                error: error,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData,
                    prNumber: pullRequest.number,
                    repositoryName: repository?.name,
                },
            });
            return {
                lastAnalyzedCommit: lastAnalyzedCommitFromContext,
                commentResults: [],
            };
        }
    }

    private async savePullRequestSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        pullRequest: { number: number },
        repository: Partial<Repository>,
        changedFiles: FileChange[],
        commentResults: CommentResult[],
        sortedPrioritizedSuggestions: Partial<CodeSuggestion>[],
        discardedSuggestions: Partial<CodeSuggestion>[],
        platformType: string,
        fileMetadata?: Map<string, any>,
        dryRun?: CodeReviewPipelineContext['dryRun'],
        prCommits?: Commit[],
    ) {
        const enrichedFiles = changedFiles.map((file) => {
            const metadata = fileMetadata?.get(file.filename);
            if (metadata) {
                return {
                    ...file,
                    reviewMode: metadata.reviewMode,
                    codeReviewModelUsed: metadata.codeReviewModelUsed,
                };
            }
            return file;
        });

        if (dryRun?.enabled) {
            await this.dryRunService.addFilesToDryRun({
                organizationAndTeamData,
                id: dryRun?.id,
                files: enrichedFiles,
                prioritizedSuggestions: sortedPrioritizedSuggestions as any,
                unusedSuggestions: discardedSuggestions as any,
            });

            return;
        }

        const suggestionsWithStatus =
            await this.suggestionService.verifyIfSuggestionsWereSent(
                organizationAndTeamData,
                pullRequest,
                sortedPrioritizedSuggestions,
                commentResults,
            );

        // Reutilizar commits do context (buscados no ValidateNewCommitsStage)
        const pullRequestCommits = prCommits || [];

        await this.pullRequestService.aggregateAndSaveDataStructure(
            pullRequest,
            repository,
            enrichedFiles,
            suggestionsWithStatus,
            discardedSuggestions,
            platformType,
            organizationAndTeamData,
            pullRequestCommits as unknown as ICommit[],
        );
    }
}
