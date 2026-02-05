import * as dotenv from 'dotenv';
import * as path from 'path';

const envFile = process.env.ENV_FILE || '.env';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

type TestRecipient = {
    email: string;
    name: string;
};

const getEnv = (key: string): string | undefined => process.env[key];

const warnMissing = (key: string) => {
    console.warn(`Missing ${key}. Skipping email integration test.`);
};

export const shouldSkipEmailTest = (extraKeys: string[] = []): boolean => {
    if (!getEnv('API_CUSTOMERIO_APP_API_TOKEN')) {
        warnMissing('API_CUSTOMERIO_APP_API_TOKEN');
        return true;
    }

    if (!getEnv('API_CUSTOMERIO_TEST_EMAIL')) {
        warnMissing('API_CUSTOMERIO_TEST_EMAIL');
        return true;
    }

    for (const key of extraKeys) {
        if (!getEnv(key)) {
            warnMissing(key);
            return true;
        }
    }

    return false;
};

export const getTestRecipient = (): TestRecipient => {
    const email = getEnv('API_CUSTOMERIO_TEST_EMAIL') || 'test@example.com';
    const name =
        getEnv('API_CUSTOMERIO_TEST_NAME') ||
        email.split('@')[0] ||
        'Test User';

    return { email, name };
};

export const getTestOrganizationName = (): string =>
    getEnv('API_CUSTOMERIO_TEST_ORG') || 'Kodus Test Organization';

export const getTestTeamName = (): string =>
    getEnv('API_CUSTOMERIO_TEST_TEAM') || 'Kodus Test Team';

export const getInviteBaseUrl = (): string =>
    getEnv('API_USER_INVITE_BASE_URL') || '';

export const getAdminTestEmail = (): string =>
    getEnv('API_CUSTOMERIO_TEST_ADMIN_EMAIL') ||
    getTestRecipient().email ||
    'admin@example.com';
