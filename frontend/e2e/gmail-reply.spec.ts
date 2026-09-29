import { test, expect } from './fixtures.ts';

for (const reader of [false,true]) {
  test(`Gmail Reply-To survives the ${reader?'conversation':'single-message'} reader and addresses only OVH`, async ({page,fixtureApi}) => {
    await fixtureApi;
    page.__conversationMatrix=reader?'01':'00';
    page.__preferencesOverride={undoSendSeconds:0};
    page.__languageOverride='en';
    const mail={id:'conversation-gmail-copy-2',account_id:'account-gmail',folder:'INBOX',
      message_id:'<merge-parent@ovh.example.test>',thread_id:'conversation-gmail',thread_key:'conversation-gmail',
      subject:'Synthetic merge',from_email:'noreply@ovh.example.test',from_name:'Original sender',
      reply_to:[{name:'OVH admin',address:'admin@ovh.example.test'}],
      to_addresses:[{address:'me@gmail.test'}],cc_addresses:[],date:'2026-09-29T08:00:00Z',
      snippet:'Synthetic incoming copy',is_read:true,is_starred:false,has_attachments:false};
    await page.route(url=>url.pathname==='/api/mail/messages',route=>route.fulfill({json:{messages:[mail],total:1}}));
    await page.route('**/api/mail/messages/conversation-gmail-copy-2',route=>route.fulfill({json:mail}));
    await page.route('**/api/mail/thread/**',route=>route.fulfill({json:{messages:[mail]}}));
    await page.route('**/api/mail/conversations/conversation-gmail',route=>route.fulfill({json:{summary:{conversation_id:'conversation-gmail'},logicalMessages:[]}}));
    const sent:Record<string,unknown>[]=[];
    await page.route('**/api/mail/send',route=>{
      sent.push(route.request().postDataJSON());
      return route.fulfill({json:{ok:true}});
    });
    await page.goto(`/?list=0&reader=${Number(reader)}`);
    await expect(page.locator('[data-ce-reader-enabled]:visible').first()).toHaveAttribute('data-ce-reader-enabled',String(reader));
    await page.locator('[data-msgid="conversation-gmail-copy-2"]:visible').click();
    await page.locator('[data-testid="message-pane-toolbar"]:visible [data-message-action="reply"]').click();
    await expect(page.getByTestId('compose-from')).toBeVisible();
    await page.locator('.tiptap-compose [contenteditable="true"]').fill('Synthetic Gmail reply to OVH');
    await page.getByTestId('compose-send').click();
    await expect.poll(()=>sent.length).toBe(1);
    expect(sent[0]).toMatchObject({accountId:'account-gmail',sendKind:'reply',
      replyToMessageId:mail.id,replyParentAccountId:'account-gmail',inReplyTo:mail.message_id,cc:[],bcc:[]});
    expect(sent[0].to).toEqual(['OVH admin <admin@ovh.example.test>']);
  });
}
