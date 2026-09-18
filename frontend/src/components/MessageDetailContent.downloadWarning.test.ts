import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync(new URL('./MessageDetailContent.tsx', import.meta.url), 'utf8');

describe('dangerous attachment download warning contract', () => {
  it('defers risky individual downloads until confirmation', () => {
    assert.match(source, /import \{ isDangerousAttachment \} from '\.\.\/utils\/dangerousAttachment\.ts';/);
    assert.match(source, /if \(isDangerousAttachment\(attachment\)\) \{/);
    assert.match(source, /setPendingDownload\(\{ kind: 'attachment', attachment \}\)/);
    assert.match(source, /void download\(target\.attachment\)/);
    assert.match(source, /data-testid="dangerous-attachment-download-confirm"/);
  });

  it('does not let Download all bypass the warning', () => {
    assert.match(source, /const downloadAllContainsDangerousAttachment = attachments\.some\(isDangerousAttachment\)/);
    assert.match(source, /const requestDownloadAll = \(event: MouseEvent<HTMLAnchorElement>\) => \{/);
    assert.match(source, /event\.preventDefault\(\)/);
    assert.match(source, /setPendingDownload\(\{ kind: 'all' \}\)/);
    assert.match(source, /data-message-detail-download-all="true"[\s\S]*?onClick=\{requestDownloadAll\}/);
  });
});
