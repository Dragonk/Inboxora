import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures.ts';
import { setupV3, navigateModule } from './v3-fixtures.ts';

async function openEnglishSettings(page: Page) {
  await expect(page.getByTestId('message-list-scroll')).toBeVisible();
  if ((page.viewportSize()?.width || 1280) < 768) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if ((page.viewportSize()?.width || 1280) < 768) await page.getByTestId('mobile-settings').click();
  else await page.getByText('Settings',{exact:true}).first().click();
  await expect(page.locator('.admin-panel')).toBeVisible({timeout:15000});
}
async function noHorizontalOverflow(page: Page) {
  const dimensions=await page.locator('.admin-panel').evaluate(panel=>({width:panel.clientWidth,scroll:panel.scrollWidth}));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width+2);
}
const mailbox={id:'a0000000-0000-4000-8000-000000000001',name:'Microsoft work',email_address:'primary@example.test',enabled:true,mail_transport:'microsoft_graph',
  aliases:[{id:'b0000000-0000-4000-8000-000000000001',email:'alias-one@example.test',name:'First'},
    {id:'b0000000-0000-4000-8000-000000000002',email:'alias-two@example.test',name:'Second'}]};

test('calendar defaults persist both Microsoft aliases and calendar display stays under Appearance',async({page,fixtureApi})=>{
  await fixtureApi;await setupV3(page);page.__languageOverride='en';
  let preferences:Record<string,unknown>={language:'en',theme:'light',calendarShowAgenda:true};
  await page.route('**/api/auth/preferences**',route=>{
    if(route.request().method()==='PATCH') {preferences={...preferences,...route.request().postDataJSON()};return route.fulfill({json:{ok:true}});}
    return route.fulfill({json:preferences});
  });
  await page.route('**/api/accounts',route=>route.fulfill({json:[mailbox]}));
  await page.goto('/');await openEnglishSettings(page);
  const panel=page.locator('.admin-panel');
  const firstNav=await panel.locator('[data-testid^="admin-tab-"]').evaluateAll(elements=>elements.slice(0,3).map(element=>element.getAttribute('data-testid')));
  expect(firstNav).toEqual(['admin-tab-accounts','admin-tab-calendar','admin-tab-contacts']);
  await expect(panel.getByTestId('admin-tab-calendar-appearance')).toHaveCount(0);
  await panel.getByTestId('admin-tab-calendar').click();
  const sender=page.getByTestId('calendar-invite-account-setting');
  await expect(sender.locator('option')).toHaveCount(4);
  for(const alias of mailbox.aliases){
    await sender.selectOption(`${mailbox.id}:${alias.id}`);
    await expect.poll(()=>preferences.calendarInviteAliasId).toBe(alias.id);
    expect(preferences.calendarInviteAccountId).toBe(mailbox.id);
    await panel.getByTestId('admin-tab-contacts').click();await panel.getByTestId('admin-tab-calendar').click();
    await expect(sender).toHaveValue(`${mailbox.id}:${alias.id}`);
  }
  await panel.getByTestId('admin-tab-appearance').click();
  await expect(panel.locator('.admin-subtab')).toHaveText(['Theme','Layout','Attachment warnings','Calendar','Language & Font']);
  await panel.locator('.admin-subtab').filter({hasText:/^Calendar$/}).click();
  const agenda=page.getByTestId('calendar-agenda-setting');
  await expect(agenda).toHaveAttribute('role','group');
  await agenda.getByRole('button',{name:'Hide',exact:true}).click();
  await expect.poll(()=>preferences.calendarShowAgenda).toBe(false);
  await expect(page.getByTestId('calendar-invite-account-setting')).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.reload();await openEnglishSettings(page);await panel.getByTestId('admin-tab-calendar').click();
  await expect(sender).toHaveValue(`${mailbox.id}:${mailbox.aliases[1].id}`);
  await sender.selectOption('');await expect.poll(()=>preferences.calendarInviteAliasId).toBe('');
});

