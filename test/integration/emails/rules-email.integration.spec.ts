import { sendKodyRulesNotification } from '@libs/common/utils/email/sendMail';

import {
    getTestOrganizationName,
    getTestRecipient,
    shouldSkipEmailTest,
} from './email-test.utils';

describe('Transactional Email - Kody Rules', () => {
    it('sends rules notification email', async () => {
        if (shouldSkipEmailTest()) {
            return;
        }

        const recipient = getTestRecipient();
        const organizationName = getTestOrganizationName();
        const rules = [
            'All public methods should have unit tests',
            'Endpoints must have Swagger documentation',
            'Use try-catch in async operations',
            'Avoid logging sensitive data',
        ];

        const results = await sendKodyRulesNotification(
            [recipient],
            rules,
            organizationName,
        );

        const failures = results.filter(
            (result) => result.status === 'rejected',
        );

        expect(failures.length).toBe(0);
    }, 30000);
});
