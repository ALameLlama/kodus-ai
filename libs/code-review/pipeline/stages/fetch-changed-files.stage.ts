import { Inject, Injectable } from '@nestjs/common';

import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import {
    IPullRequestManagerService,
    PULL_REQUEST_MANAGER_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/PullRequestManagerService.contract';
import { createLogger } from '@kodus/flow';
import {
    AutomationMessage,
    AutomationStatus,
} from '@libs/automation/domain/automation/enum/automation-status';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    convertToHunksWithLinesNumbers,
    handlePatchDeletions,
} from '@libs/common/utils/patch';
import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

@Injectable()
export class FetchChangedFilesStage extends BasePipelineStage<CodeReviewPipelineContext> {
    stageName = 'FetchChangedFilesStage';

    private readonly logger = createLogger(FetchChangedFilesStage.name);
    private maxFilesToAnalyze = 500;

    constructor(
        @Inject(PULL_REQUEST_MANAGER_SERVICE_TOKEN)
        private pullRequestHandlerService: IPullRequestManagerService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        if (!context.codeReviewConfig) {
            this.logger.error({
                message: 'No config found in context',
                context: this.stageName,
                metadata: {
                    prNumber: context?.pullRequest?.number,
                    repositoryName: context?.repository?.name,
                },
            });

            return this.updateContext(context, (draft) => {
                draft.statusInfo = {
                    status: AutomationStatus.SKIPPED,
                    message: AutomationMessage.NO_CONFIG_IN_CONTEXT,
                    jumpToStage: 'FinalizeGithubCheckStage',
                };
            });
        }

        // Reutilizar arquivos do ResolveConfigStage se disponíveis, caso contrário buscar
        let filesToProcess = context.preliminaryFiles;

        if (!filesToProcess || filesToProcess.length === 0) {
            this.logger.log({
                message: `No preliminary files in context, fetching from API for PR#${context.pullRequest.number}`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    repository: context.repository.name,
                },
            });

            filesToProcess =
                await this.pullRequestHandlerService.getChangedFilesMetadata(
                    context.organizationAndTeamData,
                    context.repository,
                    context.pullRequest,
                    context?.lastExecution?.lastAnalyzedCommit,
                );
        }

        // Aplicar filtro ignorePaths
        const ignorePaths = context.codeReviewConfig.ignorePaths || [];
        const filteredFiles = filesToProcess?.filter(
            (file) => !isFileMatchingGlob(file.filename, ignorePaths),
        );

        if (
            !filteredFiles?.length ||
            filteredFiles.length > this.maxFilesToAnalyze
        ) {
            const msg = !filteredFiles?.length
                ? AutomationMessage.NO_FILES_AFTER_IGNORE
                : AutomationMessage.TOO_MANY_FILES;

            this.logger.warn({
                message: `Skipping code review for PR#${context.pullRequest.number} - ${msg}`,
                context: FetchChangedFilesStage.name,
                metadata: {
                    organizationAndTeamData: context?.organizationAndTeamData,
                    filesCount: filteredFiles?.length || 0,
                    totalFilesBeforeFilter: filesToProcess?.length || 0,
                    ignorePaths,
                },
            });
            return this.updateContext(context, (draft) => {
                draft.statusInfo = {
                    status: AutomationStatus.SKIPPED,
                    message: msg,
                    jumpToStage: 'FinalizeGithubCheckStage',
                };
            });
        }

        this.logger.log({
            message: `Found ${filteredFiles.length} files to analyze for PR#${context.pullRequest.number} (${filesToProcess?.length || 0} total, ${(filesToProcess?.length || 0) - filteredFiles.length} ignored)`,
            context: this.stageName,
            metadata: {
                organizationAndTeamData: context.organizationAndTeamData,
                repository: context.repository.name,
                pullRequestNumber: context.pullRequest.number,
                filesCount: filteredFiles.length,
                totalFilesBeforeFilter: filesToProcess?.length || 0,
                ignoredFilesCount:
                    (filesToProcess?.length || 0) - filteredFiles.length,
            },
        });

        // Buscar conteúdo apenas dos arquivos filtrados (não ignorados)
        const filesWithContent =
            await this.pullRequestHandlerService.enrichFilesWithContent(
                context.organizationAndTeamData,
                context.repository,
                context.pullRequest,
                filteredFiles,
            );

        const filesWithLineNumbers =
            this.prepareFilesWithLineNumbers(filesWithContent);

        const stats = this.getStatsForPR(filesWithLineNumbers);

        return this.updateContext(context, (draft) => {
            draft.changedFiles = filesWithLineNumbers;
            draft.pipelineMetadata = {
                ...draft.pipelineMetadata,
            };
            draft.pullRequest.stats = stats;
        });
    }

    private prepareFilesWithLineNumbers(files: FileChange[]): FileChange[] {
        if (!files?.length || files?.length === 0) {
            return [];
        }

        return files?.map((file) => {
            try {
                if (!file?.patch) {
                    return file;
                }

                const patchFormatted = handlePatchDeletions(
                    file.patch,
                    file.filename,
                    file.status,
                );

                if (!patchFormatted) {
                    return file;
                }

                const patchWithLinesStr = convertToHunksWithLinesNumbers(
                    patchFormatted,
                    file,
                );

                return {
                    ...file,
                    patchWithLinesStr,
                };
            } catch (error) {
                this.logger.error({
                    message: `Error preparing line numbers for file "${file?.filename}"`,
                    error,
                    context: FetchChangedFilesStage.name,
                    metadata: {
                        filename: file?.filename,
                    },
                });
                return file;
            }
        });
    }

    private getStatsForPR(
        files: FileChange[],
    ): CodeReviewPipelineContext['pullRequest']['stats'] {
        let totalAdditions = 0;
        let totalDeletions = 0;

        files.forEach((file) => {
            totalAdditions += file.additions || 0;
            totalDeletions += file.deletions || 0;
        });

        return {
            total_additions: totalAdditions,
            total_deletions: totalDeletions,
            total_files: files.length,
            total_lines_changed: totalAdditions + totalDeletions,
        };
    }
}