test('resource editors are inline, keyboard reachable and use row deletion',async({page,fixtureApi},testInfo)=>{
  await fixtureApi;await setupV3(page);page.__languageOverride='en';await page.goto('/');await openEnglishSettings(page);
  const panel=page.locator('.admin-panel');
  for(const module of ['calendar','contacts']) {
    await panel.getByTestId(`admin-tab-${module}`).click();
    const resource=panel.locator('.au-resource').first();await expect(resource).toBeVisible();
    const actions=resource.locator('.au-resource-actions');await expect(actions.getByRole('button')).toHaveCount(2);
    await actions.getByRole('button').first().click();
    const editor=panel.locator('.au-inline-editor');await expect(editor).toBeVisible();
    await expect(editor.getByRole('heading')).toBeFocused();
    await expect(editor.getByRole('heading')).toHaveCSS('outline-style','solid');
    await expect(editor.locator('input').first()).toBeVisible();
    await expect(panel.locator('.ui-dialog-body')).toHaveCount(0);
    await expect(panel.locator('.au-resource')).toHaveCount(0);
    await noHorizontalOverflow(page);
    const widths=await editor.locator('input,select').evaluateAll(elements=>elements.filter(element=>element.getClientRects().length).map(element=>({left:element.getBoundingClientRect().left,right:element.getBoundingClientRect().right})));
    for(const box of widths){expect(box.left).toBeGreaterThanOrEqual(0);expect(box.right).toBeLessThanOrEqual((page.viewportSize()?.width||1280)+1);}
    await page.screenshot({path:testInfo.outputPath(`${module}-inline-editor.png`)});
    await editor.getByRole('button',{name:'Back',exact:true}).click();await expect(resource).toBeVisible();
  }
});

test('DAV creation discovers capabilities once and saves the chosen services without opening another modal',async({page,fixtureApi})=>{
  await fixtureApi;page.__languageOverride='en';
  const writes:Record<string,unknown>[]=[];let discoveries=0;
  await page.route('**/api/dav-accounts/discover',route=>{discoveries++;return route.fulfill({json:{calendarSupported:true,contactsSupported:true,calendarCount:2,contactBookCount:1}});});
  await page.route('**/api/dav-accounts',route=>{
    if(route.request().method()==='POST'){const input=route.request().postDataJSON();writes.push(input);return route.fulfill({status:201,json:{...input,id:'created-dav',revision:'2026-09-29T12:00:00.000Z'}});}
    return route.fulfill({json:{accounts:writes.map(input=>({id:'created-dav',name:input.name,serverUrl:input.serverUrl,username:input.username,calendarEnabled:input.calendarEnabled,contactsEnabled:input.contactsEnabled,calendarSupported:true,contactsSupported:true,intervalMin:input.intervalMin,revision:'2026-09-29T12:00:00.000Z'}))}});
  });
  await page.goto('/');await openEnglishSettings(page);
  const panel=page.locator('.admin-panel');await panel.getByRole('button',{name:/^Add account$/}).click();
  await panel.getByTestId('add-account-choice-dav').click();
  const editor=page.getByTestId('dav-account-editor');await expect(editor).toBeVisible();
  await editor.getByLabel('Connection name',{exact:true}).fill('Private DAV');
  await editor.getByLabel('Server address',{exact:true}).fill('https://dav.example.test/remote.php/dav/');
  await editor.getByLabel('Username',{exact:true}).fill('owner');
  await editor.getByLabel('Password',{exact:true}).fill('test-only-password');
  await editor.getByRole('button',{name:'Detect services',exact:true}).click();
  await expect(editor.getByRole('switch',{name:'Contacts',exact:true})).toHaveAttribute('aria-checked','true');
  await editor.getByRole('switch',{name:'Contacts',exact:true}).click();
  expect(discoveries).toBe(1);
  await editor.getByRole('button',{name:'Save',exact:true}).click();
  await expect.poll(()=>writes.length).toBe(1);
  expect(writes[0]).toMatchObject({name:'Private DAV',calendarEnabled:true,contactsEnabled:false,intervalMin:60});
  await expect(editor).toHaveCount(0);await expect(panel.getByTestId('dav-accounts')).toBeVisible();
});

