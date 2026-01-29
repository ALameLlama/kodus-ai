import { CodeReviewPipelineObserver } from './code-review-pipeline.observer';
import { IAutomationExecutionService } from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';

describe('CodeReviewPipelineObserver', () => {
    let observer: CodeReviewPipelineObserver;
    let mockService: jest.Mocked<IAutomationExecutionService>;
    let context: Partial<CodeReviewPipelineContext>;

    beforeEach(() => {
        const stageLogs = new Map<string, any>();

        mockService = {
            updateCodeReview: jest
                .fn()
                .mockImplementation(
                    async (filter, data, message, stageName) => {
                        const result = {
                            execution: { uuid: 'exec-uuid' },
                            stageLog: { uuid: 'stage-log-uuid' },
                        };
                        if (stageName) {
                            stageLogs.set(stageName, result.stageLog);
                        }
                        return result;
                    },
                ),
            updateStageLog: jest.fn().mockResolvedValue(undefined),
            findLatestExecutionByFilters: jest.fn(),
            findLatestStageLog: jest
                .fn()
                .mockImplementation(async (uuid, stageName) => {
                    return stageLogs.get(stageName);
                }),
        } as any;
        observer = new CodeReviewPipelineObserver(mockService);

        context = {
            pipelineMetadata: { lastExecution: { uuid: 'exec-1' } } as any,
            pullRequest: { number: 123 } as any,
            repository: { id: 'repo-1' } as any,
            organizationAndTeamData: { organizationId: 'org-1' } as any,
            correlationId: 'exec-1',
        };
    });

    it('should log stage start and store log ID in map', async () => {
        await observer.onStageStart(
            'TestStage',
            context as CodeReviewPipelineContext,
        );

        expect(mockService.updateCodeReview).toHaveBeenCalledWith(
            expect.objectContaining({
                uuid: 'exec-1',
            }),
            expect.objectContaining({ status: AutomationStatus.IN_PROGRESS }),
            'Starting stage TestStage',
            'TestStage',
            undefined,
        );
    });

    it('should update stage log on finish using ID from map', async () => {
        // First, start the stage to populate the map
        await observer.onStageStart(
            'TestStage',
            context as CodeReviewPipelineContext,
        );

        // Then finish the stage
        await observer.onStageFinish(
            'TestStage',
            context as CodeReviewPipelineContext,
        );

        expect(mockService.updateStageLog).toHaveBeenCalledWith(
            'stage-log-uuid',
            expect.objectContaining({
                status: AutomationStatus.SUCCESS,
                message: 'Completed stage TestStage',
                finishedAt: expect.any(Date),
            }),
        );
    });

    it('should fallback to creating new log on finish if log ID missing in map', async () => {
        // We do NOT call onStageStart, so the map is empty

        await observer.onStageFinish(
            'TestStage',
            context as CodeReviewPipelineContext,
        );

        expect(mockService.updateCodeReview).toHaveBeenCalledWith(
            expect.objectContaining({
                uuid: 'exec-1',
            }),
            expect.objectContaining({ status: AutomationStatus.SUCCESS }),
            'Completed stage TestStage',
            'TestStage',
            undefined,
        );
        expect(mockService.updateStageLog).not.toHaveBeenCalled();
    });

    it('should update stage log on error using ID from map', async () => {
        // Start to populate map
        await observer.onStageStart(
            'TestStage',
            context as CodeReviewPipelineContext,
        );

        await observer.onStageError(
            'TestStage',
            new Error('Boom'),
            context as CodeReviewPipelineContext,
        );

        expect(mockService.updateStageLog).toHaveBeenCalledWith(
            'stage-log-uuid',
            expect.objectContaining({
                status: AutomationStatus.ERROR,
                message: 'Error in stage TestStage: Boom',
                finishedAt: expect.any(Date),
            }),
        );
    });

    it('should update stage log on skipped using ID from map', async () => {
        // Start to populate map
        await observer.onStageStart(
            'TestStage',
            context as CodeReviewPipelineContext,
        );

        await observer.onStageSkipped(
            'TestStage',
            'Some reason',
            context as CodeReviewPipelineContext,
        );

        expect(mockService.updateStageLog).toHaveBeenCalledWith(
            'stage-log-uuid',
            expect.objectContaining({
                status: AutomationStatus.SKIPPED,
                message: 'Stage TestStage skipped: Some reason',
                finishedAt: expect.any(Date),
            }),
        );
    });

    it('should handle multiple stages sequentially', async () => {
        const stage1Mock = {
            execution: { uuid: 'exec-uuid' },
            stageLog: { uuid: 'stage-log-1' },
        };
        const stage2Mock = {
            execution: { uuid: 'exec-uuid' },
            stageLog: { uuid: 'stage-log-2' },
        };

        mockService.updateCodeReview
            .mockResolvedValueOnce(stage1Mock as any)
            .mockResolvedValueOnce(stage2Mock as any);

        mockService.findLatestStageLog
            .mockResolvedValueOnce(stage1Mock.stageLog as any)
            .mockResolvedValueOnce(stage2Mock.stageLog as any);

        // Stage 1 Start
        await observer.onStageStart(
            'Stage1',
            context as CodeReviewPipelineContext,
        );

        // Stage 1 Finish
        await observer.onStageFinish(
            'Stage1',
            context as CodeReviewPipelineContext,
        );

        expect(mockService.updateStageLog).toHaveBeenLastCalledWith(
            'stage-log-1',
            expect.objectContaining({ message: 'Completed stage Stage1' }),
        );

        // Stage 2 Start
        await observer.onStageStart(
            'Stage2',
            context as CodeReviewPipelineContext,
        );

        // Stage 2 Finish
        await observer.onStageFinish(
            'Stage2',
            context as CodeReviewPipelineContext,
        );

        expect(mockService.updateStageLog).toHaveBeenLastCalledWith(
            'stage-log-2',
            expect.objectContaining({ message: 'Completed stage Stage2' }),
        );
    });

    it('should attempt to recover execution UUID if missing on stage finish', async () => {
        context.pipelineMetadata!.lastExecution = undefined;
        context.correlationId = undefined as any;
        // Mock recovery success
        mockService.findLatestExecutionByFilters.mockResolvedValue({
            uuid: 'recovered-exec-uuid',
        } as any);

        // Mock stage log found
        mockService.findLatestStageLog.mockResolvedValue({
            uuid: 'recovered-stage-log-uuid',
        } as any);

        await observer.onStageFinish(
            'TestStage',
            context as CodeReviewPipelineContext,
        );

        // Verify recovery attempt
        expect(mockService.findLatestExecutionByFilters).toHaveBeenCalledWith({
            pullRequestNumber: 123,
            repositoryId: 'repo-1',
            status: AutomationStatus.IN_PROGRESS,
        });

        // Verify it used the recovered UUID to find the stage log
        expect(mockService.findLatestStageLog).toHaveBeenCalledWith(
            'recovered-exec-uuid',
            'TestStage',
        );

        // Verify it updated the stage log
        expect(mockService.updateStageLog).toHaveBeenCalledWith(
            'recovered-stage-log-uuid',
            expect.objectContaining({
                status: AutomationStatus.SUCCESS,
                message: 'Completed stage TestStage',
            }),
        );
    });

    it('should fallback to default behavior if recovery fails', async () => {
        context.pipelineMetadata!.lastExecution = undefined;
        context.correlationId = undefined as any;
        // Mock recovery failure
        mockService.findLatestExecutionByFilters.mockResolvedValue(null);

        await observer.onStageFinish(
            'TestStage',
            context as CodeReviewPipelineContext,
        );

        // Verify recovery attempt
        expect(mockService.findLatestExecutionByFilters).toHaveBeenCalled();

        // Verify it did NOT try to find stage log (since no UUID recovered)
        expect(mockService.findLatestStageLog).not.toHaveBeenCalled();

        // Verify fallback to updateCodeReview
        expect(mockService.updateCodeReview).toHaveBeenCalledWith(
            expect.objectContaining({
                pullRequestNumber: 123,
                repositoryId: 'repo-1',
            }),
            expect.objectContaining({ status: AutomationStatus.SUCCESS }),
            'Completed stage TestStage',
            'TestStage',
            undefined,
        );
    });

    it('should use correlationId as executionUuid if available', async () => {
        context.pipelineMetadata!.lastExecution = undefined;
        context.correlationId = 'correlation-uuid';

        await observer.onStageStart(
            'TestStage',
            context as CodeReviewPipelineContext,
        );

        expect(mockService.updateCodeReview).toHaveBeenCalledWith(
            expect.objectContaining({
                uuid: 'correlation-uuid',
            }),
            expect.objectContaining({ status: AutomationStatus.IN_PROGRESS }),
            'Starting stage TestStage',
            'TestStage',
            undefined,
        );
    });

    it('should log stage as PARTIAL_ERROR if context has errors for the stage', async () => {
        // Setup context with errors
        context.errors = [
            {
                stage: 'TestStage',
                error: new Error('Partial error'),
            } as any,
        ];

        // Start stage to populate map
        await observer.onStageStart(
            'TestStage',
            context as CodeReviewPipelineContext,
        );

        // Finish stage
        await observer.onStageFinish(
            'TestStage',
            context as CodeReviewPipelineContext,
        );

        expect(mockService.updateStageLog).toHaveBeenCalledWith(
            'stage-log-uuid',
            expect.objectContaining({
                status: AutomationStatus.PARTIAL_ERROR,
                message: 'Completed stage TestStage',
                finishedAt: expect.any(Date),
                metadata: expect.objectContaining({
                    partialErrors: expect.arrayContaining([
                        expect.objectContaining({
                            message: 'Partial error',
                        }),
                    ]),
                }),
            }),
        );
    });

    it('should include visibility in metadata on stage finish', async () => {
        await observer.onStageStart(
            'TestStage',
            context as CodeReviewPipelineContext,
        );

        await observer.onStageFinish(
            'TestStage',
            context as CodeReviewPipelineContext,
            { visibility: StageVisibility.PRIMARY },
        );

        expect(mockService.updateStageLog).toHaveBeenCalledWith(
            'stage-log-uuid',
            expect.objectContaining({
                metadata: expect.objectContaining({
                    visibility: StageVisibility.PRIMARY,
                }),
            }),
        );
    });

    it('should include visibility in metadata on stage error', async () => {
        await observer.onStageStart(
            'TestStage',
            context as CodeReviewPipelineContext,
        );

        await observer.onStageError(
            'TestStage',
            new Error('Boom'),
            context as CodeReviewPipelineContext,
            { visibility: StageVisibility.INTERNAL },
        );

        expect(mockService.updateStageLog).toHaveBeenCalledWith(
            'stage-log-uuid',
            expect.objectContaining({
                metadata: expect.objectContaining({
                    visibility: StageVisibility.INTERNAL,
                }),
            }),
        );
    });

    it('should include visibility in metadata on stage skipped', async () => {
        await observer.onStageStart(
            'TestStage',
            context as CodeReviewPipelineContext,
        );

        await observer.onStageSkipped(
            'TestStage',
            'Reason',
            context as CodeReviewPipelineContext,
            { visibility: StageVisibility.PRIMARY },
        );

        expect(mockService.updateStageLog).toHaveBeenCalledWith(
            'stage-log-uuid',
            expect.objectContaining({
                metadata: expect.objectContaining({
                    visibility: StageVisibility.PRIMARY,
                }),
            }),
        );
    });

    it('should include ignoredFiles in metadata on stage finish if present in context', async () => {
        context.ignoredFiles = Array.from(
            { length: 60 },
            (_, i) => `file-${i}.ts`,
        );

        await observer.onStageStart(
            'FetchChangedFilesStage',
            context as CodeReviewPipelineContext,
        );

        await observer.onStageFinish(
            'FetchChangedFilesStage',
            context as CodeReviewPipelineContext,
        );

        expect(mockService.updateStageLog).toHaveBeenCalledWith(
            'stage-log-uuid',
            expect.objectContaining({
                metadata: expect.objectContaining({
                    ignoredFiles: expect.arrayContaining([
                        'file-0.ts',
                        'file-49.ts',
                    ]),
                }),
            }),
        );

        // Verify truncation
        const callArgs = mockService.updateStageLog.mock.calls[0];
        const metadata = callArgs[1].metadata;
        expect(metadata.ignoredFiles).toHaveLength(50);
        expect(metadata.ignoredFiles).not.toContain('file-50.ts');
    });

    it('should include ignoredFiles in metadata on stage skipped if present in context', async () => {
        context.ignoredFiles = ['ignored-file.ts'];

        await observer.onStageStart(
            'FetchChangedFilesStage',
            context as CodeReviewPipelineContext,
        );

        await observer.onStageSkipped(
            'FetchChangedFilesStage',
            'All files ignored',
            context as CodeReviewPipelineContext,
        );

        expect(mockService.updateStageLog).toHaveBeenCalledWith(
            'stage-log-uuid',
            expect.objectContaining({
                status: AutomationStatus.SKIPPED,
                metadata: expect.objectContaining({
                    ignoredFiles: ['ignored-file.ts'],
                }),
            }),
        );
    });
});
