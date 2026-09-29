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