test('account tabs preserve a folder-mapping draft and show native indexing diagnostics',async({page,fixtureApi})=>{
  await fixtureApi;page.__languageOverride='en';let folderReads=0;
  await page.route('**/api/accounts',route=>route.fulfill({json:[mailbox]}));
  await page.route(`**/api/accounts/${mailbox.id}/provider-status`,route=>route.fulfill({json:{accountId:mailbox.id,provider:'microsoft',mail:{native:true,transport:'microsoft_graph',authorized:true},calendar:null,contacts:null,diagnostics:null}}));
  await page.route(`**/api/accounts/${mailbox.id}/folders`,route=>{folderReads++;return route.fulfill({json:[{path:'Sent',name:'Sent'},{path:'Archive',name:'Archive'}]});});
  await page.goto('/');await openEnglishSettings(page);
  const panel=page.locator('.admin-panel');await panel.getByRole('button',{name:'Edit',exact:true}).click();
  await expect(panel.getByRole('tab')).toHaveText(['General','Services','Folder mappings','Aliases','Diagnostics']);
  await panel.getByRole('tab',{name:'Folder mappings',exact:true}).click();
  const select=panel.locator('select:visible').first();await expect(select).toBeVisible();
  await select.selectOption('Archive');
  await panel.getByRole('tab',{name:'Aliases',exact:true}).click();
  await expect(panel.getByText('alias-one@example.test',{exact:true})).toBeVisible();
  await panel.getByRole('tab',{name:'Folder mappings',exact:true}).click();
  await expect(select).toHaveValue('Archive');expect(folderReads).toBe(1);
  await panel.getByRole('tab',{name:'Diagnostics',exact:true}).click();
  const diagnostics=page.getByTestId('mail-index-diagnostics');
  await expect(diagnostics.getByRole('button',{name:'Re-index for search',exact:true})).toBeVisible();
  await expect(diagnostics).toContainText('Last successful folder sync');await expect(diagnostics).toContainText('12');
  await noHorizontalOverflow(page);
});

test('mobile contact settings share the books toolbar instead of adding a row',async({page,fixtureApi})=>{
  await fixtureApi;await setupV3(page);page.__languageOverride='en';await page.goto('/');await navigateModule(page,'contacts');
  if((page.viewportSize()?.width||1280)>=768){await expect(page.getByTestId('contacts-manage-books')).toBeVisible();return;}
  const settings=page.getByTestId('contacts-manage-books-mobile');const books=page.getByTestId('contacts-address-books');
  await expect(settings).toBeVisible();await expect(page.getByTestId('contacts-manage-books')).toHaveCount(0);
  const settingsBox=await settings.boundingBox();const booksBox=await books.boundingBox();
  expect(settingsBox).not.toBeNull();expect(booksBox).not.toBeNull();
  expect(Math.abs(settingsBox!.y-booksBox!.y)).toBeLessThan(3);
  await settings.click();await expect(page.getByTestId('contacts-books-manager')).toBeVisible();
});

