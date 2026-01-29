import { createLogger } from '@kodus/flow';
import {
    AST_ANALYSIS_SERVICE_TOKEN,
    IASTAnalysisService,
} from '@libs/code-review/domain/contracts/ASTAnalysisService.contract';
import {
    ASTValidateCodeItem,
    ASTValidateCodeRequest,
    SUPPORTED_LANGUAGES,
} from '@libs/code-review/domain/types/astValidate.type';
import posthog, { FEATURE_FLAGS } from '@libs/common/utils/posthog';
import { PlatformType } from '@libs/core/domain/enums';
import {
    CodeSuggestion,
    FileChange,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { PipelineReasons } from '@libs/core/infrastructure/pipeline/constants/pipeline-reasons.const';
import { StageMessageHelper } from '@libs/core/infrastructure/pipeline/utils/stage-message.helper';
import { TaskStatus } from '@libs/ee/kodyAST/interfaces/code-ast-analysis.interface';
import { applyEdit } from '@morphllm/morphsdk';
import { Inject, Injectable } from '@nestjs/common';
import { parsePatch } from 'diff';
import pLimit from 'p-limit';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

@Injectable()
export class ValidateSuggestionsStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName: string = 'ValidateSuggestionsStage';
    private readonly logger = createLogger(ValidateSuggestionsStage.name);
    private readonly concurrencyLimit = 10;
    private readonly MAX_LINES_THRESHOLD = 15;
    private readonly MAX_CHARS_THRESHOLD = 1000;

    constructor(
        @Inject(AST_ANALYSIS_SERVICE_TOKEN)
        private readonly astAnalysisService: IASTAnalysisService,
    ) {
        super();
    }

    protected override async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const { validSuggestions, changedFiles, organizationAndTeamData } =
            context;

        if (!(await this.shouldRunStage(context))) return context;

        const filteredSuggestions = await this.filterComplexSuggestions(
            validSuggestions,
            context,
        );

        if (filteredSuggestions.length === 0) {
            this.logger.log({
                message: 'All suggestions filtered out as too complex/long',
                context: ValidateSuggestionsStage.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                },
            });

            return context;
        }

        const patchedFiles = await this.preparePatchedFiles(
            filteredSuggestions,
            changedFiles,
        );

        if (patchedFiles.files.length === 0) {
            this.logger.log({
                message: 'No patched files generated for validation',
                context: ValidateSuggestionsStage.name,
                metadata: {
                    validSuggestions: filteredSuggestions,
                    changedFiles,
                    organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                },
            });

            return context;
        }

        try {
            const validSuggestionIds = await this.validateSuggestions(
                patchedFiles,
                context.organizationAndTeamData,
                context.pullRequest.number,
            );

            const updatedSuggestions = context.validSuggestions.map(
                (suggestion) => {
                    if (!validSuggestionIds.has(suggestion.id!)) {
                        return suggestion;
                    }

                    const patchedFile = patchedFiles.files.find(
                        (f) => f.id === suggestion.id,
                    );

                    if (!patchedFile || !patchedFile.suggestion) {
                        return suggestion;
                    }

                    return {
                        ...suggestion,
                        isCommittable: true,
                        validatedCode: patchedFile.suggestion,
                    };
                },
            );

            return this.updateContext(context, (draft) => {
                draft.validSuggestions = updatedSuggestions;
            });
        } catch (error) {
            this.logger.error({
                message: 'Error during validation process',
                context: ValidateSuggestionsStage.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                },
            });

            throw new Error(
                StageMessageHelper.error(
                    PipelineReasons.SUGGESTIONS.VALIDATION_FAILED.message,
                    error,
                ),
            );
        }
    }

    private async shouldRunStage(context: CodeReviewPipelineContext) {
        const {
            organizationAndTeamData,
            pullRequest,
            platformType,
            codeReviewConfig,
            validSuggestions,
            changedFiles,
        } = context;

        const prNumber = pullRequest.number;

        const featureFlag = await posthog.isFeatureEnabled(
            FEATURE_FLAGS.committableSuggestions,
            organizationAndTeamData.organizationId,
            organizationAndTeamData,
        );

        if (!featureFlag) {
            this.logger.debug({
                message: 'Committable suggestions feature is disabled',
                context: ValidateSuggestionsStage.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                },
            });

            return false;
        }

        if (!codeReviewConfig?.enableCommittableSuggestions) {
            this.logger.debug({
                message:
                    'Committable suggestions feature is disabled in the configuration',
                context: ValidateSuggestionsStage.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                },
            });

            return false;
        }

        if (platformType !== PlatformType.GITHUB) {
            this.logger.debug({
                message: 'Skipping validation stage for non-GitHub platform',
                context: ValidateSuggestionsStage.name,
                metadata: {
                    platformType,
                    prNumber,
                    organizationAndTeamData,
                },
            });

            return false;
        }

        if (!validSuggestions?.length || !changedFiles?.length) {
            this.logger.debug({
                message: 'No valid suggestions or changed files to validate',
                context: ValidateSuggestionsStage.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    validSuggestionsCount: validSuggestions?.length || 0,
                    changedFilesCount: changedFiles?.length || 0,
                },
            });

            return false;
        }

        return true;
    }

    private async filterComplexSuggestions(
        suggestions: Partial<CodeSuggestion>[],
        context: CodeReviewPipelineContext,
    ): Promise<Partial<CodeSuggestion>[]> {
        const limit = pLimit(this.concurrencyLimit);

        const tasks = suggestions.map((suggestion) =>
            limit(async () => {
                const chars = suggestion.improvedCode?.length || 0;
                const lines = suggestion.improvedCode?.split('\n').length || 0;

                if (chars >= this.MAX_CHARS_THRESHOLD) {
                    this.logger.log({
                        message:
                            'Discarding complex suggestion due to char count',
                        context: ValidateSuggestionsStage.name,
                        metadata: {
                            organizationAndTeamData:
                                context.organizationAndTeamData,
                            prNumber: context.pullRequest.number,
                            suggestionId: suggestion.id,
                            lines,
                            chars,
                        },
                    });

                    return null;
                }

                if (lines >= this.MAX_LINES_THRESHOLD) {
                    this.logger.log({
                        message:
                            'Discarding complex suggestion due to line count',
                        context: ValidateSuggestionsStage.name,
                        metadata: {
                            organizationAndTeamData:
                                context.organizationAndTeamData,
                            prNumber: context.pullRequest.number,
                            suggestionId: suggestion.id,
                            lines,
                            chars,
                        },
                    });

                    return null;
                }

                try {
                    const { isSimple, reason } =
                        await this.astAnalysisService.checkSuggestionSimplicity(
                            context.organizationAndTeamData,
                            context.pullRequest.number,
                            suggestion,
                        );

                    if (isSimple) {
                        return suggestion;
                    }

                    this.logger.log({
                        message: 'Discarding complex suggestion',
                        context: ValidateSuggestionsStage.name,
                        metadata: {
                            organizationAndTeamData:
                                context.organizationAndTeamData,
                            prNumber: context.pullRequest.number,
                            suggestionId: suggestion.id,
                            lines,
                            reason,
                        },
                    });

                    return null;
                } catch (error) {
                    this.logger.error({
                        message: 'Error checking suggestion simplicity',
                        context: ValidateSuggestionsStage.name,
                        metadata: {
                            suggestionId: suggestion.id,
                            organizationAndTeamData:
                                context.organizationAndTeamData,
                            prNumber: context.pullRequest.number,
                        },
                        error,
                    });
                    // Fail safe: discard if check fails
                    return null;
                }
            }),
        );

        const results = await Promise.allSettled(tasks);
        return results
            .filter(
                (
                    result,
                ): result is PromiseFulfilledResult<Partial<CodeSuggestion> | null> =>
                    result.status === 'fulfilled',
            )
            .map((result) => result.value)
            .filter((s): s is Partial<CodeSuggestion> => s !== null);
    }

    private async preparePatchedFiles(
        suggestions: Partial<CodeSuggestion>[],
        files: FileChange[],
    ): Promise<ASTValidateCodeRequest> {
        const suggestionsByFilePath = this.groupSuggestionsByFile(
            suggestions,
            files,
        );

        return this.generatePatchedFiles(suggestionsByFilePath);
    }

    private async validateSuggestions(
        patchedFiles: ASTValidateCodeRequest,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
    ): Promise<Set<string>> {
        const { taskId } = await this.startValidationTask(patchedFiles);

        await this.awaitValidationTask(taskId, organizationAndTeamData);

        const validationResults = await this.getValidationResults(
            taskId,
            patchedFiles,
            organizationAndTeamData,
            prNumber,
        );

        if (!validationResults?.length) {
            this.logger.warn({
                message: 'No validation results returned',
                context: ValidateSuggestionsStage.name,
                metadata: { organizationAndTeamData, prNumber, taskId },
            });

            return new Set();
        }

        this.logger.log({
            message: 'Validation results retrieved',
            context: ValidateSuggestionsStage.name,
            metadata: {
                resultsCount: validationResults?.length,
                organizationAndTeamData,
                prNumber,
                taskId,
            },
        });

        const passedValidationIds = validationResults
            ?.filter((r) => r.isValid)
            .map((r) => r.id)
            .filter((id): id is string => !!id);

        return new Set(passedValidationIds);
    }

    private groupSuggestionsByFile(
        suggestions: Partial<CodeSuggestion>[],
        files: FileChange[],
    ) {
        return suggestions.reduce<{
            [filePath: string]: {
                fileData: FileChange;
                suggestions: Partial<CodeSuggestion>[];
            };
        }>((acc, suggestion) => {
            const file = suggestion.relevantFile;
            if (!acc[file]) {
                const fileData = files.find((f) => f.filename === file);
                if (fileData) {
                    acc[file] = {
                        fileData,
                        suggestions: [],
                    };
                }
            }
            if (acc[file]) {
                acc[file].suggestions.push(suggestion);
            }
            return acc;
        }, {});
    }

    private isLanguageSupported(filename: string): boolean {
        const extension = filename.slice(filename.lastIndexOf('.'));
        if (!extension || extension === filename) return false;

        return Object.values(SUPPORTED_LANGUAGES).some((lang) =>
            lang.extensions.includes(extension),
        );
    }

    private async generatePatchedFiles(suggestionsByFilePath: {
        [filePath: string]: {
            fileData: FileChange;
            suggestions: Partial<CodeSuggestion>[];
        };
    }): Promise<ASTValidateCodeRequest> {
        const limit = pLimit(this.concurrencyLimit);
        const tasks: Promise<ASTValidateCodeItem | null>[] = [];

        for (const [filePath, { fileData, suggestions }] of Object.entries(
            suggestionsByFilePath,
        )) {
            if (!this.isLanguageSupported(filePath)) {
                this.logger.log({
                    message: `Skipping validation for unsupported file type`,
                    context: ValidateSuggestionsStage.name,
                    metadata: { filePath },
                });

                continue;
            }

            const originalCode = fileData?.fileContent;

            if (!originalCode) {
                this.logger.warn({
                    message: `Original code is empty for file`,
                    context: ValidateSuggestionsStage.name,
                    metadata: { filePath },
                });

                continue;
            }

            for (const suggestion of suggestions) {
                tasks.push(
                    limit(async () => {
                        try {
                            if (
                                !suggestion.id ||
                                !suggestion.improvedCode ||
                                !suggestion.llmPrompt
                            ) {
                                this.logger.warn({
                                    message: `Missing data in suggestion`,
                                    context: ValidateSuggestionsStage.name,
                                    metadata: {
                                        suggestionId: suggestion.id,
                                        filePath,
                                        improvedCodePresent:
                                            !!suggestion.improvedCode,
                                        llmPromptPresent:
                                            !!suggestion.llmPrompt,
                                    },
                                });

                                return null;
                            }

                            const result = await applyEdit(
                                {
                                    originalCode,
                                    codeEdit: suggestion.improvedCode,
                                    instructions: suggestion.llmPrompt,
                                    filepath: filePath,
                                },
                                {
                                    morphApiKey:
                                        process.env.API_MORPHLLM_API_KEY,
                                },
                            );

                            if (!result || !result.mergedCode) {
                                this.logger.warn({
                                    message: `MorphLLM failed to apply edit for suggestion`,
                                    context: ValidateSuggestionsStage.name,
                                    metadata: {
                                        suggestionId: suggestion.id,
                                        filePath,
                                        result,
                                    },
                                });

                                return null;
                            }

                            const encodedData = Buffer.from(
                                result.mergedCode,
                            ).toString('base64');

                            const formattedSuggestion =
                                this.getFormattedSuggestionFromDiff(
                                    result.udiff,
                                );

                            if (!formattedSuggestion) {
                                this.logger.warn({
                                    message: `Formatted suggestion is empty after diff processing`,
                                    context: ValidateSuggestionsStage.name,
                                    metadata: {
                                        suggestionId: suggestion.id,
                                        filePath,
                                    },
                                });

                                return null;
                            }

                            return {
                                id: suggestion.id,
                                filePath,
                                encodedData,
                                diff: result.udiff,
                                suggestion: formattedSuggestion,
                            };
                        } catch (error) {
                            this.logger.error({
                                message: `Error applying edit for suggestion ${suggestion.id}`,
                                context: ValidateSuggestionsStage.name,
                                error,
                                metadata: { filePath },
                            });

                            return null;
                        }
                    }),
                );
            }
        }

        const results = await Promise.allSettled(tasks);

        const files = results
            .filter(
                (
                    result,
                ): result is PromiseFulfilledResult<ASTValidateCodeItem> =>
                    result.status === 'fulfilled' && result.value !== null,
            )
            .map((result) => result.value);

        return { files };
    }

    private getFormattedSuggestionFromDiff(diff: string): string | null {
        const parsedDiff = parsePatch(diff);

        if (parsedDiff.length !== 1) {
            this.logger.warn({
                message:
                    'Suggestion diff affects multiple files, marking as complex.',
                context: ValidateSuggestionsStage.name,
                metadata: { diff },
            });

            return null;
        }

        const fileDiff = parsedDiff[0];

        if (fileDiff.hunks.length !== 1) {
            this.logger.warn({
                message:
                    'Suggestion contains multiple hunks, marking as complex.',
                context: ValidateSuggestionsStage.name,
                metadata: { diff },
            });

            return null;
        }

        const hunk = fileDiff.hunks[0];

        if (hunk.lines.length > this.MAX_LINES_THRESHOLD) {
            this.logger.warn({
                message:
                    'Suggestion hunk exceeds maximum line threshold, marking as complex.',
                context: ValidateSuggestionsStage.name,
                metadata: {
                    linesCount: hunk.lines.length,
                    diff,
                },
            });

            return null;
        }

        const charCount = hunk.lines.reduce(
            (acc, line) => acc + line.trim().length,
            0,
        );

        if (charCount > this.MAX_CHARS_THRESHOLD) {
            this.logger.warn({
                message:
                    'Suggestion hunk exceeds maximum character threshold, marking as complex.',
                context: ValidateSuggestionsStage.name,
                metadata: {
                    charCount: hunk.lines.reduce(
                        (acc, line) => acc + line.length,
                        0,
                    ),
                    diff,
                },
            });

            return null;
        }

        const suggestionLines: string[] = [];

        for (const line of hunk.lines) {
            if (line.startsWith('+') && !line.startsWith('+++')) {
                suggestionLines.push(line.slice(1));
            }
        }

        return suggestionLines.join('\n');
    }

    private async startValidationTask(
        patchedFiles: ASTValidateCodeRequest,
    ): Promise<{ taskId: string }> {
        return await this.astAnalysisService.startValidate({
            files: patchedFiles,
        });
    }

    private async awaitValidationTask(
        taskId: string,
        organizationAndTeamData: any,
    ): Promise<void> {
        const taskRes = await this.astAnalysisService.awaitTask(
            taskId,
            organizationAndTeamData,
        );

        if (
            !taskRes ||
            taskRes.task.status !== TaskStatus.TASK_STATUS_COMPLETED
        ) {
            throw new Error(
                StageMessageHelper.error(
                    PipelineReasons.SUGGESTIONS.VALIDATION_FAILED.message,
                    new Error('Task failed or timed out'),
                ),
            );
        }
    }

    private async getValidationResults(
        taskId: string,
        patchedFiles: ASTValidateCodeRequest,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
    ): Promise<{ id: string; isValid: boolean }[]> {
        const result = await this.astAnalysisService.getValidate(
            taskId,
            organizationAndTeamData,
        );

        if (!result) {
            this.logger.warn({
                message: 'No results returned from validation task',
                context: ValidateSuggestionsStage.name,
                metadata: { taskId, organizationAndTeamData, prNumber },
            });

            throw new Error(
                StageMessageHelper.error(
                    PipelineReasons.SUGGESTIONS.VALIDATION_FAILED.message,
                    new Error('No results returned from validation task'),
                ),
            );
        }

        const validAstSuggestions = result.results.filter((r) => r.isValid);

        const validationPromises = validAstSuggestions.map(async (r) => {
            if (!r.id) {
                this.logger.warn({
                    message: `Missing ID in validation result for file`,
                    context: ValidateSuggestionsStage.name,
                    metadata: {
                        taskId,
                        filePath: r.filePath,
                        organizationAndTeamData,
                        prNumber,
                    },
                });

                return null;
            }

            const originalFile = patchedFiles.files.find((f) => f.id === r.id);

            if (!originalFile) {
                this.logger.warn({
                    message: `Could not find original request for file`,
                    context: ValidateSuggestionsStage.name,
                    metadata: {
                        id: r.id,
                        filePath: r.filePath,
                        taskId,
                        organizationAndTeamData,
                        prNumber,
                    },
                });

                return null;
            }

            const originalCode = Buffer.from(
                originalFile.encodedData,
                'base64',
            ).toString('utf-8');

            if (!originalCode) {
                this.logger.warn({
                    message: `Original code is empty for file`,
                    context: ValidateSuggestionsStage.name,
                    metadata: {
                        id: r.id,
                        filePath: r.filePath,
                        taskId,
                        organizationAndTeamData,
                        prNumber,
                    },
                });

                return null;
            }

            const llmResult = await this.astAnalysisService.validateWithLLM(
                taskId,
                {
                    code: originalCode,
                    filePath: originalFile.filePath,
                    diff: originalFile.diff,
                    language: originalFile.language,
                },
                organizationAndTeamData,
                prNumber,
            );

            if (!llmResult) {
                this.logger.warn({
                    message: `LLM validation returned no result for file`,
                    context: ValidateSuggestionsStage.name,
                    metadata: {
                        id: r.id,
                        filePath: r.filePath,
                        taskId,
                        organizationAndTeamData,
                        prNumber,
                    },
                });

                return null;
            }

            return {
                id: r.id,
                isValid: llmResult.isValid,
            };
        });

        const resultsSettled = await Promise.allSettled(validationPromises);

        const resultsWithLLM = resultsSettled
            .map((outcome, index) => {
                if (outcome.status === 'fulfilled') {
                    return outcome.value;
                }

                const originalResult =
                    validAstSuggestions[index] || result.results[index];

                this.logger.error({
                    message: `Error during LLM validation for file`,
                    context: ValidateSuggestionsStage.name,
                    error: outcome.reason,
                    metadata: {
                        id: originalResult?.id,
                        filePath: originalResult?.filePath,
                        taskId,
                        organizationAndTeamData,
                        prNumber,
                    },
                });

                return null;
            })
            .filter((item): item is { id: string; isValid: boolean } => !!item);

        return resultsWithLLM;
    }
}
