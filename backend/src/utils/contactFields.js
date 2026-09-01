const TEXT_FIELDS = ['title', 'role', 'nickname'];
const ADDRESS_FIELDS = ['pobox', 'extended', 'street', 'locality', 'region', 'postalCode', 'country'];
const MAX_VALUE_LENGTH = 2048;

// PATCH distinguishes a missing property from an explicit null, which clears
// an existing nullable scalar value.
export function chooseDefined(value, current) {
  return value !== undefined ? value : current;
}

function text(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length <= MAX_VALUE_LENGTH ? normalized : undefined;
}

function typedValues(values, isValid = () => true) {
  if (!Array.isArray(values)) return undefined;
  const normalized = [];
  for (const value of values) {
    if (!value || typeof value !== 'object') return undefined;
    const itemValue = text(value.value);
    const type = text(value.type ?? 'other');
    if (itemValue === undefined || type === undefined || (itemValue && !isValid(itemValue))) return undefined;
    if (itemValue) normalized.push({ value: itemValue, type: type || 'other' });
  }
  return normalized;
}

function addresses(values) {
  if (!Array.isArray(values)) return undefined;
  const normalized = [];
  for (const value of values) {
    if (!value || typeof value !== 'object') return undefined;
    const type = text(value.type ?? 'other');
    if (type === undefined) return undefined;
    const address = { type: type || 'other' };
    for (const field of ADDRESS_FIELDS) {
      const normalizedValue = text(value[field] ?? '');
      if (normalizedValue === undefined) return undefined;
      address[field] = normalizedValue;
    }
    if (ADDRESS_FIELDS.some(field => address[field])) normalized.push(address);
  }
  return normalized;
}

export function normalizeRichContactFields(body) {
  const normalized = {};
  for (const field of TEXT_FIELDS) {
    const value = text(body[field] ?? '');
    if (value === undefined) return undefined;
    normalized[field] = value || null;
  }
  normalized.urls = typedValues(body.urls ?? [], value => /^https?:\/\//i.test(value));
  normalized.instantMessages = typedValues(body.instantMessages ?? []);
  normalized.addresses = addresses(body.addresses ?? []);
  if (!Array.isArray(body.categories)) return undefined;
  normalized.categories = [];
  for (const category of body.categories) {
    const value = text(category);
    if (value === undefined) return undefined;
    if (value) normalized.categories.push(value);
  }
  return normalized.urls === undefined || normalized.instantMessages === undefined || normalized.addresses === undefined
    ? undefined
    : normalized;
}
