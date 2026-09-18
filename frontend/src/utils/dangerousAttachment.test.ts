import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isDangerousAttachment } from './dangerousAttachment.ts';

describe('isDangerousAttachment', () => {
  it('identifies executable extensions case-insensitively', () => {
    assert.equal(isDangerousAttachment({ filename: 'invoice.PDF.EXE' }), true);
    assert.equal(isDangerousAttachment({ filename: 'installer.msi   ' }), true);
    assert.equal(isDangerousAttachment({ filename: 'shortcut.LNK' }), true);
  });

  it('identifies executable media types with parameters', () => {
    assert.equal(isDangerousAttachment({ type: 'application/x-msdownload; charset=binary' }), true);
    assert.equal(isDangerousAttachment({ type: 'application/java-archive' }), true);
  });

  it('allows ordinary attachments and deceptive non-final extensions', () => {
    assert.equal(isDangerousAttachment({ filename: 'report.pdf', type: 'application/pdf' }), false);
    assert.equal(isDangerousAttachment({ filename: 'run.sh.pdf' }), false);
  });
});
