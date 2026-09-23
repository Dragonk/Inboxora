import { describe, expect, it } from 'vitest';
import { mergeGraphPrefer } from './graphApiClient.js';

describe('mergeGraphPrefer', () => {
  it('keeps immutable ids alongside paging and timezone preferences', () => {
    expect(mergeGraphPrefer('odata.maxpagesize=100, outlook.timezone="UTC"', 'IdType="ImmutableId"'))
      .toBe('odata.maxpagesize=100, outlook.timezone="UTC", IdType="ImmutableId"');
  });

  it('deduplicates preferences case-insensitively without splitting quoted commas', () => {
    expect(mergeGraphPrefer('outlook.timezone="America/New_York, Eastern Time"', 'OUTLOOK.TIMEZONE="America/New_York, Eastern Time"'))
      .toBe('outlook.timezone="America/New_York, Eastern Time"');
  });
});
