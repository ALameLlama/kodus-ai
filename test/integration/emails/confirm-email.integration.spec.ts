import { sendConfirmationEmail } from '@libs/common/utils/email/sendMail';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import {
    getTestOrganizationName,
    getTestRecipient,
    getTestTeamName,
    shouldSkipEmailTest,
} from './email-test.utils';

describe('Transactional Email - Confirmation', () => {
    it('sends confirmation email', async () => {
        if (shouldSkipEmailTest(['API_USER_INVITE_BASE_URL'])) {
            return;
        }

        const recipient = getTestRecipient();
        const organizationName = getTestOrganizationName();
        const teamName = getTestTeamName();
        const token = 'test-confirm-email-token';

        const organizationAndTeamData: OrganizationAndTeamData = {
            organizationName,
            teamName,
        };

        const result = await sendConfirmationEmail(
            token,
            recipient.email,
            organizationName,
            organizationAndTeamData,
        );

        expect(result).toBeDefined();
    }, 30000);
});
