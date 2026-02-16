import { INTEGRATIONS_KEY } from "@enums";

import { AzureReposConnection } from "./azureReposConnection";
import { BitbucketConnection } from "./bitbucketConnection";
import { ForgejoConnection } from "./forgejoConnection";
import { GitHubConnection } from "./gitHubConnection";
import { GitlabConnection } from "./gitlabConnection";
import { IIntegrationConnector } from "./IIntegrationConnector";

class IntegrationFactory {
    private connectors: { [key: string]: IIntegrationConnector };

    constructor() {
        this.connectors = {
            [INTEGRATIONS_KEY.GITHUB]: new GitHubConnection(),
            [INTEGRATIONS_KEY.GITLAB]: new GitlabConnection(),
            [INTEGRATIONS_KEY.BITBUCKET]: new BitbucketConnection(),
            [INTEGRATIONS_KEY.AZURE_REPOS]: new AzureReposConnection(),
            [INTEGRATIONS_KEY.FORGEJO]: new ForgejoConnection(),
        };
    }

    getConnector(key: string): IIntegrationConnector | null {
        return this.connectors[key.toLowerCase()] || null;
    }
}

const factoryInstance = new IntegrationFactory();

export default factoryInstance;
