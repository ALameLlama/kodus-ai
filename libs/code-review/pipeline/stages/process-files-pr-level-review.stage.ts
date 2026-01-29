import { createLogger } from '@kodus/flow';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { PipelineError } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-context.interface';
import { Inject, Injectable } from '@nestjs/common';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';

import {
    CROSS_FILE_ANALYSIS_SERVICE_TOKEN,
    CrossFileAnalysisService,
} from '@libs/code-review/infrastructure/adapters/services/crossFileAnalysis.service';
import {
    CodeSuggestion,
    ReviewModeResponse,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { ISuggestionByPR } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import {
    KODY_RULES_PR_LEVEL_ANALYSIS_SERVICE_TOKEN,
    KodyRulesPrLevelAnalysisService,
} from '@libs/ee/codeBase/kodyRulesPrLevelAnalysis.service';
import { KodyRulesScope } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

@Injectable()
export class ProcessFilesPrLevelReviewStage extends BasePipelineStage<CodeReviewPipelineContext> {
    private readonly logger = createLogger(ProcessFilesPrLevelReviewStage.name);
    readonly stageName = 'PRLevelReviewStage';
    readonly label = 'Reviewing PR Level';
    readonly visibility = StageVisibility.PRIMARY;

    constructor(
        @Inject(KODY_RULES_PR_LEVEL_ANALYSIS_SERVICE_TOKEN)
        private readonly kodyRulesPrLevelAnalysisService: KodyRulesPrLevelAnalysisService,

        @Inject(CROSS_FILE_ANALYSIS_SERVICE_TOKEN)
        private readonly crossFileAnalysisService: CrossFileAnalysisService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
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

        if (!context?.changedFiles?.length) {
            this.logger.warn({
                message: `No files to analyze for PR#${context.pullRequest.number}`,
                context: this.stageName,
                metadata: {
                    organizationId:
                        context.organizationAndTeamData.organizationId,
                    prNumber: context.pullRequest.number,
                },
            });
            return context;
        }

        const kodyRulesResult = await this.runKodyRulesAnalysis(context);
        const crossFileResult = await this.runCrossFileAnalysis(context);

        return this.updateContext(context, (draft) => {
            // Kody Rules Results
            if (kodyRulesResult?.suggestions?.length > 0) {
                if (!draft.validSuggestionsByPR) {
                    draft.validSuggestionsByPR = [];
                }
                draft.validSuggestionsByPR.push(...kodyRulesResult.suggestions);
            }

            // Cross File Results
            if (crossFileResult?.suggestions?.length > 0) {
                if (!draft.prAnalysisResults) {
                    draft.prAnalysisResults = {};
                }
                if (!draft.prAnalysisResults.validCrossFileSuggestions) {
                    draft.prAnalysisResults.validCrossFileSuggestions = [];
                }
                draft.prAnalysisResults.validCrossFileSuggestions.push(
                    ...crossFileResult.suggestions,
                );
            }

            // Aggregate Errors
            if (kodyRulesResult?.error) {
                draft.errors.push(kodyRulesResult.error);
            }

            if (crossFileResult?.error) {
                draft.errors.push(crossFileResult.error);
            }
        });
    }

    private async runKodyRulesAnalysis(
        context: CodeReviewPipelineContext,
    ): Promise<{ suggestions: ISuggestionByPR[]; error?: PipelineError }> {
        try {
            const prLevelRules = context?.codeReviewConfig?.kodyRules?.filter(
                (rule) => rule.scope === KodyRulesScope.PULL_REQUEST,
            );

            if (prLevelRules?.length > 0) {
                this.logger.log({
                    message: `Starting PR-level Kody Rules analysis for PR#${context.pullRequest.number}`,
                    context: this.stageName,
                    metadata: {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        prNumber: context.pullRequest.number,
                    },
                });

                const kodyRulesPrLevelAnalysis =
                    await this.kodyRulesPrLevelAnalysisService.analyzeCodeWithAI(
                        context.organizationAndTeamData,
                        context.pullRequest.number,
                        context.changedFiles,
                        ReviewModeResponse.HEAVY_MODE,
                        context,
                    );

                if (kodyRulesPrLevelAnalysis?.codeSuggestions?.length > 0) {
                    this.logger.log({
                        message: `PR-level analysis completed for PR#${context.pullRequest.number}`,
                        context: this.stageName,
                        metadata: {
                            suggestionsCount:
                                kodyRulesPrLevelAnalysis?.codeSuggestions
                                    ?.length,
                            organizationAndTeamData:
                                context.organizationAndTeamData,
                            prNumber: context.pullRequest.number,
                        },
                    });

                    return {
                        suggestions: kodyRulesPrLevelAnalysis.codeSuggestions,
                    };
                } else {
                    this.logger.warn({
                        message: `Analysis returned null for PR#${context.pullRequest.number}`,
                        context: this.stageName,
                        metadata: {
                            organizationAndTeamData:
                                context.organizationAndTeamData,
                        },
                    });
                }
            }

            return { suggestions: [] };
        } catch (error) {
            this.logger.error({
                message: `Error during PR-level Kody Rules analysis for PR#${context.pullRequest.number}`,
                context: this.stageName,
                error,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                },
            });

            return {
                suggestions: [],
                error: {
                    stage: this.stageName,
                    substage: 'KodyRulesAnalysis',
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    metadata: {
                        prNumber: context.pullRequest.number,
                    },
                },
            };
        }
    }

    private async runCrossFileAnalysis(
        context: CodeReviewPipelineContext,
    ): Promise<{ suggestions: CodeSuggestion[]; error?: PipelineError }> {
        try {
            const preparedFilesData = context.changedFiles.map((file) => ({
                filename: file.filename,
                patchWithLinesStr: file.patchWithLinesStr,
            }));

            const crossFileAnalysis =
                await this.crossFileAnalysisService.analyzeCrossFileCode(
                    context.organizationAndTeamData,
                    context.pullRequest.number,
                    context,
                    preparedFilesData,
                );

            const crossFileAnalysisSuggestions =
                crossFileAnalysis?.codeSuggestions || [];

            if (crossFileAnalysisSuggestions.length > 0) {
                this.logger.log({
                    message: `Cross-file analysis completed for PR#${context.pullRequest.number}`,
                    context: this.stageName,
                    metadata: {
                        suggestionsCount: crossFileAnalysisSuggestions.length,
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        prNumber: context.pullRequest.number,
                    },
                });

                return { suggestions: crossFileAnalysisSuggestions };
            } else {
                this.logger.log({
                    message: `No cross-file analysis suggestions found for PR#${context.pullRequest.number}`,
                    context: this.stageName,
                    metadata: {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                    },
                });

                return { suggestions: [] };
            }
        } catch (error) {
            this.logger.error({
                message: `Error during Cross-file analysis for PR#${context.pullRequest.number}`,
                context: this.stageName,
                error,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                },
            });

            return {
                suggestions: [],
                error: {
                    stage: this.stageName,
                    substage: 'CrossFileAnalysis',
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    metadata: {
                        prNumber: context.pullRequest.number,
                    },
                },
            };
        }
    }
}
