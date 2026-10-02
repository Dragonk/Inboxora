import { test, expect } from './fixtures.ts';
import { setupV3 } from './v3-fixtures.ts';

const accountId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const resources = { accounts:[{id:accountId,name:'Test mailbox',email_address:'owner@example.test'}],
  folders:[{id:operationId,account_id:accountId,name:'Inbox',path:'INBOX'}],calendars:[],addressBooks:[] };

for (const theme of ['light','dark']) {
  test(`MCP consent requires explicit write permission and fits the viewport (${theme})`, async ({page,fixtureApi}) => {
    await fixtureApi; page.__languageOverride='en'; page.__themeOverride=theme;
    await page.route('**/api/mcp/resources',route=>route.fulfill({json:resources}));
    await page.route('**/api/mcp/authorizations/*',route=>route.fulfill({json:{name:'Test AI client',clientId:operationId,
      redirectUri:'https://client.example.test/callback',scopes:['mail.read','mail.send']}}));
    await page.goto(`/ai/mcp/authorize?request=${'a'.repeat(43)}`);
    await expect(page.getByRole('heading',{name:'Connect an AI application'})).toBeVisible();
    await expect(page.getByRole('checkbox',{name:/Read email/})).toBeChecked();
    const send=page.getByRole('checkbox',{name:/Send email and replies/});
    await expect(send).not.toBeChecked(); await send.check(); await expect(send).toBeChecked();
    await expect(page.getByRole('switch',{name:'Require approval in Inboxora before every write'})).toHaveAttribute('aria-checked','true');
    await expect(page.getByText('Read contacts',{exact:true})).toHaveCount(0);
    const dimensions=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width+2);
  });
}

test('MCP mail approval can be edited, executes once and closes the approval tab',async({page,fixtureApi})=>{
  await fixtureApi; page.__languageOverride='en';
  await page.context().route('**/api/auth/me',route=>route.fulfill({json:{user:{id:'e2e-user',username:'e2e@example.test',isAdmin:true}}}));
  await page.context().route('**/api/auth/preferences**',route=>route.fulfill({json:{language:'en',theme:'light',threadedView:false,conversation_list_view_enabled:false,conversation_reader_view_enabled:false,block_remote_images:true}}));
  let approved=false; let postCount=0; let editCount=0;
  let review:Record<string,unknown>={kind:'mail',senderName:'Inboxora Sender',senderEmail:'owner@example.test',to:['recipient@example.test'],cc:[],bcc:['private@example.test'],
    subject:'Synthetic subject',priority:'normal',bodyText:'Synthetic message body',bodyHtml:'',signatureMode:'configured',signatureText:'Synthetic signature',signatureHtml:'',
    attachments:[{filename:'invoice.pdf',bytes:2048,contentType:'application/pdf'}]};
  await page.context().route('**/api/mcp/operations/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(route.request().method()==='POST' && path.endsWith('/edit')) {
      const body=route.request().postDataJSON(); editCount+=1;
      expect(body).toMatchObject({to:['edited@example.test'],cc:[],bcc:['private@example.test'],subject:'Edited subject',bodyChanged:true,signatureChanged:true});
      review={...review,to:body.to,cc:body.cc,bcc:body.bcc,subject:body.subject,bodyText:'Edited body',bodyHtml:'<p>Edited body</p>',signatureMode:'override',signatureText:'Edited signature',signatureHtml:'<p>Edited signature</p>'};
      return route.fulfill({json:{id:operationId,review}});
    }
    if(route.request().method()==='POST') {
      expect(route.request().postDataJSON()).toEqual({approve:true}); postCount+=1; approved=true;
      return route.fulfill({json:{operationId,state:'succeeded',result:{status:200,body:{ok:true}}}});
    }
    return route.fulfill({json:{id:operationId,tool:'send_email',integrationName:'Test client',state:approved?'succeeded':'pending',expiresAt:'2099-01-01T00:00:00Z',
      arguments:{requestId:'exact-request',to:['recipient@example.test'],subject:'Synthetic subject'},review}});
  });
  await page.goto('/');
  const popupPromise=page.waitForEvent('popup');
  await page.evaluate(url=>window.open(url,'_blank'),`/ai/mcp/confirm/${operationId}`);
  const popup=await popupPromise;
  await expect(popup.getByRole('heading',{name:'Review an AI operation'})).toBeVisible();
  await expect(popup.getByText('Inboxora Sender',{exact:true})).toBeVisible();
  await expect(popup.getByText('private@example.test',{exact:true})).toBeVisible();
  await expect(popup.getByText('Configured sender signature',{exact:true})).toBeVisible();
  await expect(popup.getByText('invoice.pdf',{exact:true})).toBeVisible();

  await popup.getByRole('button',{name:'Edit message',exact:true}).click();
  await popup.getByLabel('To').fill('edited@example.test');
  await popup.getByLabel('Subject').fill('Edited subject');
  await popup.getByTestId('mcp-mail-body-editor').locator('[contenteditable=true]').fill('Edited body');
  await popup.getByTestId('mcp-mail-signature-editor').locator('[contenteditable=true]').fill('Edited signature');
  await popup.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(popup.getByText('edited@example.test',{exact:true})).toBeVisible();
  await expect(popup.getByText('Edited subject',{exact:true})).toBeVisible();
  await expect(popup.getByText('Signature overridden for this message',{exact:true})).toBeVisible();
  expect(editCount).toBe(1);

  const approve=popup.getByRole('button',{name:'Approve this operation',exact:true});
  await expect(approve).toBeDisabled();
  await popup.getByRole('checkbox',{name:'I have reviewed this exact operation.'}).check();
  await approve.click();
  await expect.poll(() => popup.isClosed()).toBe(true);
  expect(postCount).toBe(1);
  expect(approved).toBe(true);
  await expect(page.getByTestId('message-list-scroll')).toBeVisible();
});

