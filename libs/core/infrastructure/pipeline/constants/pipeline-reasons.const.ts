import { PipelineReason } from '../interfaces/pipeline-reason.interface';

export const PipelineReasons = {
    CONFIG: {
        DISABLED: {
            message: 'Review Disabled',
            action: 'Enable automated review in your configuration',
        } as PipelineReason,
        IGNORED_TITLE: {
            message: 'Title Ignored',
            action: 'Rename PR to remove ignored keywords',
        } as PipelineReason,
        DRAFT: {
            message: 'Draft PR',
            action: 'Mark as Ready for Review to proceed',
        } as PipelineReason,
        BRANCH_MISMATCH: {
            message: 'Branch Mismatch',
            action: 'Review only runs on specific target branches',
        } as PipelineReason,
    },
    FILES: {
        NO_CHANGES: {
            message: 'No Files Changed',
        } as PipelineReason,
        ALL_IGNORED: {
            message: 'All Files Ignored',
            action: 'Check your ignore patterns (.kodusignore)',
        } as PipelineReason,
        TOO_MANY: {
            message: 'Too Many Files',
            action: 'Reduce PR size for better review quality',
        } as PipelineReason,
    },
    COMMITS: {
        NO_NEW: {
            message: 'No New Commits',
            description: 'We already reviewed the latest changes',
        } as PipelineReason,
        ONLY_MERGE: {
            message: 'Only Merge Commits',
            description: 'Merge commits are skipped to avoid noise',
        } as PipelineReason,
    },
    PREREQUISITES: {
        CLOSED: {
            message: 'PR is Closed',
        } as PipelineReason,
        LOCKED: {
            message: 'PR is Locked',
        } as PipelineReason,
    },
};
