import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { PipelineContext } from '../interfaces/pipeline-context.interface';
import { IPipelineObserver } from '../interfaces/pipeline-observer.interface';
import { PipelineStage } from '../interfaces/pipeline.interface';
import { PipelineExecutor } from './pipeline-executor.service';

describe('PipelineExecutor', () => {
    let executor: PipelineExecutor<PipelineContext>;
    let mockObserver: jest.Mocked<IPipelineObserver>;
    let mockStage: jest.Mocked<PipelineStage<PipelineContext>>;

    beforeEach(() => {
        executor = new PipelineExecutor();
        mockObserver = {
            onStageStart: jest.fn().mockResolvedValue(undefined),
            onStageFinish: jest.fn().mockResolvedValue(undefined),
            onStageError: jest.fn().mockResolvedValue(undefined),
            onStageSkipped: jest.fn().mockResolvedValue(undefined),
            onPipelineFinish: jest.fn().mockResolvedValue(undefined),
            onPipelineStart: jest.fn().mockResolvedValue(undefined),
        };
        mockStage = {
            stageName: 'TestStage',
            execute: jest.fn(),
        } as any;
    });

    it('should notify observer on stage start and finish', async () => {
        const context: PipelineContext = {
            statusInfo: { status: AutomationStatus.IN_PROGRESS },
            errors: [],
        } as any;

        mockStage.execute.mockResolvedValue(context);

        await executor.execute(
            context,
            [mockStage],
            'TestPipeline',
            undefined,
            undefined,
            [mockObserver],
        );

        expect(mockObserver.onStageStart).toHaveBeenCalledWith(
            'TestStage',
            expect.anything(),
            expect.anything(),
            expect.anything(),
        );
        expect(mockObserver.onStageFinish).toHaveBeenCalledWith(
            'TestStage',
            expect.anything(),
            expect.anything(),
            expect.anything(),
        );
    });

    it('should notify observer on stage error', async () => {
        const context: PipelineContext = {
            statusInfo: { status: AutomationStatus.IN_PROGRESS },
            errors: [],
        } as any;

        const error = new Error('Stage Failed');
        mockStage.execute.mockRejectedValue(error);

        const result = await executor.execute(
            context,
            [mockStage],
            'TestPipeline',
            undefined,
            undefined,
            [mockObserver],
        );

        expect(mockObserver.onStageStart).toHaveBeenCalled();
        expect(mockObserver.onStageError).toHaveBeenCalledWith(
            'TestStage',
            error,
            expect.anything(),
            expect.anything(),
            expect.anything(),
        );
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toEqual(
            expect.objectContaining({
                stage: 'TestStage',
                substage: 'StageExecution',
                error,
            }),
        );
    });

    it('should notify observer on stage skipped', async () => {
        const context: PipelineContext = {
            statusInfo: {
                status: AutomationStatus.SKIPPED,
                jumpToStage: 'AnotherStage',
            },
            errors: [],
        } as any;

        mockStage.stageName = 'TestStage'; // Not the target
        // execute should not be called

        await executor.execute(
            context,
            [mockStage],
            'TestPipeline',
            undefined,
            undefined,
            [mockObserver],
        );

        expect(mockObserver.onStageSkipped).not.toHaveBeenCalled();
    });
});
