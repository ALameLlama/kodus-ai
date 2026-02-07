export interface IWorkflowJobRepository {
    create(job: any, transactionManager?: unknown): Promise<any>;
    update(id: string, data: any): Promise<any>;
    findOne(id: string): Promise<any>;
    findMany(query: any): Promise<{ data: any[]; total?: number }>;
    prunePayloadForFinalizedJobs?(params: {
        olderThan: Date;
        limit?: number;
    }): Promise<number>;
}

export const WORKFLOW_JOB_REPOSITORY_TOKEN = Symbol.for(
    'WorkflowJobRepository',
);
