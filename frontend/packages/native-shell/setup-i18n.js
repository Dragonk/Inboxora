/* Shared by the offline setup and unavailable-server screens. */
(function () {
  const i18n = window.InboxoraNativeI18n;
  let language = i18n.normalize(navigator.language);
  const apply = () => {
    document.documentElement.lang = language === 'zhCN' ? 'zh-CN' : language;
    document.querySelectorAll('[data-native-i18n]').forEach(element => {
      element.textContent = i18n.text(language, element.dataset.nativeI18n);
    });
    document.title = `${i18n.text(language, document.body.dataset.nativeTitle || 'connectTitle')} · Inboxora`;
  };
  const readNativeLanguage = async () => {
    if (typeof window.inboxoraNative?.getLanguage === 'function') return window.inboxoraNative.getLanguage();
    const plugin = window.Capacitor?.Plugins?.InboxoraNative;
    if (typeof plugin?.getLanguage === 'function') return plugin.getLanguage();
    if (typeof window.Capacitor?.nativePromise === 'function') return window.Capacitor.nativePromise('InboxoraNative', 'getLanguage', {});
    return null;
  };
  window.nativeTranslate = (key, values) => i18n.text(language, key, values);
  apply();
  window.nativeLanguageReady = Promise.race([readNativeLanguage(), new Promise(resolve => setTimeout(() => resolve(null), 1500))])
    .then(result => {
      if (result?.language) { language = i18n.normalize(result.language); apply(); }
      if (result?.theme && /^#[0-9a-f]{6}$/i.test(result.theme.color) && /^#[0-9a-f]{6}$/i.test(result.theme.symbolColor)) {
        const style = document.documentElement.style;
        style.setProperty('--native-background', result.theme.color);
        style.setProperty('--native-foreground', result.theme.symbolColor);
        style.setProperty('--native-muted', `color-mix(in srgb, ${result.theme.symbolColor} 70%, ${result.theme.color})`);
        style.setProperty('--native-input', result.theme.color);
        style.setProperty('--native-border', `color-mix(in srgb, ${result.theme.symbolColor} 25%, ${result.theme.color})`);
      }
    }).catch(() => {});
})();
