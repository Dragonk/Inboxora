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
  let review:Record<string,unknown>={kind:'mail',senderName:'Inboxora Sender',senderEmail:'owner@example.test',accountId,aliasId:null,to:['recipient@example.test'],cc:[],bcc:['private@example.test'],
    subject:'Synthetic subject',priority:'normal',bodyText:'Synthetic message body',bodyHtml:'',signatureMode:'configured',signatureText:'Synthetic signature',signatureHtml:'',
    attachments:[{index:0,filename:'ai.txt',bytes:13,contentType:'text/plain'}]};
  await page.context().route('**/api/mcp/operations/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(route.request().method()==='GET' && /\/attachments\/\d+$/.test(path)) {
      return route.fulfill({status:200,contentType:'text/plain',body:'AI attachment'});
    }
    if(route.request().method()==='POST' && path.endsWith('/edit')) {
      const body=route.request().postDataJSON(); editCount+=1;
      expect(body).toMatchObject({to:['edited@example.test'],cc:[],bcc:['private@example.test'],subject:'Edited subject',bodyChanged:true,signatureChanged:true,
        keepAttachmentIndexes:[0],newAttachments:[{filename:'user.txt',content:Buffer.from('user attachment').toString('base64'),contentType:'text/plain'}]});
      review={...review,to:body.to,cc:body.cc,bcc:body.bcc,subject:body.subject,bodyText:'Edited body',bodyHtml:'<p>Edited body</p>',
        signatureMode:'override',signatureText:'Edited signature',signatureHtml:'<p>Edited signature</p>',
        attachments:[{index:0,filename:'ai.txt',bytes:13,contentType:'text/plain'},{index:1,filename:'user.txt',bytes:15,contentType:'text/plain'}]};
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
  await expect.poll(() => popup.url()).toContain(`/ai/mcp/confirm/${operationId}`);
  await expect(popup.getByRole('heading',{name:'Review an AI operation'})).toBeVisible();
  await expect(popup.getByText('Inboxora Sender',{exact:true})).toBeVisible();
  await expect(popup.getByText('private@example.test',{exact:true})).toBeVisible();
  await expect(popup.getByText('ai.txt',{exact:true})).toBeVisible();
  await popup.locator("[data-message-detail-attachment='0']").click();
  await expect(popup.getByTestId('attachment-preview-dialog')).toBeVisible();
  await popup.keyboard.press('Escape');
  await expect(popup.getByTestId('attachment-preview-dialog')).toHaveCount(0);

  await popup.getByRole('button',{name:'Edit message',exact:true}).click();
  await expect(popup.getByTitle('Attach file')).toBeVisible();
  await popup.locator('.mcp-compose-editor > input[type=file]').setInputFiles({name:'user.txt',mimeType:'text/plain',buffer:Buffer.from('user attachment')});
  await expect(popup.getByText('user.txt',{exact:true})).toBeVisible();
  await expect(popup.getByRole('button',{name:'Remove ai.txt'})).toBeVisible();
  await popup.getByText('recipient@example.test',{exact:true}).dblclick();
  await popup.getByLabel('To').fill('edited@example.test');
  await popup.getByLabel('Subject').fill('Edited subject');
  await popup.getByTestId('mcp-mail-body-editor').locator('[contenteditable=true]').fill('Edited body');
  await popup.locator('.mcp-compose-signature [contenteditable=true]').fill('Edited signature');
  await popup.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(popup.getByText('edited@example.test',{exact:true})).toBeVisible();
  await expect(popup.getByText('Edited subject',{exact:true})).toBeVisible();
  await expect(popup.getByText('user.txt',{exact:true})).toBeVisible();
  await expect(popup.getByText('ai.txt',{exact:true})).toBeVisible();
  expect(editCount).toBe(1);

  const approve=popup.getByRole('button',{name:'Approve this operation',exact:true});
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect.poll(() => popup.isClosed()).toBe(true);
  expect(postCount).toBe(1);
  expect(approved).toBe(true);
  await expect(page.getByTestId('message-list-scroll')).toBeVisible();
});

