const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { catalog, normalizeLanguage, text } = require('./i18n.cjs');
const { generate, languageDirectories } = require('../scripts/generate-native-locales.cjs');

test('native catalogs, browser assets and Android resources are complete and current', () => {
  assert.deepEqual(Object.keys(catalog).sort(), Object.keys(languageDirectories).sort());
  for (const language of Object.keys(catalog)) {
    assert.deepEqual(Object.keys(catalog[language]).sort(), Object.keys(catalog.en).sort());
    for (const [key, value] of Object.entries(catalog[language])) assert.ok(value.trim(), `${language}:${key}`);
  }
  generate(true);
});
test('native labels follow the selected supported language, including region tags', () => {
  for (const [language,expected] of [['pl-PL','pl'],['cs-CZ','cs'],['zh-CN','zhCN'],['zhCN','zhCN'],['de_DE','de'],['fr','fr'],['pt-BR','en'],[null,'en']]) {
    assert.equal(normalizeLanguage(language),expected);
  }
  assert.equal(text('pl','reply'),'Odpowiedz');
  assert.equal(text('pl','delete'),'Usuń');
  assert.equal(text('pl','changeHost'),'Zmień serwer');
  assert.equal(text('de','calendar'),'Kalender');
  assert.equal(text('fr','contacts'), catalog.fr.contacts);
  assert.equal(text('pl','newMailCount',{count:5}), 'Nowe wiadomości: 5');
});
test('offline browser and desktop use the same native translations without executing inserted values', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'locales.js'),'utf8'),context);
  const browser = context.InboxoraNativeI18n;
  for (const language of Object.keys(catalog)) for (const key of Object.keys(catalog.en)) {
    assert.equal(browser.text(language,key,{count:5,name:'Inboxora'}),text(language,key,{count:5,name:'Inboxora'}));
  }
  assert.equal(browser.text('en','about',{name:'<script>bad()</script>'}),'About <script>bad()</script>');
  assert.match(fs.readFileSync(path.join(__dirname,'setup-i18n.js'),'utf8'), /element\.textContent = i18n\.text/);
});
test('desktop locale IPC is owned by the configured main frame and refreshes all native launch surfaces', () => {
  const main = fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');
  const setter = main.slice(main.indexOf("ipcMain.handle('inboxora:language:set'"), main.indexOf("ipcMain.handle('inboxora:getHost'"));
  assert.match(setter,/assertTrustedAppSender\(event\)/);
  assert.match(setter,/event\.senderFrame !== mainWindow\.webContents\.mainFrame/);
  assert.match(setter,/setupMenu\(\); refreshTrayMenu\(\); setupDockMenu\(\); setupTaskbarTasks\(\)/);
  for (const route of ['new-mail','open-calendar','open-contacts','sync']) assert.ok(main.includes(`'${route}'`));
  assert.match(main,/id: randomUUID\(\)/);
});

test('installed Linux launchers contain translated Compose, Calendar and Contacts actions', async () => {
  const pkg = require('../../package.json');
  const { LinuxTargetHelper } = require('app-builder-lib/out/targets/LinuxTargetHelper');
  const packager = { appInfo: { productName: 'Inboxora', sanitizedProductName: 'Inboxora' }, executableName: 'Inboxora',
    info: { metadata: pkg }, config: pkg.build, platformSpecificBuildOptions: pkg.build.linux, fileAssociations: [] };
  const desktop = await LinuxTargetHelper.prototype.computeDesktopEntry.call({ packager, getDescription: () => '' }, pkg.build.linux);
  assert.match(desktop, /\nActions=Compose;Calendar;Contacts;\n/);
  for (const [action,key,route] of [['Compose','compose','new-mail'],['Calendar','calendar','open-calendar'],['Contacts','contacts','open-contacts']]) {
    const section = desktop.split(`[Desktop Action ${action}]\n`)[1].split('\n[')[0];
    assert.ok(section.includes(`Exec=/opt/Inboxora/Inboxora --inboxora-action=${route}\n`));
    for (const language of Object.keys(catalog)) {
      assert.ok(section.includes(`Name[${language === 'zhCN' ? 'zh_CN' : language}]=${catalog[language][key]}\n`), `${language}:${key}`);
    }
  }
});


test('Android keeps only product identity and URI identifiers non-translatable', () => {
  const source = fs.readFileSync(path.join(__dirname, '../android/app/src/main/res/values/strings.xml'), 'utf8');
  const expected = { app_name:'Inboxora', title_activity_main:'Inboxora', package_name:'io.github.dragonk.inboxora', custom_url_scheme:'io.github.dragonk.inboxora' };
  const entries = [...source.matchAll(/<string name="([^"]+)" translatable="false">([^<]+)<\/string>/g)];
  assert.deepEqual(Object.fromEntries(entries.map(([,key,value]) => [key,value])), expected);
  for (const directory of Object.values(languageDirectories)) {
    const translations = fs.readFileSync(path.join(__dirname, '../android/app/src/main/res', directory, 'native_strings.xml'), 'utf8');
    assert.ok(!translations.includes('translatable="false"'), `${directory}: actual labels must remain translated`);
  }
});

for (const late of [false, true]) {
  test(`native setup applies ${late ? 'late' : 'early'} language and theme exactly once`, async () => {
    let resolveNative;
    const request = new Promise(resolve => { resolveNative = resolve; });
    let timeout; let applied = 0;
    const styles = new Map();
    const element = { dataset: { nativeI18n: 'changeHost' }, set textContent(value) { applied++; this.value = value; } };
    const document = { documentElement: { lang: '', style: { setProperty: (key,value) => styles.set(key,value) } },
      querySelectorAll: () => [element], body: { dataset: {} }, title: '' };
    const window = { InboxoraNativeI18n: { normalize: normalizeLanguage, text }, inboxoraNative: { getLanguage: () => request } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'setup-i18n.js'),'utf8'), {
      window, document, navigator: { language: 'en' }, setTimeout: (callback,ms) => { assert.equal(ms,1500); timeout = callback; },
    });
    assert.equal(element.value, catalog.en.changeHost);
    if (late) { timeout(); await window.nativeLanguageReady; assert.equal(document.documentElement.lang,'en'); }
    resolveNative({ language:'pl', theme:{color:'#101113',symbolColor:'#f4f5f7'} });
    await request; await new Promise(resolve => setImmediate(resolve));
    await window.nativeLanguageReady;
    assert.equal(document.documentElement.lang, 'pl');
    assert.equal(element.value, 'Zmień serwer');
    assert.equal(applied, 2);
    assert.equal(styles.get('--native-background'), '#101113');
    assert.equal(styles.get('--native-foreground'), '#f4f5f7');
    assert.equal(styles.get('--native-input'), '#101113');
    timeout(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(applied, 2);
  });
}

test('macOS host-change menu is labelled for its real action', () => {
  const main = fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');
  assert.match(main, /label: nt\('changeHost'\),[\s\S]{0,180}changeInboxoraHost/);
  assert.doesNotMatch(main, /label: nt\('preferences'\),[\s\S]{0,180}changeInboxoraHost/);
});
