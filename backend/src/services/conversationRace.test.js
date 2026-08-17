import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';

describe('conversation race gate', () => {
  it('serializes rebuild scope and uses serializable override transactions', () => {
    const rebuild = readFileSync('src/services/conversationRebuild.js', 'utf8');
    const overrides = readFileSync('src/services/conversationOverrides.js', 'utf8');
    expect(rebuild).toContain('pg_advisory_lock');
    expect(rebuild).toContain('pg_advisory_unlock');
    expect(overrides).toContain('serializable: true');
  });
});
