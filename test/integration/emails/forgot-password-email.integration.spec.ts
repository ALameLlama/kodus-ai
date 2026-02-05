import { sendForgotPasswordEmail } from '@libs/common/utils/email/sendMail';

import { getTestRecipient, shouldSkipEmailTest } from './email-test.utils';

describe('Transactional Email - Forgot Password', () => {
    it('sends forgot password email', async () => {
        if (shouldSkipEmailTest(['API_USER_INVITE_BASE_URL'])) {
            return;
        }

        const recipient = getTestRecipient();
        const token = 'test-forgot-password-token';

        const result = await sendForgotPasswordEmail(
            recipient.email,
            recipient.name,
            token,
        );

        expect(result).toBeDefined();
    }, 30000);
});
