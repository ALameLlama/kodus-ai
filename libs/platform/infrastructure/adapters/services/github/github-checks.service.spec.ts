import {
    CheckConclusion,
    CheckStatus,
} from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';
import { Test, TestingModule } from '@nestjs/testing';
import { GithubChecksService } from './github-checks.service';
import { GithubService } from './github.service';

describe('GithubChecksService', () => {
    let service: GithubChecksService;
    let mockGithubService: jest.Mocked<GithubService>;
    let mockOctokit: any;

    const mockOrganizationAndTeamData = {
        organizationId: 'org-1',
        installationId: 12345,
    } as any;

    const mockRepository = {
        owner: 'kodus-ai',
        name: 'kodus',
    } as any;

    beforeEach(async () => {
        mockOctokit = {
            checks: {
                create: jest.fn(),
                update: jest.fn(),
            },
        };

        mockGithubService = {
            getAuthenticatedOctokit: jest.fn().mockResolvedValue(mockOctokit),
        } as any;

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                GithubChecksService,
                {
                    provide: GithubService,
                    useValue: mockGithubService,
                },
            ],
        }).compile();

        service = module.get<GithubChecksService>(GithubChecksService);
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    describe('createCheckRun', () => {
        it('should create a check run with status IN_PROGRESS', async () => {
            const mockResponse = { data: { id: 100 } };
            mockOctokit.checks.create.mockResolvedValue(mockResponse);

            const result = await service.createCheckRun({
                organizationAndTeamData: mockOrganizationAndTeamData,
                repository: mockRepository,
                headSha: 'sha123',
                name: 'test-check',
                status: CheckStatus.IN_PROGRESS,
                output: { title: 'Test', summary: 'Summary' },
            });

            expect(
                mockGithubService.getAuthenticatedOctokit,
            ).toHaveBeenCalledWith(mockOrganizationAndTeamData);
            expect(mockOctokit.checks.create).toHaveBeenCalledWith({
                owner: 'kodus-ai',
                repo: 'kodus',
                name: 'test-check',
                head_sha: 'sha123',
                status: 'in_progress',
                started_at: expect.any(String),
                output: { title: 'Test', summary: 'Summary' },
            });
            expect(result).toBe(100);
        });

        it('should return null on error', async () => {
            mockOctokit.checks.create.mockRejectedValue(new Error('Failed'));

            const result = await service.createCheckRun({
                organizationAndTeamData: mockOrganizationAndTeamData,
                repository: mockRepository,
                headSha: 'sha123',
                name: 'test-check',
                status: CheckStatus.IN_PROGRESS,
            } as any);

            expect(result).toBeNull();
        });
    });

    describe('updateCheckRun', () => {
        it('should update a check run with status COMPLETED and conclusion SUCCESS', async () => {
            mockOctokit.checks.update.mockResolvedValue({});

            const result = await service.updateCheckRun({
                organizationAndTeamData: mockOrganizationAndTeamData,
                repository: mockRepository,
                checkRunId: 100,
                status: CheckStatus.COMPLETED,
                conclusion: CheckConclusion.SUCCESS,
            });

            expect(mockOctokit.checks.update).toHaveBeenCalledWith({
                owner: 'kodus-ai',
                repo: 'kodus',
                check_run_id: 100,
                status: 'completed',
                conclusion: 'success',
            });
            expect(result).toBe(true);
        });

        it('should handle string checkRunId', async () => {
            mockOctokit.checks.update.mockResolvedValue({});

            await service.updateCheckRun({
                organizationAndTeamData: mockOrganizationAndTeamData,
                repository: mockRepository,
                checkRunId: '100',
                status: CheckStatus.COMPLETED,
                conclusion: CheckConclusion.SUCCESS,
            });

            expect(mockOctokit.checks.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    check_run_id: 100,
                }),
            );
        });

        it('should return false on error', async () => {
            mockOctokit.checks.update.mockRejectedValue(new Error('Failed'));

            const result = await service.updateCheckRun({
                organizationAndTeamData: mockOrganizationAndTeamData,
                repository: mockRepository,
                checkRunId: 100,
                status: CheckStatus.COMPLETED,
            });

            expect(result).toBe(false);
        });
    });
});
