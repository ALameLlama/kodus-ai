import { Module, forwardRef } from '@nestjs/common';

import { AuthIntegrationModule } from '@libs/integrations/modules/authIntegration.module';
import { IntegrationConfigCoreModule } from '@libs/integrations/modules/config-core.module';
import { IntegrationCoreModule } from '@libs/integrations/modules/integrations-core.module';
import { GithubModule } from './github.module';
import { GitlabModule } from './gitlab.module';
import { BitbucketModule } from './bitbucket.module';
import { AzureReposModule } from './azure-repos.module';

import CodeManagementUseCases from '../application/use-cases/codeManagement';
import { AgentsModule } from '@libs/agents/modules/agents.module';
import { CodeReviewSettingsLogModule } from '@libs/ee/codeReviewSettingsLog/codeReviewSettingsLog.module';
import { OrganizationParametersModule } from '@libs/organization/modules/organizationParameters.module';
import { TeamModule } from '@libs/organization/modules/team.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { PlatformDataModule } from '@libs/platformData/platformData.module';
import { PermissionsModule } from '@libs/identity/modules/permissions.module';
import { PullRequestMessagesModule } from '@libs/code-review/modules/pullRequestMessages.module';
import { CodebaseModule } from '@libs/code-review/modules/codebase.module';
import { AzureReposPullRequestHandler } from '../infrastructure/webhooks/azure/azureReposPullRequest.handler';
import { GitHubPullRequestHandler } from '../infrastructure/webhooks/github/githubPullRequest.handler';
import { GitLabMergeRequestHandler } from '../infrastructure/webhooks/gitlab/gitlabPullRequest.handler';
import { BitbucketPullRequestHandler } from '../infrastructure/webhooks/bitbucket/bitbucketPullRequest.handler';

import { PlatformCoreModule } from './platform-core.module';
import { GetConnectionsUseCase } from '../application/use-cases/integrations/get-connections.use-case';
import { GetOrganizationLanguageUseCase } from '../application/use-cases/organization/get-organization-language.use-case';
import { WebhookContextService } from '../application/services/webhook-context.service';

import { AutomationModule } from '@libs/automation/modules/automation.module';
import { KodyRulesModule } from '@libs/kodyRules/modules/kodyRules.module';
import { IssuesModule } from '@libs/issues/issues.module';
import { WorkflowModule } from '@libs/core/workflow/modules/workflow.module';

@Module({
    imports: [
        PlatformCoreModule,
        forwardRef(() => IntegrationCoreModule),
        forwardRef(() => IntegrationConfigCoreModule),
        forwardRef(() => AuthIntegrationModule),
        GithubModule,
        GitlabModule,
        BitbucketModule,
        AzureReposModule,
        forwardRef(() => AgentsModule),
        forwardRef(() => CodeReviewSettingsLogModule),
        forwardRef(() => OrganizationParametersModule),
        forwardRef(() => TeamModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => PlatformDataModule),
        PermissionsModule,
        forwardRef(() => PullRequestMessagesModule),
        forwardRef(() => CodebaseModule),
        forwardRef(() => AutomationModule),
        WorkflowModule.register({ type: 'webhook' }),
        forwardRef(() => KodyRulesModule),
        forwardRef(() => IssuesModule),
    ],
    providers: [
        ...CodeManagementUseCases,
        GetConnectionsUseCase,
        GetOrganizationLanguageUseCase,
        WebhookContextService,
        AzureReposPullRequestHandler,
        GitHubPullRequestHandler,
        GitLabMergeRequestHandler,
        BitbucketPullRequestHandler,
        {
            provide: 'AZURE_REPOS_WEBHOOK_HANDLER',
            useExisting: AzureReposPullRequestHandler,
        },
        {
            provide: 'GITHUB_WEBHOOK_HANDLER',
            useExisting: GitHubPullRequestHandler,
        },
        {
            provide: 'GITLAB_WEBHOOK_HANDLER',
            useExisting: GitLabMergeRequestHandler,
        },
        {
            provide: 'BITBUCKET_WEBHOOK_HANDLER',
            useExisting: BitbucketPullRequestHandler,
        },
    ],
    exports: [
        PlatformCoreModule,
        ...CodeManagementUseCases,
        GetConnectionsUseCase,
        GetOrganizationLanguageUseCase,
        WebhookContextService,
        'AZURE_REPOS_WEBHOOK_HANDLER',
        'GITHUB_WEBHOOK_HANDLER',
        'GITLAB_WEBHOOK_HANDLER',
        'BITBUCKET_WEBHOOK_HANDLER',
    ],
})
export class PlatformModule {}
