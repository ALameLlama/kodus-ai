/**
 * @see https://forgejo.org/docs/latest/user/api-usage/
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { createLogger } from '@kodus/flow';
import {
    IWebhookForgejoUser,
    IWebhookForgejoLabel,
    IWebhookForgejoMilestone,
    IWebhookForgejoRepository,
    IWebhookForgejoComment,
    IWebhookForgejoOrganization,
    IWebhookForgejoPullRequest,
} from '@libs/platform/domain/platformIntegrations/types/webhooks/webhooks-forgejo.type';

const logger = createLogger('ForgejoSDK');

// Type aliases for SDK usage (webhook types that are the same in API responses)
export type ForgejoUser = IWebhookForgejoUser;
export type ForgejoLabel = IWebhookForgejoLabel;
export type ForgejoMilestone = IWebhookForgejoMilestone;
export type ForgejoComment = IWebhookForgejoComment;
export type ForgejoRepository = IWebhookForgejoRepository;
export type ForgejoOrganization = IWebhookForgejoOrganization;
export type ForgejoPullRequest = IWebhookForgejoPullRequest;

// Note: IWebhookForgejoCommit is for webhook payloads, ForgejoApiCommit below is for API responses
// Note: IWebhookForgejoReview is for webhook payloads, ForgejoPullRequestReview below is for API responses

// ============================================================================
// Types - SDK-specific Response Types (API responses differ from webhook payloads)
// ============================================================================

/**
 * Forgejo API commit response - different structure from webhook commit (IWebhookForgejoCommit)
 * The API returns commits with nested `commit` object, while webhooks have flat structure
 */
export interface ForgejoApiCommit {
    sha: string;
    url: string;
    html_url: string;
    commit: {
        url: string;
        message: string;
        author: {
            name: string;
            email: string;
            date: string;
        };
        committer: {
            name: string;
            email: string;
            date: string;
        };
    };
    author: ForgejoUser | null;
    committer: ForgejoUser | null;
    parents: Array<{
        sha: string;
        url: string;
    }>;
}

// Alias for backward compatibility
export type ForgejoCommit = ForgejoApiCommit;

/**
 * Forgejo API pull request review response
 */
export interface ForgejoPullRequestReview {
    id: number;
    user: ForgejoUser;
    team?: {
        id: number;
        name: string;
        description: string;
    };
    body: string;
    state: ForgejoReviewState;
    html_url: string;
    pull_request_url: string;
    commit_id: string;
    stale: boolean;
    official: boolean;
    dismissed: boolean;
    comments_count?: number;
    submitted_at: string;
    updated_at?: string;
}

/**
 * Review state values for API responses
 */
export type ForgejoReviewState =
    | 'PENDING'
    | 'APPROVED'
    | 'REQUEST_CHANGES'
    | 'COMMENT';

/**
 * Review event values for creating reviews
 */
export type ForgejoReviewEvent =
    | 'APPROVED'
    | 'REQUEST_CHANGES'
    | 'COMMENT'
    | 'PENDING';

export interface ForgejoBranch {
    name: string;
    commit: {
        id: string;
        message: string;
        url: string;
        author: {
            name: string;
            email: string;
            date: string;
        };
        committer: {
            name: string;
            email: string;
            date: string;
        };
        timestamp: string;
    };
    protected: boolean;
    required_approvals: number;
    enable_status_check: boolean;
    status_check_contexts: string[];
    user_can_push: boolean;
    user_can_merge: boolean;
}

export interface ForgejoPullRequestFile {
    filename: string;
    status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied';
    additions: number;
    deletions: number;
    changes: number;
    html_url: string;
    contents_url: string;
    raw_url: string;
    previous_filename?: string;
}

export interface ForgejoContentFile {
    type: 'file' | 'dir' | 'symlink' | 'submodule';
    encoding: string;
    size: number;
    name: string;
    path: string;
    content: string;
    sha: string;
    url: string;
    git_url: string;
    html_url: string;
    download_url: string;
    _links: {
        self: string;
        git: string;
        html: string;
    };
}

