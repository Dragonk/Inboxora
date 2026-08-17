import { describe, expect, it } from 'vitest';
import { referencesAnchor } from './automatedSeriesAnchor.js';

describe('automated series anchor', () => {
  it('prefers the oldest References root and falls back to In-Reply-To', () => {
    expect(referencesAnchor({ thread_references: '<root@x> <reply@x>', in_reply_to: '<reply@x>' })).toBe('<root@x>');
    expect(referencesAnchor({ in_reply_to: '<reply@x>' })).toBe('<reply@x>');
  });
});