// Each supported language is exercised in both palettes. Geometry is checked
// rather than baking text widths or a single theme's colors into a screenshot.
for(const language of ['en','pl','de','cs','fr','es','it','ru','zhCN']) for(const theme of ['ink','dark_ink']) {
  test(`calendar settings remain localized and contained: ${language}/${theme}`,async({page,fixtureApi},testInfo)=>{
    await fixtureApi;page.__languageOverride=language;page.__themeOverride=theme;
    page.__preferencesOverride={themeMode:theme==='dark_ink'?'dark':'light',themeLight:'ink',themeDark:'dark_ink'};
    const dictionary=JSON.parse(readFileSync(new URL(`../src/locales/${language}.json`,import.meta.url),'utf8'));
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto('/');
    await expect(page.getByTestId('message-list-scroll')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-mailflow-theme',theme);
    if((page.viewportSize()?.width||1280)<768)await page.getByTestId('mobile-topbar-menu').click();
    await page.getByTestId('sidebar-user-menu').click();
    if((page.viewportSize()?.width||1280)<768)await page.getByTestId('mobile-settings').click();
    else await page.getByText(dictionary.sidebar.settings,{exact:true}).first().click();
    const panel=page.locator('.admin-panel');await panel.getByTestId('admin-tab-appearance').click();
    await panel.locator('.admin-subtab').filter({hasText:new RegExp(`^${dictionary.calendar.title}$`)}).click();
    await expect(page.getByTestId('calendar-agenda-setting')).toContainText(dictionary.calendar.show);
    await expect(page.getByTestId('calendar-agenda-setting')).toContainText(dictionary.calendar.hide);
    await noHorizontalOverflow(page);
    const color=await page.getByTestId('calendar-settings').evaluate(element=>getComputedStyle(element).color);
    expect(color).not.toBe('rgba(0, 0, 0, 0)');expect(errors).toEqual([]);
    await page.screenshot({path:testInfo.outputPath(`calendar-${language}-${theme}.png`)});
  });
}


test('a contact source settings link filters resources to that source',async({page,fixtureApi})=>{
  await fixtureApi;await setupV3(page);page.__languageOverride='en';
  const books=[{id:'local-book',name:'Local contacts',source:'local',visible:true},
    {id:'remote-book',name:'Private DAV contacts',source:'carddav',dav_source_id:'dav-source',source_label:'Private DAV',visible:true}];
  await page.route('**/api/contacts/address-books{,?*}',route=>route.fulfill({json:{addressBooks:books}}));
  await page.goto('/');await navigateModule(page,'contacts');
  await page.getByTestId((page.viewportSize()?.width||1280)<768?'contacts-address-books':'contacts-books-trigger').click();
  const group=page.locator('[data-source-id="carddav:source:dav-source"]');await expect(group).toBeVisible();
  await group.locator('.au-source-heading .au-icon-button').click();
  await page.getByRole('button',{name:'Account settings',exact:true}).click();
  const manager=page.getByTestId('contacts-books-manager');await expect(manager).toBeVisible();
  await expect(manager.locator('[data-resource-id="remote-book"]')).toBeVisible();
  await expect(manager.locator('[data-resource-id="local-book"]')).toHaveCount(0);
});

test('attachment warning threshold persists without changing provider limits', async ({ page, fixtureApi }) => {
  await fixtureApi; await setupV3(page); page.__languageOverride = 'en';
  let preferences: Record<string, unknown> = { language: 'en', theme: 'light', attachmentWarningMiB: 20 };
  const writes: Record<string, unknown>[] = [];
  await page.route('**/api/auth/preferences**', route => {
    if (route.request().method() === 'PATCH') {
      const changes = route.request().postDataJSON(); writes.push(changes);
      preferences = { ...preferences, ...changes }; return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: preferences });
  });
  const openWarnings = async () => {
    await openEnglishSettings(page);
    await page.getByTestId('admin-tab-appearance').click();
    await page.locator('.admin-subtab').filter({ hasText: /^Attachment warnings$/ }).click();
  };
  await page.goto('/'); await openWarnings();
  const section = page.locator('.account-ui-section').filter({ has: page.getByRole('heading', { name: 'Attachment warnings', exact: true }) });
  const value = section.getByRole('spinbutton', { name: 'Warning threshold (MiB)', exact: true });
  await expect(value).toHaveValue('20');
  await value.fill('3'); await section.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => preferences.attachmentWarningMiB).toBe(3);
  await value.fill('-1'); await expect(section.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await section.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(value).toHaveValue('3');
  await page.reload(); await openWarnings(); await expect(value).toHaveValue('3');
  await value.fill('0'); await section.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => preferences.attachmentWarningMiB).toBe(0);
  expect(writes.filter(write => 'attachmentWarningMiB' in write)).toEqual([{ attachmentWarningMiB: 3 }, { attachmentWarningMiB: 0 }]);
  await noHorizontalOverflow(page);
});
