import {
    IMappedComment,
    IMappedPlatform,
    IMappedPullRequest,
    IMappedRepository,
    IMappedUsers,
    MappedAction,
} from '@libs/platform/domain/platformIntegrations/types/webhooks/webhooks-common.type';
import {
    IWebhookForgejoPullRequestEvent,
    IWebhookForgejoIssueCommentEvent,
    WebhookForgejoPullRequestAction,
} from '@libs/platform/domain/platformIntegrations/types/webhooks/webhooks-forgejo.type';

export class ForgejoMappedPlatform implements IMappedPlatform {
    mapUsers(params: {
        payload: IWebhookForgejoPullRequestEvent;
    }): IMappedUsers {
        if (!params?.payload?.sender) {
            return null;
        }

        const { payload } = params;
        const pullRequest = payload?.pull_request;

        return {
            user: payload?.sender,
            assignees: pullRequest?.assignees || [],
            reviewers: pullRequest?.requested_reviewers || [],
        };
    }

    private isIssueCommentEvent(
        payload: any,
    ): payload is IWebhookForgejoIssueCommentEvent {
        return 'comment' in payload && 'issue' in payload;
    }

    mapPullRequest(params: {
        payload: IWebhookForgejoPullRequestEvent | IWebhookForgejoIssueCommentEvent;
    }): IMappedPullRequest {
        const { payload } = params;

        let pullRequest: any;
        let number: number;

        if (this.isIssueCommentEvent(payload)) {
            // For issue comments on PRs, we get limited PR info from the issue
            number = payload.issue?.number;
            pullRequest = {
                number: payload.issue?.number,
                title: payload.issue?.title,
                body: payload.issue?.body,
                user: payload.issue?.user,
                labels: payload.issue?.labels,
            };
        } else {
            pullRequest = payload?.pull_request;
            number = payload?.number || pullRequest?.number;
        }

        if (!pullRequest) {
            return null;
        }

        return {
            ...pullRequest,
            repository: payload?.repository,
            number,
            user: pullRequest?.user || payload?.sender,
            body: pullRequest?.body,
            title: pullRequest?.title,
            url: pullRequest?.html_url,
            head: pullRequest?.head
                ? {
                      repo: {
                          fullName: pullRequest?.head?.repo?.full_name,
                      },
                      ref: pullRequest?.head?.ref,
                      sha: pullRequest?.head?.sha,
                  }
                : undefined,
            base: pullRequest?.base
                ? {
                      repo: {
                          fullName: pullRequest?.base?.repo?.full_name,
                          defaultBranch: pullRequest?.base?.repo?.default_branch,
                      },
                      ref: pullRequest?.base?.ref,
                      sha: pullRequest?.base?.sha,
                  }
                : undefined,
            isDraft: pullRequest?.title?.toLowerCase().startsWith('wip:') ||
                     pullRequest?.title?.toLowerCase().startsWith('[wip]') ||
                     pullRequest?.title?.toLowerCase().startsWith('draft:') ||
                     pullRequest?.title?.toLowerCase().startsWith('[draft]'),
            tags: pullRequest?.labels?.map((label: any) => label.name) ?? [],
        };
    }

    mapRepository(params: {
        payload: IWebhookForgejoPullRequestEvent | IWebhookForgejoIssueCommentEvent;
    }): IMappedRepository {
        if (!params?.payload?.repository) {
            return null;
        }

        const { payload } = params;
        const repository = payload?.repository;

        return {
            ...repository,
            id: repository?.id?.toString(),
            name: repository?.name,
            language: null,
            fullName: repository?.full_name ?? repository?.name ?? '',
            url: repository?.html_url,
        };
    }

    mapComment(params: {
        payload: IWebhookForgejoIssueCommentEvent;
    }): IMappedComment {
        if (!params?.payload?.comment?.body) {
            return null;
        }

        return {
            id: params?.payload?.comment?.id?.toString(),
            body: params?.payload?.comment?.body,
        };
    }

    mapAction(params: {
        payload: IWebhookForgejoPullRequestEvent;
    }): MappedAction | string | null {
        if (!params?.payload?.action) {
            return null;
        }

        switch (params?.payload?.action) {
            case WebhookForgejoPullRequestAction.OPENED:
                return MappedAction.OPENED;
            case WebhookForgejoPullRequestAction.SYNCHRONIZED:
            case WebhookForgejoPullRequestAction.EDITED:
                return MappedAction.UPDATED;
            default:
                // Return raw action string for closed, reopened, merged, etc.
                return params?.payload?.action;
        }
    }
}
