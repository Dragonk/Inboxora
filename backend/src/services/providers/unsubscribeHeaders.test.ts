import { describe, expect, it } from 'vitest';
import { GMAIL_METADATA_HEADERS, localMessageForGmailMessage } from './google/gmailMail.js';

describe('native unsubscribe header normalization', () => {
  it('requests and projects Gmail List-Unsubscribe metadata', () => {
    expect(GMAIL_METADATA_HEADERS).toContain('List-Unsubscribe');
    expect(GMAIL_METADATA_HEADERS).toContain('List-Unsubscribe-Post');
    const local = localMessageForGmailMessage({
      id: 'gmail-1', labelIds: ['INBOX'], payload: { headers: [
        { name: 'List-Unsubscribe', value: ' =?UTF-8?Q?<https://unsubscribe.example/token>?= ' },
        { name: 'List-Unsubscribe-Post', value: ' List-Unsubscribe=One-Click ' },
      ] },
    }, { accountId: 'account-1', pathByLabelId: new Map([['INBOX', 'INBOX']]) });
    expect(local).toMatchObject({
      listUnsubscribe: '<https://unsubscribe.example/token>',
      listUnsubscribePost: 'List-Unsubscribe=One-Click',
    });
  });

});