test('rejecting an MCP mail closes the approval tab and performs no send',async({page,fixtureApi})=>{
  await fixtureApi; page.__languageOverride='en';
  await page.context().route('**/api/auth/me',route=>route.fulfill({json:{user:{id:'e2e-user',username:'e2e@example.test',isAdmin:true}}}));
  await page.context().route('**/api/auth/preferences**',route=>route.fulfill({json:{language:'en',theme:'light'}}));
  let denied=0;
  await page.context().route('**/api/mcp/operations/**',route=>{
    if(route.request().method()==='POST'){
      expect(route.request().postDataJSON()).toEqual({approve:false}); denied+=1;
      return route.fulfill({json:{operationId,state:'denied'}});
    }
    return route.fulfill({json:{id:operationId,tool:'send_email',integrationName:'Test client',state:'pending',expiresAt:'2099-01-01T00:00:00Z',
      arguments:{requestId:'reject-me'},review:{kind:'mail',senderEmail:'owner@example.test',senderName:'Owner',accountId,to:['recipient@example.test'],cc:[],bcc:[],
      subject:'Reject this',bodyText:'Nothing should be sent',bodyHtml:'',signatureText:'',signatureHtml:'',attachments:[]}}});
  });
  await page.goto('/');
  const popupPromise=page.waitForEvent('popup');
  await page.evaluate(url=>window.open(url,'_blank'),'/ai/mcp/confirm/'+operationId);
  const popup=await popupPromise;
  await expect(popup.getByRole('button',{name:'Deny',exact:true})).toBeVisible();
  await popup.getByRole('button',{name:'Deny',exact:true}).click();
  await expect.poll(()=>popup.isClosed()).toBe(true);
  expect(denied).toBe(1);
});

test('AI Features groups assistant, actions and MCP; a regular user can edit MCP permissions and create a token',async({page,fixtureApi})=>{
  await fixtureApi; await setupV3(page);page.__languageOverride='en';
  await page.route('**/api/auth/me',route=>route.fulfill({json:{user:{id:'e2e-user',username:'regular@example.test',isAdmin:false}}}));
  const grantId='33333333-3333-4333-8333-333333333333';
  const grant={id:grantId,name:'Existing client',client_id:null,scopes:['mail.read'],restrictions:{accounts:[accountId],folders:null,calendars:[],addressBooks:[]},require_confirmation:true,
    created_at:'2026-10-01T10:00:00Z',last_used_at:null,expires_at:'2099-01-01T00:00:00Z',revoked_at:null};
  let created:Record<string,unknown>|null=null; let permissionEdit:Record<string,unknown>|null=null;
  await page.route('**/api/mcp/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/config'))return route.fulfill({json:{enabled:true,configurationError:false,endpoint:'https://inboxora.example.test/mcp',scopes:['mail.read','mail.send','calendar.read','contacts.read']}});
    if(path.endsWith('/resources'))return route.fulfill({json:resources});
    if(path.endsWith('/grants') && route.request().method()==='GET')return route.fulfill({json:{grants:[grant]}});
    if(path.endsWith(`/grants/${grantId}`) && route.request().method()==='POST') {permissionEdit=route.request().postDataJSON();return route.fulfill({json:{grant:{...grant,...permissionEdit}}});}
    if(path.endsWith('/operations'))return route.fulfill({json:{operations:[]}});
    if(path.endsWith('/tokens')) {created=route.request().postDataJSON();return route.fulfill({json:{token:'synthetic-browser-token-not-a-real-credential'}});}
    return route.fulfill({status:404,json:{error:'Unexpected fixture path'}});
  });
  await page.goto('/'); await expect(page.getByTestId('message-list-scroll')).toBeVisible();
  if((page.viewportSize()?.width||1280)<768)await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if((page.viewportSize()?.width||1280)<768)await page.getByTestId('mobile-settings').click();
  else await page.getByText('Settings',{exact:true}).first().click();
  await page.getByTestId('admin-tab-ai-features').click();
  await expect(page.getByRole('button',{name:'AI Assistant',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'AI Actions',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'External AI integrations (MCP)',exact:true}).click();
  const panel=page.getByRole('region',{name:'External AI integrations (MCP)'});
  await expect(panel).toBeVisible();

  await panel.getByRole('button',{name:'Manage permissions',exact:true}).click();
  const send=panel.getByRole('checkbox',{name:/Send email and replies/});
  await expect(send).not.toBeChecked(); await send.check();
  await panel.getByRole('button',{name:'Save permissions',exact:true}).click();
  expect(permissionEdit).toMatchObject({scopes:['mail.read','mail.send'],requireConfirmation:true,restrictions:{accounts:[accountId]}});

  await panel.getByRole('button',{name:'Create access token',exact:true}).click();
  await panel.getByLabel('Integration name',{exact:true}).fill('Vibe fixture');
  await panel.getByRole('button',{name:'Create access token',exact:true}).click();
  await expect(panel.getByRole('heading',{name:'Access token created'})).toBeVisible();
  expect(created).toMatchObject({name:'Vibe fixture',scopes:['mail.read','calendar.read','contacts.read'],requireConfirmation:true});
});
