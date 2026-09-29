const catalog = require('./locale-data.json');
function normalizeLanguage(value) {
  const tag = String(value || '').replace(/_/g, '-').toLowerCase();
  if (tag.startsWith('zh')) return 'zhCN';
  const language = tag.split('-')[0];
  return Object.hasOwn(catalog, language) ? language : 'en';
}
function text(language, key, values = {}) {
  const template = catalog[normalizeLanguage(language)][key] || catalog.en[key] || key;
  return template.replace(/\{\{(\w+)\}\}/g, (_token, name) => String(values[name] ?? ''));
}
module.exports = { catalog, normalizeLanguage, text };
