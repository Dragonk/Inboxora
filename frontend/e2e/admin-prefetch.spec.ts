import {test,expect} from './fixtures.ts';

async function openSettings(page) {
  if(page.viewportSize().width<768)await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if(page.viewportSize().width<768)await page.getByTestId('mobile-settings').click();
  else await page.getByText(/^Ustawienia$|^Settings$/i).first().click();
}
async function openPrefetch(page) {
  await openSettings(page);
  await page.getByTestId('admin-tab-performance').click();
}
const payload=(limit,disabledByEnvironment=false)=>({settings:{mail_body_prefetch_limit:String(limit)},mailPrefetch:{defaultLimit:25,maxLimit:100,disabledByEnvironment}});

test('administrator can save 30, disable with 0 and reload the persisted setting',async({page,fixtureApi})=>{
  await fixtureApi;let limit=25;const writes=[];
  await page.route('**/api/admin/settings',async route=>{
    if(route.request().method()==='PATCH') {const body=route.request().postDataJSON();writes.push(body);limit=body.mail_body_prefetch_limit;return route.fulfill({json:{ok:true}});}
    return route.fulfill({json:payload(limit)});
  });
  await page.goto('/');await openPrefetch(page);
  const input=page.getByTestId('mail-prefetch-limit');const save=page.getByTestId('mail-prefetch-settings').getByRole('button',{name:/^Zapisz$|^Save$/});
  await expect(input).toHaveValue('25');await expect(save).toBeDisabled();
  await input.fill('101');await expect(save).toBeDisabled();await expect(input).toHaveAttribute('aria-invalid','true');
  await input.fill('30');await save.click();await expect(page.getByTestId('mail-prefetch-saved')).toBeVisible();
  expect(writes).toEqual([{mail_body_prefetch_limit:30}]);
  await page.getByTestId('admin-tab-appearance').click();await page.getByTestId('admin-tab-performance').click();
  await expect(input).toHaveValue('30');
  await input.fill('0');await save.click();await expect(page.getByTestId('mail-prefetch-saved')).toBeVisible();
  expect(writes).toEqual([{mail_body_prefetch_limit:30},{mail_body_prefetch_limit:0}]);
  await page.screenshot({path:`artifacts/admin-prefetch-${page.viewportSize().width}.png`});
});

test('prefetch settings are hidden from a non-administrator',async({page,fixtureApi})=>{
  await fixtureApi;let requests=0;
  await page.route('**/api/auth/me',route=>route.fulfill({json:{user:{id:'e2e-user',username:'member@example.test',isAdmin:false}}}));
  await page.route('**/api/admin/settings',route=>{requests++;return route.fulfill({status:403,json:{error:'Admin access required'}});});
  await page.goto('/');await openSettings(page);
  await expect(page.getByTestId('admin-tab-performance')).toHaveCount(0);
  await expect(page.getByTestId('mail-prefetch-settings')).toHaveCount(0);
  expect(requests).toBe(0);
});

test('load/save failures remain retryable and the server override is explicit',async({page,fixtureApi})=>{
  await fixtureApi;let loads=0,writes=0;
  await page.route('**/api/admin/settings',route=>{
    if(route.request().method()==='PATCH') {writes++;return writes===1?route.fulfill({status:503,json:{error:'Temporary failure'}}):route.fulfill({json:{ok:true}});}
    loads++;return loads===1?route.fulfill({status:503,json:{error:'Temporary failure'}}):route.fulfill({json:payload(25,true)});
  });
  await page.goto('/');await openPrefetch(page);
  const section=page.getByTestId('mail-prefetch-settings');
  await expect(section.getByRole('alert')).toBeVisible();
  await section.getByRole('button',{name:/Spróbuj ponownie|Retry/i}).click();
  await expect(page.getByTestId('mail-prefetch-limit')).toHaveValue('25');
  await expect(page.getByTestId('mail-prefetch-environment-off')).toContainText('MAIL_BODY_PREFETCH=off');
  await page.getByTestId('mail-prefetch-limit').fill('20');
  await section.getByRole('button',{name:/^Zapisz$|^Save$/}).click();
  await expect(section.getByRole('alert')).toBeVisible();
  await section.getByRole('button',{name:/^Zapisz$|^Save$/}).click();
  await expect(page.getByTestId('mail-prefetch-saved')).toBeVisible();expect(writes).toBe(2);
});

test('an old pending save cannot update a remounted settings editor',async({page,fixtureApi})=>{
  await fixtureApi;let pending;let release;const done=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/admin/settings',async route=>{
    if(route.request().method()==='PATCH') {pending=true;await done;return route.fulfill({json:{ok:true}});}
    return route.fulfill({json:payload(25)});
  });
  await page.goto('/');await openPrefetch(page);
  await page.getByTestId('mail-prefetch-limit').fill('30');
  await page.getByTestId('mail-prefetch-settings').getByRole('button',{name:/^Zapisz$|^Save$/}).click();
  await expect.poll(()=>pending).toBe(true);
  await page.getByTestId('admin-tab-appearance').click();await page.getByTestId('admin-tab-performance').click();
  await expect(page.getByTestId('mail-prefetch-limit')).toHaveValue('25');
  release();
  // A fresh edit after the old response should not inherit "saved" or old values.
  await page.getByTestId('mail-prefetch-limit').fill('20');
  await expect(page.getByTestId('mail-prefetch-saved')).toHaveCount(0);
  await expect(page.getByTestId('mail-prefetch-limit')).toHaveValue('20');
});
