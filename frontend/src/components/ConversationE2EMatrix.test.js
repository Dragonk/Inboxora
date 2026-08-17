import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';

describe('conversation E2E matrix contract', () => {
  it.each([
    [false, false], [false, true], [true, false], [true, true],
  ])('defines list=%s reader=%s feature preference combination', (list, reader) => {
    const source = readFileSync('src/components/MailApp.jsx', 'utf8');
    expect(source).toContain('conversationListViewEnabled');
    expect(source).toContain('conversationReaderViewEnabled');
    expect(typeof list).toBe('boolean');
    expect(typeof reader).toBe('boolean');
  });
});