export interface ForgejoTreeEntry {
    path: string;
    mode: string;
    type: 'blob' | 'tree';
    sha: string;
    size?: number;
    url: string;
}

export interface ForgejoTree {
    sha: string;
    url: string;
    tree: ForgejoTreeEntry[];
    truncated: boolean;
    page: number;
    total_count: number;
}

export interface ForgejoReviewComment {
    id: number;
    body: string;
    user: ForgejoUser;
    pull_request_url: string;
    html_url: string;
    path: string;
    diff_hunk: string;
    commit_id: string;
    original_commit_id: string;
    position?: number;
    line?: number;
    old_line_num?: number;
    new_line_num?: number;
    created_at: string;
    updated_at: string;
    resolver?: ForgejoUser;
}

export interface ForgejoWebhook {
    id: number;
    type: string;
    url: string;
    config: {
        url: string;
        content_type: string;
        secret?: string;
    };
    events: string[];
    active: boolean;
    created_at: string;
    updated_at: string;
}

export interface ForgejoReaction {
    user: ForgejoUser;
    /** The reaction emoji/content (e.g., "+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes") */
    content: string;
    created_at: string;
}

/** Review request body for creating a review with inline comments */
export interface ForgejoCreateReviewRequest {
    body?: string;
    commit_id?: string;
    event: ForgejoReviewEvent;
    comments?: Array<{
        path: string;
        body: string;
        new_position?: number;
        old_position?: number;
    }>;
}

/** Webhook creation request body */
export interface ForgejoCreateWebhookRequest {
    type:
    | 'forgejo'
    | 'gitea'
    | 'gogs'
    | 'slack'
    | 'discord'
    | 'dingtalk'
    | 'telegram'
    | 'msteams'
    | 'feishu'
    | 'matrix'
    | 'wechatwork'
    | 'packagist';
    config: {
        url: string;
        content_type: 'json' | 'form';
        secret?: string;
    };
    events: string[];
    active: boolean;
}

// ============================================================================
// SDK Error Types
// ============================================================================

export class ForgejoApiError extends Error {
    constructor(
        message: string,
        public readonly status: number,
        public readonly statusText: string,
        public readonly url: string,
        public readonly method: string,
        public readonly responseData?: unknown,
    ) {
        super(message);
        this.name = 'ForgejoApiError';
    }
}

// ============================================================================
// SDK Client
// ============================================================================

export interface ForgejoClientConfig {
    /** Forgejo host URL (e.g., https://forgejo.example.com) */
    host: string;
    /** Access token for authentication */
    token: string;
    /** Request timeout in milliseconds (default: 30000) */
    timeout?: number;
}

/**
 * Forgejo API Client
 *
 * Provides typed methods for all Forgejo API operations used by Kodus.
 */
export class ForgejoClient {
    private readonly client: AxiosInstance;
    private readonly host: string;

    constructor(config: ForgejoClientConfig) {
        this.host = config.host;
        this.client = axios.create({
            baseURL: `${config.host}/api/v1`,
            headers: {
                'Authorization': `token ${config.token}`,
                'Content-Type': 'application/json',
            },
            timeout: config.timeout ?? 30000,
        });

        // Add response interceptor for error handling
        this.client.interceptors.response.use(
            (response) => response,
            (error: AxiosError) => {
                const status = error?.response?.status ?? 0;
                const statusText = error?.response?.statusText ?? 'Unknown';
                const url = error?.config?.url ?? '';
                const method = (
                    error?.config?.method ?? 'unknown'
                ).toUpperCase();
                const errorMessage =
                    (error?.response?.data as { message?: string })?.message ||
                    error?.message;

                // Log specific error types
                if (status === 401) {
                    logger.error({
                        message: `Forgejo API authentication failed`,
                        context: 'ForgejoClient',
                        metadata: { status, method, url, host: this.host },
                    });
                } else if (status === 403) {
                    logger.error({
                        message: `Forgejo API forbidden - insufficient permissions`,
                        context: 'ForgejoClient',
                        metadata: { status, method, url, host: this.host },
                    });
                } else if (status === 404) {
                    logger.warn({
                        message: `Forgejo API resource not found`,
                        context: 'ForgejoClient',
                        metadata: { status, method, url },
                    });
                } else if (
                    error.code === 'ECONNREFUSED' ||
                    error.code === 'ENOTFOUND'
                ) {
                    logger.error({
                        message: `Forgejo API connection failed`,
                        context: 'ForgejoClient',
                        metadata: { host: this.host, errorCode: error.code },
                    });
                } else if (
                    error.code === 'ETIMEDOUT' ||
                    error.code === 'ECONNABORTED'
                ) {
                    logger.error({
                        message: `Forgejo API request timed out`,
                        context: 'ForgejoClient',
                        metadata: { host: this.host, method, url },
                    });
                }

                throw new ForgejoApiError(
                    errorMessage,
                    status,
                    statusText,
                    url,
                    method,
                    error?.response?.data,
                );
            },
        );
    }

