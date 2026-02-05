import { v4 as uuidv4 } from 'uuid';

import { sendInvite } from '@libs/common/utils/email/sendMail';

import {
    getAdminTestEmail,
    getInviteBaseUrl,
    getTestOrganizationName,
    getTestRecipient,
    getTestTeamName,
    shouldSkipEmailTest,
} from './email-test.utils';

describe('Transactional Email - Invite', () => {
    it('sends invite email', async () => {
        if (shouldSkipEmailTest(['API_USER_INVITE_BASE_URL'])) {
            return;
        }

        const recipient = getTestRecipient();
        const organizationName = getTestOrganizationName();
        const teamName = getTestTeamName();
        const adminEmail = getAdminTestEmail();
        const inviteLink = `${getInviteBaseUrl()}/invite/${uuidv4()}`;

        const user = {
            email: recipient.email,
            organization: { name: organizationName },
            teamMember: [
                {
                    name: recipient.name,
                    team: { name: teamName },
                },
            ],
        };

        const result = await sendInvite(user, adminEmail, inviteLink);

        expect(result).toBeDefined();
    }, 30000);
});
