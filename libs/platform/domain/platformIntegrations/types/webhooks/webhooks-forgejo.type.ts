/**
 * Forgejo/Gitea webhook payload types.
 * Forgejo uses a GitHub-compatible API, so many structures are similar.
 */

export interface IWebhookForgejoUser {
    id: number;
    login: string;
    full_name: string;
    email: string;
    avatar_url: string;
    username: string;
}

export interface IWebhookForgejoLabel {
    id: number;
    name: string;
    color: string;
    description: string;
    url: string;
}

export interface IWebhookForgejoMilestone {
    id: number;
    title: string;
    description: string;
    state: string;
    open_issues: number;
    closed_issues: number;
    due_on: string | null;
}

export interface IWebhookForgejoRepository {
    id: number;
    owner: IWebhookForgejoUser;
    name: string;
    full_name: string;
    description: string;
    empty: boolean;
    private: boolean;
    fork: boolean;
    parent: IWebhookForgejoRepository | null;
    mirror: boolean;
    size: number;
    html_url: string;
    ssh_url: string;
    clone_url: string;
    website: string;
    stars_count: number;
    forks_count: number;
    watchers_count: number;
    open_issues_count: number;
    default_branch: string;
    created_at: string;
    updated_at: string;
}

export interface IWebhookForgejoPullRequestHead {
    label: string;
    ref: string;
    sha: string;
    repo_id: number;
    repo: IWebhookForgejoRepository;
}

export interface IWebhookForgejoPullRequestBase {
    label: string;
    ref: string;
    sha: string;
    repo_id: number;
    repo: IWebhookForgejoRepository;
}

export interface IWebhookForgejoPullRequest {
    id: number;
    url: string;
    number: number;
    user: IWebhookForgejoUser;
    title: string;
    body: string;
    labels: IWebhookForgejoLabel[];
    milestone: IWebhookForgejoMilestone | null;
    assignee: IWebhookForgejoUser | null;
    assignees: IWebhookForgejoUser[] | null;
    requested_reviewers: IWebhookForgejoUser[] | null;
    state: 'open' | 'closed';
    is_locked: boolean;
    comments: number;
    html_url: string;
    diff_url: string;
    patch_url: string;
    mergeable: boolean;
    merged: boolean;
    merged_at: string | null;
    merge_commit_sha: string | null;
    merged_by: IWebhookForgejoUser | null;
    base: IWebhookForgejoPullRequestBase;
    head: IWebhookForgejoPullRequestHead;
    merge_base: string;
    due_date: string | null;
    created_at: string;
    updated_at: string;
    closed_at: string | null;
}

export interface IWebhookForgejoComment {
    id: number;
    html_url: string;
    pull_request_url: string;
    issue_url: string;
    user: IWebhookForgejoUser;
    body: string;
    created_at: string;
    updated_at: string;
}

export interface IWebhookForgejoReview {
    id: number;
    type: string;
    reviewer: IWebhookForgejoUser;
    state: string;
    html_url: string;
    pull_request_url: string;
    body: string;
    commit_id: string;
    submitted_at: string;
}

export interface IWebhookForgejoCommit {
    id: string;
    message: string;
    url: string;
    author: {
        name: string;
        email: string;
        username: string;
    };
    committer: {
        name: string;
        email: string;
        username: string;
    };
    timestamp: string;
}

export enum WebhookForgejoPullRequestAction {
    OPENED = 'opened',
    CLOSED = 'closed',
    REOPENED = 'reopened',
    EDITED = 'edited',
    ASSIGNED = 'assigned',
    UNASSIGNED = 'unassigned',
    REVIEW_REQUESTED = 'review_requested',
    REVIEW_REQUEST_REMOVED = 'review_request_removed',
    LABEL_UPDATED = 'label_updated',
    LABEL_CLEARED = 'label_cleared',
    SYNCHRONIZED = 'synchronized',
    MILESTONED = 'milestoned',
    DEMILESTONED = 'demilestoned',
}

export enum WebhookForgejoCommentAction {
    CREATED = 'created',
    EDITED = 'edited',
    DELETED = 'deleted',
}

export enum WebhookForgejoReviewAction {
    SUBMITTED = 'submitted',
    EDITED = 'edited',
    DISMISSED = 'dismissed',
}

/**
 * Pull Request webhook event payload
 * Triggered by: pull_request events
 */
export interface IWebhookForgejoPullRequestEvent {
    action: WebhookForgejoPullRequestAction;
    number: number;
    pull_request: IWebhookForgejoPullRequest;
    repository: IWebhookForgejoRepository;
    sender: IWebhookForgejoUser;
    commit_id?: string;
    review?: IWebhookForgejoReview;
}

/**
 * Issue Comment webhook event payload (also used for PR comments)
 * Triggered by: issue_comment events
 */
export interface IWebhookForgejoIssueCommentEvent {
    action: WebhookForgejoCommentAction;
    issue: {
        id: number;
        url: string;
        number: number;
        user: IWebhookForgejoUser;
        title: string;
        body: string;
        labels: IWebhookForgejoLabel[];
        state: string;
        is_locked: boolean;
        comments: number;
        html_url: string;
        created_at: string;
        updated_at: string;
        pull_request?: {
            merged: boolean;
            merged_at: string | null;
        };
    };
    comment: IWebhookForgejoComment;
    repository: IWebhookForgejoRepository;
    sender: IWebhookForgejoUser;
    is_pull: boolean;
}

/**
 * Pull Request Review webhook event payload
 * Triggered by: pull_request_review events
 */
export interface IWebhookForgejoPullRequestReviewEvent {
    action: WebhookForgejoReviewAction;
    pull_request: IWebhookForgejoPullRequest;
    review: IWebhookForgejoReview;
    repository: IWebhookForgejoRepository;
    sender: IWebhookForgejoUser;
}

/**
 * Pull Request Review Comment webhook event payload
 * Triggered by: pull_request_review_comment events
 */
export interface IWebhookForgejoPullRequestReviewCommentEvent {
    action: WebhookForgejoCommentAction;
    pull_request: IWebhookForgejoPullRequest;
    comment: IWebhookForgejoComment & {
        diff_hunk: string;
        path: string;
        position: number;
        original_position: number;
        commit_id: string;
        original_commit_id: string;
    };
    repository: IWebhookForgejoRepository;
    sender: IWebhookForgejoUser;
}

export type WebhookForgejoEvent =
    | IWebhookForgejoPullRequestEvent
    | IWebhookForgejoIssueCommentEvent
    | IWebhookForgejoPullRequestReviewEvent
    | IWebhookForgejoPullRequestReviewCommentEvent;