test('a regular user can create a read-only MCP token without opening administrator AI settings',async({page,fixtureApi})=>{
  await fixtureApi; await setupV3(page);page.__languageOverride='en';
  await page.route('**/api/auth/me',route=>route.fulfill({json:{user:{id:'e2e-user',username:'regular@example.test',isAdmin:false}}}));
  let created:Record<string,unknown>|null=null;
  await page.route('**/api/mcp/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/config'))return route.fulfill({json:{enabled:true,configurationError:false,endpoint:'https://inboxora.example.test/mcp',scopes:['mail.read','calendar.read','contacts.read']}});
    if(path.endsWith('/resources'))return route.fulfill({json:resources});
    if(path.endsWith('/grants'))return route.fulfill({json:{grants:[]}});
    if(path.endsWith('/operations'))return route.fulfill({json:{operations:[]}});
    if(path.endsWith('/tokens')) {created=route.request().postDataJSON();return route.fulfill({json:{token:'synthetic-browser-token-not-a-real-credential'}});}
    return route.fulfill({status:404,json:{error:'Unexpected fixture path'}});
  });
  await page.goto('/'); await expect(page.getByTestId('message-list-scroll')).toBeVisible();
  if((page.viewportSize()?.width||1280)<768)await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if((page.viewportSize()?.width||1280)<768)await page.getByTestId('mobile-settings').click();
  else await page.getByText('Settings',{exact:true}).first().click();
  await page.getByTestId('admin-tab-ai').click();
  const panel=page.getByRole('region',{name:'External AI integrations (MCP)'});
  await expect(panel).toBeVisible();
  await panel.getByRole('button',{name:'Create access token',exact:true}).click();
  await panel.getByLabel('Integration name',{exact:true}).fill('Vibe fixture');
  await panel.getByRole('button',{name:'Create access token',exact:true}).click();
  await expect(panel.getByRole('heading',{name:'Access token created'})).toBeVisible();
  expect(created).toMatchObject({name:'Vibe fixture',scopes:['mail.read','calendar.read','contacts.read'],requireConfirmation:true});
});