    // ========================================================================
    // Pagination Helper
    // ========================================================================

    /**
     * Helper method to paginate through all results of an API endpoint.
     * Forgejo uses page-based pagination with a default limit of 50.
     * @param fetchPage - Function that fetches a single page given page number and limit
     * @param options - Pagination options
     * @returns All items from all pages
     */
    private async paginate<T>(
        fetchPage: (page: number, limit: number) => Promise<T[]>,
        options: { limit?: number; maxPages?: number } = {},
    ): Promise<T[]> {
        const limit = options.limit ?? 50;
        const maxPages = options.maxPages ?? 100; // Safety limit to prevent infinite loops
        const allItems: T[] = [];
        let page = 1;

        while (page <= maxPages) {
            const items = await fetchPage(page, limit);
            allItems.push(...items);

            // If we got fewer items than the limit, we've reached the last page
            if (items.length < limit) {
                break;
            }
            page++;
        }

        return allItems;
    }

    // ========================================================================
    // User Methods
    // ========================================================================

    /** Get the currently authenticated user */
    async getCurrentUser(): Promise<ForgejoUser> {
        const response = await this.client.get<ForgejoUser>('/user');
        return response.data;
    }

    /** Get a user by username */
    async getUser(username: string): Promise<ForgejoUser> {
        const response = await this.client.get<ForgejoUser>(
            `/users/${encodeURIComponent(username)}`,
        );
        return response.data;
    }

    /** Search for users */
    async searchUsers(params: {
        q: string;
        limit?: number;
    }): Promise<{ data: ForgejoUser[]; ok: boolean }> {
        const response = await this.client.get<{
            data: ForgejoUser[];
            ok: boolean;
        }>('/users/search', { params });
        return response.data;
    }

    // ========================================================================
    // Organization Methods
    // ========================================================================

    /** Get organizations for the current user */
    async getUserOrganizations(params?: {
        page?: number;
        limit?: number;
    }): Promise<ForgejoOrganization[]> {
        const response = await this.client.get<ForgejoOrganization[]>(
            '/user/orgs',
            { params },
        );
        return response.data;
    }

    /** Get ALL organizations for the current user (paginated) */
    async getAllUserOrganizations(): Promise<ForgejoOrganization[]> {
        return this.paginate((page, limit) =>
            this.getUserOrganizations({ page, limit }),
        );
    }

    /** Get repositories for an organization */
    async getOrganizationRepositories(
        org: string,
        params?: { page?: number; limit?: number },
    ): Promise<ForgejoRepository[]> {
        const response = await this.client.get<ForgejoRepository[]>(
            `/orgs/${encodeURIComponent(org)}/repos`,
            { params },
        );
        return response.data;
    }

    /** Get ALL repositories for an organization (paginated) */
    async getAllOrganizationRepositories(org: string): Promise<ForgejoRepository[]> {
        return this.paginate((page, limit) =>
            this.getOrganizationRepositories(org, { page, limit }),
        );
    }

    // ========================================================================
    // Repository Methods
    // ========================================================================

    /** Get repositories for the current user */
    async getUserRepositories(params?: {
        page?: number;
        limit?: number;
    }): Promise<ForgejoRepository[]> {
        const response = await this.client.get<ForgejoRepository[]>(
            '/user/repos',
            { params },
        );
        return response.data;
    }

