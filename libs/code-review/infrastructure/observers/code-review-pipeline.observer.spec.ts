import { CodeReviewPipelineObserver } from './code-review-pipeline.observer';
import { IAutomationExecutionService } from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';

describe('CodeReviewPipelineObserver', () => {
    let observer: CodeReviewPipelineObserver;
    let mockService: jest.Mocked<IAutomationExecutionService>;

    beforeEach(() => {
        mockService = {
            updateCodeReview: jest.fn().mockResolvedValue({} as any),
        } as any;
        observer = new CodeReviewPipelineObserver(mockService);
    });

    it('should log stage start', async () => {
        const context: Partial<CodeReviewPipelineContext> = {
            pullRequest: { number: 123 } as any,
            repository: { id: 'repo-1' } as any,
            organizationAndTeamData: { organizationId: 'org-1' } as any,
        };

        await observer.onStageStart(
            'TestStage',
            context as CodeReviewPipelineContext,
        );

        expect(mockService.updateCodeReview).toHaveBeenCalledWith(
            expect.objectContaining({
                pullRequestNumber: 123,
                repositoryId: 'repo-1',
            }),
            expect.objectContaining({ status: AutomationStatus.IN_PROGRESS }),
            'Starting stage TestStage',
            'TestStage',
        );
    });

    it('should use execution UUID if present', async () => {
        const context: Partial<CodeReviewPipelineContext> = {
            pipelineMetadata: { lastExecution: { uuid: 'exec-uuid' } as any },
            organizationAndTeamData: { organizationId: 'org-1' } as any,
        };

        await observer.onStageStart(
            'TestStage',
            context as CodeReviewPipelineContext,
        );

        expect(mockService.updateCodeReview).toHaveBeenCalledWith(
            { uuid: 'exec-uuid' },
            expect.objectContaining({ status: AutomationStatus.IN_PROGRESS }),
            'Starting stage TestStage',
            'TestStage',
        );
    });

    it('should log stage finish', async () => {
        const context: Partial<CodeReviewPipelineContext> = {
            pipelineMetadata: { lastExecution: { uuid: 'exec-uuid' } as any },
            organizationAndTeamData: { organizationId: 'org-1' } as any,
        };

        await observer.onStageFinish(
            'TestStage',
            context as CodeReviewPipelineContext,
        );

        expect(mockService.updateCodeReview).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ status: AutomationStatus.IN_PROGRESS }), // Observer implementation keeps status as IN_PROGRESS for success to not complete the whole pipeline
            'Completed stage TestStage',
            'TestStage',
        );
    });

    it('should log stage error with ERROR status', async () => {
        const context: Partial<CodeReviewPipelineContext> = {
            pipelineMetadata: { lastExecution: { uuid: 'exec-uuid' } as any },
            organizationAndTeamData: { organizationId: 'org-1' } as any,
        };

        await observer.onStageError(
            'TestStage',
            new Error('Boom'),
            context as CodeReviewPipelineContext,
        );

        expect(mockService.updateCodeReview).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ status: AutomationStatus.ERROR }),
            'Error in stage TestStage: Boom',
            'TestStage',
        );
    });

    it('should log stage skipped', async () => {
        const context: Partial<CodeReviewPipelineContext> = {
            pipelineMetadata: { lastExecution: { uuid: 'exec-uuid' } as any },
            organizationAndTeamData: { organizationId: 'org-1' } as any,
        };

        await observer.onStageSkipped(
            'TestStage',
            'Some reason',
            context as CodeReviewPipelineContext,
        );

        expect(mockService.updateCodeReview).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ status: AutomationStatus.IN_PROGRESS }), // Skips shouldn't fail the pipeline
            'Stage TestStage skipped: Some reason',
            'TestStage',
        );
    });
});
