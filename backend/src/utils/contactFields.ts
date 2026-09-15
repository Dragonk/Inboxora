import type { VCardContact } from './vcard.js';

const TEXT_FIELDS: Array<'title' | 'role' | 'nickname'> = ['title', 'role', 'nickname'];
const MAX_VALUE_LENGTH = 2048;

type AddressField = 'pobox' | 'extended' | 'street' | 'locality' | 'region' | 'postalCode' | 'country';

// PATCH distinguishes a missing property from an explicit null, which clears
// an existing nullable scalar value.
export function chooseDefined<T>(value: T | undefined, current: T): T {
  return value !== undefined ? value : current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length <= MAX_VALUE_LENGTH ? normalized : undefined;
}

function textOrEmpty(value: unknown): string | undefined {
  return text(value === null || value === undefined ? '' : value);
}

function textOrOther(value: unknown): string | undefined {
  return text(value === null || value === undefined ? 'other' : value);
}

function arrayOrEmpty(value: unknown): unknown {
  return value === null || value === undefined ? [] : value;
}

type ValueValidator = (value: string) => boolean;

interface TypedValue {
  value: string;
  type: string;
}

function typedValues(values: unknown, isValid: ValueValidator): TypedValue[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const normalized: TypedValue[] = [];
  for (const value of values) {
    if (!isRecord(value)) return undefined;
    const itemValue = text(value.value);
    const type = textOrOther(value.type);
    if (itemValue === undefined || type === undefined || (itemValue && !isValid(itemValue))) return undefined;
    if (itemValue) normalized.push({ value: itemValue, type: type || 'other' });
  }
  return normalized;
}

interface NormalizedAddress {
  [field: string]: string;
  type: string;
  pobox: string;
  extended: string;
  street: string;
  locality: string;
  region: string;
  postalCode: string;
  country: string;
}

function addressField(source: Record<string, unknown>, field: AddressField): string | undefined {
  return textOrEmpty(source[field]);
}

function addresses(values: unknown): NormalizedAddress[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const normalized: NormalizedAddress[] = [];
  for (const value of values) {
    if (!isRecord(value)) return undefined;
    const type = textOrOther(value.type);
    const pobox = addressField(value, 'pobox');
    const extended = addressField(value, 'extended');
    const street = addressField(value, 'street');
    const locality = addressField(value, 'locality');
    const region = addressField(value, 'region');
    const postalCode = addressField(value, 'postalCode');
    const country = addressField(value, 'country');
    if (type === undefined || pobox === undefined || extended === undefined || street === undefined
      || locality === undefined || region === undefined || postalCode === undefined || country === undefined) return undefined;
    const address: NormalizedAddress = {
      type: type || 'other',
      pobox,
      extended,
      street,
      locality,
      region,
      postalCode,
      country,
    };
    if (pobox || extended || street || locality || region || postalCode || country) normalized.push(address);
  }
  return normalized;
}

type RichContactFields = Partial<Pick<VCardContact, 'title' | 'role' | 'nickname' | 'urls' | 'instantMessages' | 'addresses' | 'categories'>>;

export function normalizeRichContactFields(body: unknown): RichContactFields | undefined {
  if (!isRecord(body)) return undefined;
  const normalized: RichContactFields = {};
  for (const field of TEXT_FIELDS) {
    const value = textOrEmpty(body[field]);
    if (value === undefined) return undefined;
    normalized[field] = value || null;
  }
  const urls = typedValues(arrayOrEmpty(body.urls), value => /^https?:\/\//i.test(value));
  const instantMessages = typedValues(arrayOrEmpty(body.instantMessages), () => true);
  const normalizedAddresses = addresses(arrayOrEmpty(body.addresses));
  if (urls === undefined || instantMessages === undefined || normalizedAddresses === undefined || !Array.isArray(body.categories)) return undefined;
  const categories: string[] = [];
  for (const category of body.categories) {
    const value = text(category);
    if (value === undefined) return undefined;
    if (value) categories.push(value);
  }
  normalized.urls = urls;
  normalized.instantMessages = instantMessages;
  normalized.addresses = normalizedAddresses;
  normalized.categories = categories;
  return normalized;
}
