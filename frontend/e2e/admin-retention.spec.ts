import {test,expect} from './fixtures.ts';
const defaults={mail_body_cache_days:30,dav_history_days:30,dav_history_max_entries:10000,auth_log_days:90,conversation_audit_days:30,resolved_ingest_error_days:7,completed_outbox_payload_days:7};
const fields=Object.fromEntries(Object.entries(defaults).map(([k,v])=>[k,{default:v,min:k==='mail_body_cache_days'?0:k==='dav_history_max_entries'?100:1,max:k==='dav_history_max_entries'?100000:3650}]));
async function open(page){
  if(page.viewportSize().width<768)await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId('sidebar-user-menu').click();
  if(page.viewportSize().width<768)await page.getByTestId('mobile-settings').click();
  else await page.getByText(/^Ustawienia$|^Settings$/i).first().click();
  await page.getByTestId('admin-tab-performance').click();
}

test('global retention form saves a week, a month and unlimited without editing unrelated settings',async({page,fixtureApi})=>{
  await fixtureApi;const values={...defaults},writes=[];
  await page.route('**/api/admin/retention',route=>{
    if(route.request().method()==='PATCH'){const body=route.request().postDataJSON();Object.assign(values,body);writes.push(body);return route.fulfill({json:{ok:true}});}
    return route.fulfill({json:{values,fields,dataMaintenancePaused:false}});
  });
  await page.goto('/');await open(page);
  const section=page.getByTestId('storage-retention-settings');
  const input=page.getByTestId('retention-mail_body_cache_days');
  const save=section.getByRole('button',{name:/^Zapisz$|^Save$/});
  await expect(input).toHaveValue('30');await expect(save).toBeDisabled();
  await expect(page.getByTestId('retention-cache-safety')).toContainText(/Wiadomości pozostają|Messages stay/);
  await input.fill('7');await page.getByTestId('retention-auth_log_days').fill('14');await save.click();
  await expect(page.getByTestId('retention-saved')).toBeVisible();expect(writes[0]).toEqual({mail_body_cache_days:7,auth_log_days:14});
  await page.getByTestId('admin-tab-appearance').click();await page.getByTestId('admin-tab-performance').click();
  await expect(input).toHaveValue('7');await input.fill('30');await save.click();await expect(page.getByTestId('retention-saved')).toBeVisible();
  await input.fill('0');await save.click();await expect(page.getByTestId('retention-saved')).toBeVisible();expect(writes[2]).toEqual({mail_body_cache_days:0});
  await page.getByTestId('retention-dav_history_days').fill('0');await expect(save).toBeDisabled();
  await page.getByTestId('retention-dav_history_days').fill('30');await input.fill('7.5');await expect(save).toBeDisabled();
});

test('failed loads and saves are retryable and a paused data worker is explained',async({page,fixtureApi})=>{
  await fixtureApi;let reads=0,writes=0;
  await page.route('**/api/admin/retention',route=>{
    if(route.request().method()==='PATCH'){writes++;return writes===1?route.fulfill({status:503,json:{error:'Temporary failure'}}):route.fulfill({json:{ok:true}});}
    reads++;return reads===1?route.fulfill({status:503,json:{error:'Temporary failure'}}):route.fulfill({json:{values:defaults,fields,dataMaintenancePaused:true}});
  });
  await page.goto('/');await open(page);const section=page.getByTestId('storage-retention-settings');
  await expect(section.getByRole('alert')).toBeVisible();await section.getByRole('button',{name:/Spróbuj ponownie|Retry/i}).click();
  await expect(section).toContainText('STORAGE_MAINTENANCE_ENABLED=false');
  await page.getByTestId('retention-mail_body_cache_days').fill('7');
  const save=section.getByRole('button',{name:/^Zapisz$|^Save$/});await save.click();await expect(section.getByRole('alert')).toBeVisible();
  await save.click();await expect(page.getByTestId('retention-saved')).toBeVisible();expect(writes).toBe(2);
});

test('late retention save cannot mark a newly mounted editor as saved',async({page,fixtureApi})=>{
  await fixtureApi;let finish;let pending=false;const gate=new Promise<void>(resolve=>{finish=resolve;});
  await page.route('**/api/admin/retention',async route=>{
    if(route.request().method()==='PATCH'){pending=true;await gate;return route.fulfill({json:{ok:true}});}
    return route.fulfill({json:{values:defaults,fields,dataMaintenancePaused:false}});
  });
  await page.goto('/');await open(page);
  const input=page.getByTestId('retention-mail_body_cache_days');
  const save=page.getByTestId('storage-retention-settings').getByRole('button',{name:/^Zapisz$|^Save$/});
  await input.fill('7');await save.click();await expect.poll(()=>pending).toBe(true);
  await page.getByTestId('admin-tab-appearance').click();await page.getByTestId('admin-tab-performance').click();
  await expect(input).toHaveValue('30');await input.fill('7');await expect(save).toBeEnabled();
  const done=page.waitForResponse(r=>r.url().includes('/api/admin/retention')&&r.request().method()==='PATCH');finish();await(await done).finished();
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(page.getByTestId('retention-saved')).toHaveCount(0);await expect(save).toBeEnabled();await expect(input).toHaveValue('7');
});
