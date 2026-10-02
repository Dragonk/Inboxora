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

test('MCP write approval is disabled until the exact operation is reviewed',async({page,fixtureApi})=>{
  await fixtureApi; page.__languageOverride='en';
  let approved=false;
  await page.route('**/api/mcp/operations/**',async route=>{
    if(route.request().method()==='POST') { expect(route.request().postDataJSON()).toEqual({approve:true});approved=true;return route.fulfill({json:{ok:true}}); }
    return route.fulfill({json:{id:operationId,tool:'send_email',integrationName:'Test client',state:approved?'approved':'pending',expiresAt:'2099-01-01T00:00:00Z',
      arguments:{requestId:'exact-request',to:['recipient@example.test'],subject:'<script>untrusted text</script>'},
      review:{senderEmail:'owner@example.test',to:['recipient@example.test'],bcc:['private@example.test'],body:'Synthetic message'}}});
  });
  await page.goto(`/ai/mcp/confirm/${operationId}`);
  const approve=page.getByRole('button',{name:'Approve this operation',exact:true});
  await expect(approve).toBeDisabled();
  await expect(page.locator('pre').first()).toContainText('private@example.test');
  await page.getByRole('checkbox',{name:'I have reviewed this exact operation.'}).check();
  await approve.click();
  await expect(page.getByText('Approved, but not yet executed.',{exact:false})).toBeVisible();
  expect(approved).toBe(true);
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
