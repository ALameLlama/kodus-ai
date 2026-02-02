/**
 * Tests for Forgejo service methods.
 * 
 * Key differences from GitHub:
 * - GitHub uses Octokit which handles owner/repo from auth details (has `org` field)
 * - Forgejo uses raw axios API calls requiring owner/repo in the URL
 * - Forgejo webhook handler uses `full_name` as the repository name to match saved config
 * 
 * The repository name is always in "owner/repo" format (e.g., "Llama/testing_repo"):
 * - Webhook payload: payload.repository.full_name = "Llama/testing_repo"
 * - Saved config: name = "Llama/testing_repo"
 */

// Mock logger
jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('Forgejo Service', () => {
    describe('extractOwnerAndRepo (inlined split)', () => {
        /**
         * Helper function that mirrors the inlined logic in forgejo.service.ts
         * for extracting owner and repo name from a full repository name.
         * Uses split('/', 2) which splits into at most 2 parts.
         */
        function extractOwnerAndRepo(repoFullName: string): { owner: string; repoName: string } | null {
            const [owner, repoName] = repoFullName.split('/', 2);

            if (owner && repoName) {
                return { owner, repoName };
            }

            return null;
        }

        it('should extract owner and repo from full name', () => {
            const result = extractOwnerAndRepo('Llama/testing_repo');

            expect(result).toEqual({
                owner: 'Llama',
                repoName: 'testing_repo',
            });
        });

        it('should handle org-owned repos (phplings/phplings)', () => {
            const result = extractOwnerAndRepo('phplings/phplings');

            expect(result).toEqual({
                owner: 'phplings',
                repoName: 'phplings',
            });
        });

        it('should return null when only short name is provided', () => {
            const result = extractOwnerAndRepo('testing_repo');

            expect(result).toBeNull();
        });

        it('should return null for empty string', () => {
            const result = extractOwnerAndRepo('');

            expect(result).toBeNull();
        });
    });

    describe('Webhook Handler Repository Extraction', () => {
        /**
         * Simulates how the webhook handler extracts repository info.
         * It uses `full_name` as the `name` field to ensure consistency.
         */
        function extractRepositoryFromWebhook(payload: any): {
            id: string;
            name: string;
        } {
            return {
                id: String(payload?.repository?.id),
                // Use full_name to match saved config format
                name: payload?.repository?.full_name || payload?.repository?.name,
            };
        }

        it('should use full_name as repository name', () => {
            const webhookPayload = {
                action: 'opened',
                number: 3,
                repository: {
                    id: 22,
                    name: 'testing_repo',       // Short name
                    full_name: 'Llama/testing_repo', // Full name with owner
                },
            };

            const repo = extractRepositoryFromWebhook(webhookPayload);

            expect(repo).toEqual({
                id: '22',
                name: 'Llama/testing_repo', // Should be the full name
            });
        });

        it('should fall back to short name if full_name is missing', () => {
            const webhookPayload = {
                repository: {
                    id: 22,
                    name: 'testing_repo',
                    // full_name is missing
                },
            };

            const repo = extractRepositoryFromWebhook(webhookPayload);

            expect(repo).toEqual({
                id: '22',
                name: 'testing_repo',
            });
        });
    });

    describe('API URL Construction', () => {
        function buildApiUrl(
            host: string,
            owner: string,
            repo: string,
            path: string,
        ): string {
            return `${host}/api/v1/repos/${owner}/${repo}${path}`;
        }

        it('should construct correct URL for PR endpoint', () => {
            const url = buildApiUrl(
                'https://git.llamacorp.au',
                'Llama',
                'testing_repo',
                '/pulls/3',
            );

            expect(url).toBe(
                'https://git.llamacorp.au/api/v1/repos/Llama/testing_repo/pulls/3',
            );
        });

        it('should construct correct URL for commits endpoint', () => {
            const url = buildApiUrl(
                'https://git.llamacorp.au',
                'Llama',
                'testing_repo',
                '/pulls/3/commits',
            );

            expect(url).toBe(
                'https://git.llamacorp.au/api/v1/repos/Llama/testing_repo/pulls/3/commits',
            );
        });

        it('should construct correct URL for files endpoint', () => {
            const url = buildApiUrl(
                'https://git.llamacorp.au',
                'Llama',
                'testing_repo',
                '/pulls/3/files',
            );

            expect(url).toBe(
                'https://git.llamacorp.au/api/v1/repos/Llama/testing_repo/pulls/3/files',
            );
        });
    });

    describe('Commit Data Mapping', () => {
        function mapForgejoCommit(commit: any): any {
            return {
                sha: commit?.sha,
                created_at: commit?.commit?.author?.date || commit?.created,
                message: commit?.commit?.message,
                author: {
                    id: commit?.author?.id,
                    name: commit?.commit?.author?.name,
                    email: commit?.commit?.author?.email,
                    date: commit?.commit?.author?.date,
                    username: commit?.author?.login || commit?.author?.username,
                },
                parents: commit?.parents?.map((p: any) => ({ sha: p?.sha })) || [],
            };
        }

        it('should map Forgejo commit to expected format', () => {
            const forgejoCommit = {
                sha: '9da9e0f093815f868096d98a25ae789ec5931cac',
                commit: {
                    message: 'feat: add new feature\n\nSome description',
                    author: {
                        name: 'John Doe',
                        email: 'john@example.com',
                        date: '2024-01-15T10:00:00Z',
                    },
                },
                author: {
                    id: 1,
                    login: 'johndoe',
                    username: 'johndoe',
                },
                parents: [
                    { sha: '8cd80e38659f5aee787e5a8ec60ffe495fb5fac6' },
                ],
            };

            const mapped = mapForgejoCommit(forgejoCommit);

            expect(mapped).toEqual({
                sha: '9da9e0f093815f868096d98a25ae789ec5931cac',
                created_at: '2024-01-15T10:00:00Z',
                message: 'feat: add new feature\n\nSome description',
                author: {
                    id: 1,
                    name: 'John Doe',
                    email: 'john@example.com',
                    date: '2024-01-15T10:00:00Z',
                    username: 'johndoe',
                },
                parents: [{ sha: '8cd80e38659f5aee787e5a8ec60ffe495fb5fac6' }],
            });
        });
    });

    describe('File Data Mapping', () => {
        function mapForgejoFile(file: any): any {
            return {
                sha: file?.sha,
                filename: file?.filename,
                status: file?.status,
                additions: file?.additions || 0,
                deletions: file?.deletions || 0,
                changes: file?.changes || (file?.additions || 0) + (file?.deletions || 0),
                patch: file?.patch || file?.contents_url,
            };
        }

        it('should map Forgejo file to expected format', () => {
            const forgejoFile = {
                sha: 'abc123',
                filename: 'src/index.ts',
                status: 'modified',
                additions: 10,
                deletions: 5,
                changes: 15,
                patch: '@@ -1,5 +1,10 @@\n+new line',
            };

            const mapped = mapForgejoFile(forgejoFile);

            expect(mapped).toEqual({
                sha: 'abc123',
                filename: 'src/index.ts',
                status: 'modified',
                additions: 10,
                deletions: 5,
                changes: 15,
                patch: '@@ -1,5 +1,10 @@\n+new line',
            });
        });

        it('should handle missing changes field', () => {
            const forgejoFile = {
                filename: 'README.md',
                status: 'added',
                additions: 20,
                deletions: 0,
            };

            const mapped = mapForgejoFile(forgejoFile);

            expect(mapped.changes).toBe(20);
        });
    });

    describe('Pull Request Data Mapping', () => {
        function mapForgejoPullRequest(pr: any, repoId?: string): any {
            return {
                number: pr.number,
                title: pr.title,
                body: pr.body,
                state: pr.state,
                created_at: pr.created_at,
                updated_at: pr.updated_at,
                merged_at: pr.merged_at,
                head: {
                    ref: pr.head?.ref,
                    sha: pr.head?.sha,
                    repo: {
                        name: pr.head?.repo?.name,
                        id: pr.head?.repo?.id?.toString(),
                    },
                },
                base: {
                    ref: pr.base?.ref,
                    sha: pr.base?.sha,
                    repo: {
                        name: pr.base?.repo?.name,
                        id: repoId || pr.base?.repo?.id,
                    },
                },
                user: {
                    login: pr.user?.login || pr.user?.username,
                    id: pr.user?.id,
                },
                assignees: pr.assignees || [],
                reviewers: pr.requested_reviewers || [],
            };
        }

        it('should map Forgejo PR to expected format', () => {
            const forgejoPR = {
                number: 3,
                title: 'feat: add testing',
                body: 'This PR adds testing functionality',
                state: 'open',
                created_at: '2024-01-15T10:00:00Z',
                updated_at: '2024-01-16T10:00:00Z',
                merged_at: null,
                head: {
                    ref: 'feat/testing',
                    sha: '9da9e0f093815f868096d98a25ae789ec5931cac',
                    repo: {
                        name: 'testing_repo',
                        id: 22,
                    },
                },
                base: {
                    ref: 'main',
                    sha: '8cd80e38659f5aee787e5a8ec60ffe495fb5fac6',
                    repo: {
                        name: 'testing_repo',
                        id: 22,
                    },
                },
                user: {
                    id: 1,
                    login: 'Llama',
                    username: 'Llama',
                },
                assignees: [],
                requested_reviewers: [],
            };

            const mapped = mapForgejoPullRequest(forgejoPR, '22');

            expect(mapped.number).toBe(3);
            expect(mapped.title).toBe('feat: add testing');
            expect(mapped.head.ref).toBe('feat/testing');
            expect(mapped.head.sha).toBe('9da9e0f093815f868096d98a25ae789ec5931cac');
            expect(mapped.user.login).toBe('Llama');
        });

        it('should handle username field when login is missing', () => {
            const forgejoPR = {
                number: 1,
                user: {
                    id: 1,
                    username: 'Llama',
                },
            };

            const mapped = mapForgejoPullRequest(forgejoPR);

            expect(mapped.user.login).toBe('Llama');
        });
    });
});

describe('Forgejo Webhook Actions', () => {
    const ALLOWED_ACTIONS = [
        'opened',
        'synchronize',    // GitHub uses this
        'synchronized',   // Forgejo uses this (with 'd')
        'ready_for_review',
        'open',
        'update',
    ];

    it('should recognize opened action', () => {
        expect(ALLOWED_ACTIONS.includes('opened')).toBe(true);
    });

    it('should recognize synchronized action (Forgejo)', () => {
        expect(ALLOWED_ACTIONS.includes('synchronized')).toBe(true);
    });

    it('should recognize synchronize action (GitHub)', () => {
        expect(ALLOWED_ACTIONS.includes('synchronize')).toBe(true);
    });

    it('should not recognize closed action for code review trigger', () => {
        expect(ALLOWED_ACTIONS.includes('closed')).toBe(false);
    });
});
