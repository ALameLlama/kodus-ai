import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';

// TODO: see if this is correct, currently we're just doing token based, but forgejo also lets you create apps

export type ForgejoAuthDetail = {
    accessToken: string;
    authMode?: AuthMode;
    host: string;
};
