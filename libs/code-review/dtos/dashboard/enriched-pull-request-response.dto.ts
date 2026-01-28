import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';

export interface CodeReviewExecutionTimeline {
    uuid: string;
    createdAt: Date;
    updatedAt: Date;
    status: AutomationStatus;
    stageName?: string;
    message?: string;
    metadata?: Record<string, any>;
    finishedAt?: Date;
}

export interface EnrichedPullRequestResponse {
    // Dados do PR (do MongoDB)
    prId: string;
    prNumber: number;
    title: string;
    status: string;
    merged: boolean;
    url: string;
    baseBranchRef: string;
    headBranchRef: string;
    repositoryName: string;
    repositoryId: string;
    openedAt: string;
    closedAt?: string;
    createdAt: string;
    updatedAt: string;
    provider: string;
    author: {
        id: string;
        username: string;
        name?: string;
    };
    isDraft: boolean;
    suggestionsCount: { sent: number; filtered: number };
    reviewedCommitSha?: string;
    reviewedCommitUrl?: string;
    compareUrl?: string;
    executionId?: string;

    // Dados da execução de automação (do PostgreSQL)
    automationExecution: {
        uuid: string;
        status: AutomationStatus;
        errorMessage?: string;
        createdAt: Date;
        updatedAt: Date;
        origin: string;
    };

    // Timeline de execuções de code review
    codeReviewTimeline: CodeReviewExecutionTimeline[];

    // Dados enriquecidos do dataExecution
    enrichedData?: {
        repository?: {
            id: string;
            name: string;
        };
        pullRequest?: {
            number: number;
            title: string;
            url?: string;
        };
        team?: {
            name: string;
            uuid: string;
        };
        automation?: {
            name: string;
            type: string;
        };
    };
}