    /** Get ALL repositories for the current user (paginated) */
    async getAllUserRepositories(): Promise<ForgejoRepository[]> {
        return this.paginate((page, limit) =>
            this.getUserRepositories({ page, limit }),
        );
    }

    /** Get a repository by owner and name */
    async getRepository(
        owner: string,
        repo: string,
    ): Promise<ForgejoRepository> {
        const response = await this.client.get<ForgejoRepository>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        );
        return response.data;
    }

    /** Get repository languages */
    async getRepositoryLanguages(
        owner: string,
        repo: string,
    ): Promise<Record<string, number>> {
        const response = await this.client.get<Record<string, number>>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/languages`,
        );
        return response.data;
    }

    /** Get a branch */
    async getBranch(
        owner: string,
        repo: string,
        branch: string,
    ): Promise<ForgejoBranch> {
        const response = await this.client.get<ForgejoBranch>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`,
        );
        return response.data;
    }

    /** Get repository tree (file list) */
    async getTree(
        owner: string,
        repo: string,
        sha: string,
        params?: { recursive?: boolean; page?: number; per_page?: number },
    ): Promise<ForgejoTree> {
        const response = await this.client.get<ForgejoTree>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(sha)}`,
            { params },
        );
        return response.data;
    }

    /** Get file contents */
    async getContents(
        owner: string,
        repo: string,
        path: string,
        ref?: string,
    ): Promise<ForgejoContentFile | ForgejoContentFile[]> {
        const response = await this.client.get<
            ForgejoContentFile | ForgejoContentFile[]
        >(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`,
            { params: ref ? { ref } : undefined },
        );
        return response.data;
    }

    // ========================================================================
    // Pull Request Methods
    // ========================================================================

    /** List pull requests for a repository */
    async listPullRequests(
        owner: string,
        repo: string,
        params?: {
            state?: 'open' | 'closed' | 'all';
            sort?:
            | 'oldest'
            | 'recentupdate'
            | 'leastupdate'
            | 'mostcomment'
            | 'leastcomment'
            | 'priority';
            page?: number;
            limit?: number;
        },
    ): Promise<ForgejoPullRequest[]> {
        const response = await this.client.get<ForgejoPullRequest[]>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
            { params },
        );
        return response.data;
    }

    /** List ALL pull requests for a repository (paginated) */
    async listAllPullRequests(
        owner: string,
        repo: string,
        params?: {
            state?: 'open' | 'closed' | 'all';
            sort?:
            | 'oldest'
            | 'recentupdate'
            | 'leastupdate'
            | 'mostcomment'
            | 'leastcomment'
            | 'priority';
        },
    ): Promise<ForgejoPullRequest[]> {
        return this.paginate((page, limit) =>
            this.listPullRequests(owner, repo, { ...params, page, limit }),
        );
    }

    /** Get a pull request by number */
    async getPullRequest(
        owner: string,
        repo: string,
        number: number,
    ): Promise<ForgejoPullRequest> {
        const response = await this.client.get<ForgejoPullRequest>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
        );
        return response.data;
    }

    /** Merge a pull request */
    async mergePullRequest(
        owner: string,
        repo: string,
        number: number,
        params: {
            Do:
            | 'merge'
            | 'rebase'
            | 'rebase-merge'
            | 'squash'
            | 'manually-merged';
            MergeCommitID?: string;
            MergeMessageField?: string;
            MergeTitleField?: string;
            delete_branch_after_merge?: boolean;
            force_merge?: boolean;
            head_commit_id?: string;
        },
    ): Promise<void> {
        await this.client.post(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/merge`,
            params,
        );
    }

    /** Update a pull request */
    async updatePullRequest(
        owner: string,
        repo: string,
        number: number,
        params: {
            title?: string;
            body?: string;
            state?: 'open' | 'closed';
            base?: string;
            assignee?: string;
            assignees?: string[];
            milestone?: number;
            labels?: number[];
            due_date?: string;
        },
    ): Promise<ForgejoPullRequest> {
        const response = await this.client.patch<ForgejoPullRequest>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
            params,
        );
        return response.data;
    }

    /** Get files changed in a pull request */
    async getPullRequestFiles(
        owner: string,
        repo: string,
        number: number,
        params?: { skip?: number; limit?: number },
    ): Promise<ForgejoPullRequestFile[]> {
        const response = await this.client.get<ForgejoPullRequestFile[]>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/files`,
            { params },
        );
        return response.data;
    }

    /** Get ALL files changed in a pull request (paginated using skip) */
    async getAllPullRequestFiles(
        owner: string,
        repo: string,
        number: number,
    ): Promise<ForgejoPullRequestFile[]> {
        const limit = 50;
        const maxPages = 100;
        const allFiles: ForgejoPullRequestFile[] = [];
        let skip = 0;

        for (let page = 0; page < maxPages; page++) {
            const files = await this.getPullRequestFiles(owner, repo, number, { skip, limit });
            allFiles.push(...files);

            if (files.length < limit) {
                break;
            }
            skip += limit;
        }

        return allFiles;
    }

    /** Get commits in a pull request */
    async getPullRequestCommits(
        owner: string,
        repo: string,
        number: number,
        params?: { page?: number; limit?: number },
    ): Promise<ForgejoCommit[]> {
        const response = await this.client.get<ForgejoCommit[]>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/commits`,
            { params },
        );
        return response.data;
    }

    /** Get ALL commits in a pull request (paginated) */
    async getAllPullRequestCommits(
        owner: string,
        repo: string,
        number: number,
    ): Promise<ForgejoCommit[]> {
        return this.paginate((page, limit) =>
            this.getPullRequestCommits(owner, repo, number, { page, limit }),
        );
    }

    /** Check if a pull request is merged */
    async isPullRequestMerged(
        owner: string,
        repo: string,
        number: number,
    ): Promise<boolean> {
        try {
            await this.client.get(
                `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/merge`,
            );
            return true;
        } catch (error) {
            if (error instanceof ForgejoApiError && error.status === 404) {
                return false;
            }
            throw error;
        }
    }

    // ========================================================================
    // Review Methods
    // ========================================================================

    /** List reviews on a pull request */
    async listPullRequestReviews(
        owner: string,
        repo: string,
        number: number,
        params?: { page?: number; limit?: number },
    ): Promise<ForgejoPullRequestReview[]> {
        const response = await this.client.get<ForgejoPullRequestReview[]>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/reviews`,
            { params },
        );
        return response.data;
    }

    /** Create a review on a pull request */
    async createPullRequestReview(
        owner: string,
        repo: string,
        number: number,
        review: ForgejoCreateReviewRequest,
    ): Promise<ForgejoPullRequestReview> {
        const response = await this.client.post<ForgejoPullRequestReview>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/reviews`,
            review,
        );
        return response.data;
    }

    /** Get review comments on a pull request */
    async getPullRequestReviewComments(
        owner: string,
        repo: string,
        number: number,
    ): Promise<ForgejoReviewComment[]> {
        const response = await this.client.get<ForgejoReviewComment[]>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/comments`,
        );
        return response.data;
    }

    // ========================================================================
    // Comment Methods (Issue/PR comments - not inline review comments)
    // ========================================================================

    /** List comments on an issue/PR */
    async listIssueComments(
        owner: string,
        repo: string,
        number: number,
        params?: { since?: string; before?: string },
    ): Promise<ForgejoComment[]> {
        const response = await this.client.get<ForgejoComment[]>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`,
            { params },
        );
        return response.data;
    }

    /** Create a comment on an issue/PR */
    async createIssueComment(
        owner: string,
        repo: string,
        number: number,
        body: string,
    ): Promise<ForgejoComment> {
        const response = await this.client.post<ForgejoComment>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`,
            { body },
        );
        return response.data;
    }

    /** Update an issue/PR comment */
    async updateIssueComment(
        owner: string,
        repo: string,
        commentId: number,
        body: string,
    ): Promise<ForgejoComment> {
        const response = await this.client.patch<ForgejoComment>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}`,
            { body },
        );
        return response.data;
    }

    /** Delete an issue/PR comment */
    async deleteIssueComment(
        owner: string,
        repo: string,
        commentId: number,
    ): Promise<void> {
        await this.client.delete(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}`,
        );
    }

    // ========================================================================
    // Commit Methods
    // ========================================================================

    /** List commits for a repository */
    async listCommits(
        owner: string,
        repo: string,
        params?: {
            sha?: string;
            path?: string;
            page?: number;
            limit?: number;
        },
    ): Promise<ForgejoCommit[]> {
        const response = await this.client.get<ForgejoCommit[]>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits`,
            { params },
        );
        return response.data;
    }

    /** List ALL commits for a repository (paginated) */
    async listAllCommits(
        owner: string,
        repo: string,
        params?: {
            sha?: string;
            path?: string;
        },
    ): Promise<ForgejoCommit[]> {
        return this.paginate((page, limit) =>
            this.listCommits(owner, repo, { ...params, page, limit }),
        );
    }

    /** Get a single commit */
    async getCommit(
        owner: string,
        repo: string,
        sha: string,
    ): Promise<ForgejoCommit> {
        const response = await this.client.get<ForgejoCommit>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(sha)}`,
        );
        return response.data;
    }

    // ========================================================================
    // Webhook Methods
    // ========================================================================

    /** List webhooks for a repository */
    async listWebhooks(owner: string, repo: string): Promise<ForgejoWebhook[]> {
        const response = await this.client.get<ForgejoWebhook[]>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
        );
        return response.data;
    }

    /** Create a webhook */
    async createWebhook(
        owner: string,
        repo: string,
        webhook: ForgejoCreateWebhookRequest,
    ): Promise<ForgejoWebhook> {
        const response = await this.client.post<ForgejoWebhook>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
            webhook,
        );
        return response.data;
    }

    /** Delete a webhook */
    async deleteWebhook(
        owner: string,
        repo: string,
        hookId: number,
    ): Promise<void> {
        await this.client.delete(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks/${hookId}`,
        );
    }

    // ========================================================================
    // Reaction Methods
    // ========================================================================

    /** Get reactions on an issue/PR */
    async getIssueReactions(
        owner: string,
        repo: string,
        number: number,
    ): Promise<ForgejoReaction[]> {
        const response = await this.client.get<ForgejoReaction[]>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/reactions`,
        );
        return response.data;
    }

    /** Add a reaction to an issue/PR */
    async addIssueReaction(
        owner: string,
        repo: string,
        number: number,
        reaction: string,
    ): Promise<ForgejoReaction> {
        const response = await this.client.post<ForgejoReaction>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/reactions`,
            { content: reaction },
        );
        return response.data;
    }

    /** Remove a reaction from an issue/PR */
    async removeIssueReaction(
        owner: string,
        repo: string,
        number: number,
        reaction: string,
    ): Promise<void> {
        await this.client.delete(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/reactions`,
            { data: { content: reaction } },
        );
    }

    /** Get reactions on a comment */
    async getCommentReactions(
        owner: string,
        repo: string,
        commentId: number,
    ): Promise<ForgejoReaction[]> {
        const response = await this.client.get<ForgejoReaction[]>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}/reactions`,
        );
        return response.data;
    }

    /** Add a reaction to a comment */
    async addCommentReaction(
        owner: string,
        repo: string,
        commentId: number,
        reaction: string,
    ): Promise<ForgejoReaction> {
        const response = await this.client.post<ForgejoReaction>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}/reactions`,
            { content: reaction },
        );
        return response.data;
    }

    /** Remove a reaction from a comment */
    async removeCommentReaction(
        owner: string,
        repo: string,
        commentId: number,
        reaction: string,
    ): Promise<void> {
        await this.client.delete(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}/reactions`,
            { data: { content: reaction } },
        );
    }
}

// ============================================================================
// Factory function
// ============================================================================

/**
 * Create a Forgejo API client
 */
export function createForgejoClient(
    config: ForgejoClientConfig,
): ForgejoClient {
    return new ForgejoClient(config);
}
