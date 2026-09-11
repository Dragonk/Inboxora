import { describe, expect, it } from 'vitest';
import { chooseDefined, normalizeRichContactFields } from './contactFields.js';

describe('normalizeRichContactFields', () => {
  it('uses an explicitly supplied null to clear an existing scalar field', () => {
    expect(chooseDefined(null, 'Existing title')).toBeNull();
    expect(chooseDefined(undefined, 'Existing title')).toBe('Existing title');
  });

  it('normalizes user-entered DAVx5 fields into safe vCard payload values', () => {
    expect(normalizeRichContactFields({
      title: '  Director ', role: ' Owner ', nickname: ' Ada ',
      urls: [{ value: ' https://example.test ', type: 'work' }],
      instantMessages: [{ value: ' matrix:@ada:example.test ', type: 'matrix' }],
      categories: [' Friends ', '', 'Work'],
      addresses: [{ type: 'home', street: '1 Main Street', locality: 'Warsaw', postalCode: '00-001', country: 'PL' }],
    })).toEqual({
      title: 'Director', role: 'Owner', nickname: 'Ada',
      urls: [{ value: 'https://example.test', type: 'work' }],
      instantMessages: [{ value: 'matrix:@ada:example.test', type: 'matrix' }],
      categories: ['Friends', 'Work'],
      addresses: [{ type: 'home', pobox: '', extended: '', street: '1 Main Street', locality: 'Warsaw', region: '', postalCode: '00-001', country: 'PL' }],
    });
  });

  it('rejects malformed rich contact collection fields', () => {
    expect(normalizeRichContactFields({ urls: 'https://example.test' })).toBeUndefined();
    expect(normalizeRichContactFields({ addresses: [{ street: 42 }] })).toBeUndefined();
  });

  it('rejects unsafe website URL schemes before they can be rendered as links', () => {
    expect(normalizeRichContactFields({ urls: [{ value: 'javascript:alert(1)' }], categories: [] })).toBeUndefined();
  });
});
