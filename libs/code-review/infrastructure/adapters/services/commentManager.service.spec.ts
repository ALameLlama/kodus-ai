import { Test, TestingModule } from '@nestjs/testing';
import { CommentManagerService } from './commentManager.service';
import { PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { MessageTemplateProcessor } from './messageTemplateProcessor.service';
import { PromptRunnerService } from '@kodus/kodus-common/llm';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { Comment } from '@libs/core/infrastructure/config/types/general/codeReview.type';

describe('CommentManagerService - createLineComments retry logic', () => {
    let service: CommentManagerService;
    let mockCodeManagementService: any;

    const mockOrganizationAndTeamData = {
        organizationId: 'org-123',
        teamId: 'team-456',
    };

    const mockRepository = {
        id: 'repo-1',
        name: 'test-repo',
        language: 'TypeScript',
    };

    const mockCommit = {
        sha: 'abc123',
    };

    const createMockComment = (overrides?: Partial<Comment>): Comment => ({
        path: 'src/test.ts',
        body: 'Test comment body',
        line: 20,
        start_line: 15,
        side: 'RIGHT',
        start_side: 'RIGHT',
        suggestion: {
            id: 'suggestion-1',
            relevantFile: 'src/test.ts',
            suggestionContent: 'Test suggestion',
            existingCode: 'old code',
            improvedCode: 'new code',
            oneSentenceSummary: 'Test summary',
            relevantLinesStart: 15,
            relevantLinesEnd: 20,
            label: 'improvement',
            severity: 'medium',
        } as any,
        ...overrides,
    });

    beforeEach(async () => {
        mockCodeManagementService = {
            getCommitsForPullRequestForCodeReview: jest.fn().mockResolvedValue([mockCommit]),
            createReviewComment: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CommentManagerService,
                {
                    provide: PARAMETERS_SERVICE_TOKEN,
                    useValue: {},
                },
                {
                    provide: MessageTemplateProcessor,
                    useValue: {},
                },
                {
                    provide: PromptRunnerService,
                    useValue: {},
                },
                {
                    provide: ObservabilityService,
                    useValue: {},
                },
                {
                    provide: PermissionValidationService,
                    useValue: {},
                },
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagementService,
                },
            ],
        }).compile();

        service = module.get<CommentManagerService>(CommentManagerService);
    });

    describe('Test 1: Comment succeeds on first attempt', () => {
        it('should create comment successfully on first try', async () => {
            const mockComment = createMockComment();
            const mockCreatedComment = {
                id: 123,
                pullRequestReviewId: '456',
                body: 'Created comment',
            };

            mockCodeManagementService.createReviewComment.mockResolvedValue(mockCreatedComment);

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
            );

            expect(result.commentResults).toHaveLength(1);
            expect(result.commentResults[0].deliveryStatus).toBe(DeliveryStatus.SENT);
            expect(result.commentResults[0].codeReviewFeedbackData?.commentId).toBe(123);
            expect(mockCodeManagementService.createReviewComment).toHaveBeenCalledTimes(1);
        });
    });

    describe('Test 2: Line mismatch on attempt 1, succeeds on attempt 2 (start_line = line)', () => {
        it('should retry with start_line = line when first attempt fails with line mismatch', async () => {
            const mockComment = createMockComment({
                start_line: 15,
                line: 20,
            });
            const mockCreatedComment = {
                id: 123,
                pullRequestReviewId: '456',
            };

            const lineMismatchError = {
                errorType: 'failed_lines_mismatch',
                message: 'line must be part of the diff',
            };

            mockCodeManagementService.createReviewComment
                .mockRejectedValueOnce(lineMismatchError)
                .mockResolvedValueOnce(mockCreatedComment);

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
            );

            expect(result.commentResults).toHaveLength(1);
            expect(result.commentResults[0].deliveryStatus).toBe(DeliveryStatus.SENT);
            expect(mockCodeManagementService.createReviewComment).toHaveBeenCalledTimes(2);

            // Verify second call has start_line = line (both equal to 20)
            const secondCall = mockCodeManagementService.createReviewComment.mock.calls[1][0];
            expect(secondCall.lineComment.start_line).toBe(20);
            expect(secondCall.lineComment.line).toBe(20);
        });
    });

    describe('Test 3: Line mismatch on attempts 1 and 2, succeeds on attempt 3 (line = start_line)', () => {
        it('should retry with line = start_line when first two attempts fail with line mismatch', async () => {
            const mockComment = createMockComment({
                start_line: 15,
                line: 20,
            });
            const mockCreatedComment = {
                id: 123,
                pullRequestReviewId: '456',
            };

            const lineMismatchError = {
                errorType: 'failed_lines_mismatch',
                message: 'line must be part of the diff',
            };

            mockCodeManagementService.createReviewComment
                .mockRejectedValueOnce(lineMismatchError) // Attempt 1 fails
                .mockRejectedValueOnce(lineMismatchError) // Attempt 2 fails
                .mockResolvedValueOnce(mockCreatedComment); // Attempt 3 succeeds

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
            );

            expect(result.commentResults).toHaveLength(1);
            expect(result.commentResults[0].deliveryStatus).toBe(DeliveryStatus.SENT);
            expect(mockCodeManagementService.createReviewComment).toHaveBeenCalledTimes(3);

            // Verify third call has line = start_line (both equal to 15)
            const thirdCall = mockCodeManagementService.createReviewComment.mock.calls[2][0];
            expect(thirdCall.lineComment.start_line).toBe(15);
            expect(thirdCall.lineComment.line).toBe(15);
        });
    });

    describe('Test 4: All 3 attempts fail with line mismatch', () => {
        it('should propagate error when all line mismatch retries fail', async () => {
            const mockComment = createMockComment({
                start_line: 15,
                line: 20,
            });

            const lineMismatchError = {
                errorType: 'failed_lines_mismatch',
                message: 'line must be part of the diff',
            };

            mockCodeManagementService.createReviewComment
                .mockRejectedValueOnce(lineMismatchError) // Attempt 1 fails
                .mockRejectedValueOnce(lineMismatchError) // Attempt 2 fails
                .mockRejectedValueOnce(lineMismatchError); // Attempt 3 fails

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
            );

            expect(result.commentResults).toHaveLength(1);
            expect(result.commentResults[0].deliveryStatus).toBe('failed_lines_mismatch');
            expect(mockCodeManagementService.createReviewComment).toHaveBeenCalledTimes(3);
        });
    });

    describe('Test 5: Transient error (500), retry after 500ms succeeds', () => {
        it('should retry after 500ms delay when 500 error occurs', async () => {
            const mockComment = createMockComment();
            const mockCreatedComment = {
                id: 123,
                pullRequestReviewId: '456',
            };

            const transientError = {
                status: 500,
                message: 'Internal Server Error',
            };

            mockCodeManagementService.createReviewComment
                .mockRejectedValueOnce(transientError)
                .mockResolvedValueOnce(mockCreatedComment);

            const startTime = Date.now();

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
            );

            const elapsedTime = Date.now() - startTime;

            expect(result.commentResults).toHaveLength(1);
            expect(result.commentResults[0].deliveryStatus).toBe(DeliveryStatus.SENT);
            expect(mockCodeManagementService.createReviewComment).toHaveBeenCalledTimes(2);

            // Verify delay was respected (at least 450ms to account for execution time variance)
            expect(elapsedTime).toBeGreaterThanOrEqual(450);
        });
    });

    describe('Test 6: Network error (ECONNRESET), retry succeeds', () => {
        it('should retry when network error occurs', async () => {
            const mockComment = createMockComment();
            const mockCreatedComment = {
                id: 123,
                pullRequestReviewId: '456',
            };

            const networkError = {
                code: 'ECONNRESET',
                message: 'Connection reset',
            };

            mockCodeManagementService.createReviewComment
                .mockRejectedValueOnce(networkError)
                .mockResolvedValueOnce(mockCreatedComment);

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
            );

            expect(result.commentResults).toHaveLength(1);
            expect(result.commentResults[0].deliveryStatus).toBe(DeliveryStatus.SENT);
            expect(mockCodeManagementService.createReviewComment).toHaveBeenCalledTimes(2);
        });
    });

    describe('Test 7: Definitive error (401/403/404), no retry', () => {
        it('should not retry on 401 Unauthorized error', async () => {
            const mockComment = createMockComment();

            const authError = {
                status: 401,
                message: 'Unauthorized',
            };

            mockCodeManagementService.createReviewComment.mockRejectedValueOnce(authError);

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
            );

            expect(result.commentResults).toHaveLength(1);
            expect(result.commentResults[0].deliveryStatus).toBe(DeliveryStatus.FAILED);
            expect(mockCodeManagementService.createReviewComment).toHaveBeenCalledTimes(1);
        });

        it('should not retry on 403 Forbidden error', async () => {
            const mockComment = createMockComment();

            const forbiddenError = {
                status: 403,
                message: 'Forbidden',
            };

            mockCodeManagementService.createReviewComment.mockRejectedValueOnce(forbiddenError);

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
            );

            expect(result.commentResults).toHaveLength(1);
            expect(result.commentResults[0].deliveryStatus).toBe(DeliveryStatus.FAILED);
            expect(mockCodeManagementService.createReviewComment).toHaveBeenCalledTimes(1);
        });

        it('should not retry on 404 Not Found error', async () => {
            const mockComment = createMockComment();

            const notFoundError = {
                status: 404,
                message: 'Not Found',
            };

            mockCodeManagementService.createReviewComment.mockRejectedValueOnce(notFoundError);

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
            );

            expect(result.commentResults).toHaveLength(1);
            expect(result.commentResults[0].deliveryStatus).toBe(DeliveryStatus.FAILED);
            expect(mockCodeManagementService.createReviewComment).toHaveBeenCalledTimes(1);
        });
    });
});
