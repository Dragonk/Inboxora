// i18next resource IDs need BCP 47 spelling before they are passed to Intl.
export function intlLocale(language) {
  if (!language) return undefined;
  return language === 'zhCN' ? 'zh-CN' : language.replace('_', '-');
}
