import { Test, TestingModule } from '@nestjs/testing';
import { FinalizeGithubCheckStage } from '@/code-review/pipeline/stages/finalize-github-check.stage';
import { GithubChecksService } from '@/platform/infrastructure/adapters/services/github/github-checks.service';
import { PlatformType } from '@/core/domain/enums';
import { DeliveryStatus } from '@/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { CommentResult } from '@/core/infrastructure/config/types/general/codeReview.type';
import { CodeReviewPipelineContext } from '@/code-review/pipeline/context/code-review-pipeline.context';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('FinalizeGithubCheckStage', () => {
    let stage: FinalizeGithubCheckStage;

    const mockGithubChecksService = {
        markSuccess: jest.fn(),
        markFailure: jest.fn(),
    };

    const baseContext: Partial<CodeReviewPipelineContext> = {
        platformType: PlatformType.GITHUB,
        githubCheckRunId: 12345,
        repository: {
            id: 'repo-1',
            name: 'repo',
            fullName: 'org/repo',
        } as any,
        organizationAndTeamData: {
            organizationId: 'org-123',
            teamId: 'team-456',
        } as any,
        pullRequest: { number: 42 } as any,
        pipelineError: false,
        statusInfo: {} as any,
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                FinalizeGithubCheckStage,
                {
                    provide: GithubChecksService,
                    useValue: mockGithubChecksService,
                },
            ],
        }).compile();

        stage = module.get<FinalizeGithubCheckStage>(FinalizeGithubCheckStage);
        jest.clearAllMocks();
    });

    function buildCommentResult(
        deliveryStatus: string,
        id = 'suggestion-1',
    ): CommentResult {
        return {
            comment: { suggestion: { id } } as any,
            deliveryStatus,
        };
    }

    describe('suggestion count accuracy', () => {
        it('should count only SENT line comments, ignoring FAILED ones', async () => {
            const context = {
                ...baseContext,
                lineComments: [
                    buildCommentResult(DeliveryStatus.SENT, 's1'),
                    buildCommentResult(DeliveryStatus.SENT, 's2'),
                    buildCommentResult(DeliveryStatus.FAILED, 's3'),
                    buildCommentResult(
                        DeliveryStatus.FAILED_LINES_MISMATCH,
                        's4',
                    ),
                ],
                prLevelCommentResults: [],
                validSuggestions: [
                    { id: 's1' },
                    { id: 's2' },
                    { id: 's3' },
                    { id: 's4' },
                    { id: 's5' },
                ],
            } as any;

            await (stage as any).executeStage(context);

            expect(mockGithubChecksService.markSuccess).toHaveBeenCalledWith(
                expect.objectContaining({
                    output: expect.objectContaining({
                        summary: expect.stringContaining('2 suggestion'),
                    }),
                }),
            );
        });

        it('should count only SENT PR-level comments', async () => {
            const context = {
                ...baseContext,
                lineComments: [],
                prLevelCommentResults: [
                    buildCommentResult(DeliveryStatus.SENT, 'pr1'),
                    buildCommentResult(DeliveryStatus.FAILED, 'pr2'),
                    buildCommentResult(DeliveryStatus.SENT, 'pr3'),
                ],
                validSuggestionsByPR: [
                    { id: 'pr1' },
                    { id: 'pr2' },
                    { id: 'pr3' },
                ],
            } as any;

            await (stage as any).executeStage(context);

            expect(mockGithubChecksService.markSuccess).toHaveBeenCalledWith(
                expect.objectContaining({
                    output: expect.objectContaining({
                        summary: expect.stringContaining('2 suggestion'),
                    }),
                }),
            );
        });

        it('should combine SENT line + PR-level comments for total count', async () => {
            const context = {
                ...baseContext,
                lineComments: [
                    buildCommentResult(DeliveryStatus.SENT, 's1'),
                    buildCommentResult(DeliveryStatus.SENT, 's2'),
                    buildCommentResult(DeliveryStatus.SENT, 's3'),
                ],
                prLevelCommentResults: [
                    buildCommentResult(DeliveryStatus.SENT, 'pr1'),
                    buildCommentResult(DeliveryStatus.SENT, 'pr2'),
                ],
            } as any;

            await (stage as any).executeStage(context);

            expect(mockGithubChecksService.markSuccess).toHaveBeenCalledWith(
                expect.objectContaining({
                    output: expect.objectContaining({
                        summary: expect.stringContaining('5 suggestion'),
                    }),
                }),
            );
        });

        it('should show 0 suggestions when no comments were actually sent', async () => {
            const context = {
                ...baseContext,
                lineComments: [
                    buildCommentResult(DeliveryStatus.FAILED, 's1'),
                    buildCommentResult(DeliveryStatus.FAILED, 's2'),
                ],
                prLevelCommentResults: [
                    buildCommentResult(DeliveryStatus.FAILED, 'pr1'),
                ],
                // Even though there are validSuggestions, none were actually posted
                validSuggestions: [{ id: 's1' }, { id: 's2' }],
                validSuggestionsByPR: [{ id: 'pr1' }],
                validCrossFileSuggestions: [{ id: 'cf1' }],
            } as any;

            await (stage as any).executeStage(context);

            expect(mockGithubChecksService.markSuccess).toHaveBeenCalledWith(
                expect.objectContaining({
                    output: expect.objectContaining({
                        summary: expect.stringContaining('No issues found'),
                    }),
                }),
            );
        });

        it('should NOT double-count cross-file suggestions that are already in lineComments', async () => {
            // Cross-file suggestions get merged into validSuggestions during
            // file processing and then posted as line comments.
            // The old code counted them in BOTH validSuggestions AND
            // validCrossFileSuggestions, inflating the total.
            // The fix counts only from actual comment results.
            const context = {
                ...baseContext,
                lineComments: [
                    // 2 regular + 1 cross-file = 3 line comments actually sent
                    buildCommentResult(DeliveryStatus.SENT, 's1'),
                    buildCommentResult(DeliveryStatus.SENT, 's2'),
                    buildCommentResult(DeliveryStatus.SENT, 'cf1'),
                ],
                prLevelCommentResults: [],
                // Old code would count these:
                validSuggestions: [
                    { id: 's1' },
                    { id: 's2' },
                    { id: 'cf1' },
                ], // 3
                validCrossFileSuggestions: [{ id: 'cf1' }], // 1 (double-counted!)
                // Old total: 3 + 0 + 1 = 4 (WRONG)
                // New total: 3 sent line comments (CORRECT)
            } as any;

            await (stage as any).executeStage(context);

            expect(mockGithubChecksService.markSuccess).toHaveBeenCalledWith(
                expect.objectContaining({
                    output: expect.objectContaining({
                        summary: expect.stringContaining('3 suggestion'),
                    }),
                }),
            );
            // Verify it does NOT say "4 suggestions" (the old double-counted value)
            const calledSummary =
                mockGithubChecksService.markSuccess.mock.calls[0][0].output
                    .summary;
            expect(calledSummary).not.toContain('4 suggestion');
        });

        it('should handle undefined lineComments and prLevelCommentResults', async () => {
            const context = {
                ...baseContext,
                lineComments: undefined,
                prLevelCommentResults: undefined,
            } as any;

            await (stage as any).executeStage(context);

            expect(mockGithubChecksService.markSuccess).toHaveBeenCalledWith(
                expect.objectContaining({
                    output: expect.objectContaining({
                        summary: expect.stringContaining('No issues found'),
                    }),
                }),
            );
        });

        it('should use singular "suggestion" for exactly 1 sent comment', async () => {
            const context = {
                ...baseContext,
                lineComments: [
                    buildCommentResult(DeliveryStatus.SENT, 's1'),
                ],
                prLevelCommentResults: [],
            } as any;

            await (stage as any).executeStage(context);

            expect(mockGithubChecksService.markSuccess).toHaveBeenCalledWith(
                expect.objectContaining({
                    output: expect.objectContaining({
                        summary: expect.stringContaining('1 suggestion.'),
                    }),
                }),
            );
            const calledSummary =
                mockGithubChecksService.markSuccess.mock.calls[0][0].output
                    .summary;
            expect(calledSummary).not.toContain('1 suggestions');
        });
    });
});
