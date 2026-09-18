import { describe, expect, it } from 'vitest';
import { scoreRules, explainRules, normalizeContactAddress } from './spamRules.js';

describe('spam rules', () => {
  it('fires pharma keywords in subject', () => {
    const { score, fired } = scoreRules({ subject: 'Buy viagra now', body: '' });
    expect(score).toBeGreaterThan(0);
    expect(fired.some(r => r.name === 'SUBJECT_PHARMA_KEYWORDS')).toBe(true);
  });

  it('requires two body phrases before firing', () => {
    expect(scoreRules({ subject: '', body: 'click here' }).fired.some(r => r.name === 'BODY_SPAM_KEYWORDS')).toBe(false);
    expect(scoreRules({ subject: '', body: 'click here, buy now today' }).fired.some(r => r.name === 'BODY_SPAM_KEYWORDS')).toBe(true);
  });

  it('dedupes double-counted attachment rules in score only', () => {
    const { score, fired } = scoreRules({
      subject: 'invoice', body: '',
      attachments: [{ filename: 'invoice.pdf.exe' }],
    });
    expect(fired.map(r => r.name)).toContain('ATTACHMENT_EXECUTABLE');
    expect(fired.map(r => r.name)).toContain('ATTACHMENT_DOUBLE_EXT');
    expect(score).toBe(0.6);
  });

  it('stays neutral on auth when no trusted header exists', () => {
    const { score, fired } = scoreRules({ subject: 'hello', body: 'world' }, { trustedAuthservIds: null });
    expect(fired.some(r => r.name.startsWith('AUTH_'))).toBe(false);
    expect(score).toBe(0);
  });

  it('fires auth fail only for trusted headers', () => {
    const headers = ['Authentication-Results: mx.example.com; dkim=fail; spf=pass; dmarc=pass'];
    const trusted = scoreRules(
      { subject: 'hi', body: 'x', headers },
      { trustedAuthservIds: 'mx.example.com' },
    );
    const untrusted = scoreRules({ subject: 'hi', body: 'x', headers }, { trustedAuthservIds: null });
    expect(trusted.fired.some(r => r.name === 'AUTH_DKIM_FAIL')).toBe(true);
    expect(untrusted.fired.some(r => r.name.startsWith('AUTH_'))).toBe(false);
  });

  it('rewards list mail and known contacts', () => {
    const listMail = scoreRules(
      { subject: 'x', body: 'y', headers: ['List-Id: <x.example.com>', 'List-Unsubscribe: <mailto:x@example.com>'] },
    );
    expect(listMail.fired.some(r => r.name === 'MAILING_LIST_HEADERS')).toBe(true);
    const contacts = new Set(['friend@example.com']);
    const known = scoreRules({ subject: 'x', body: 'y', from: 'Friend <friend@example.com>' }, { userContacts: contacts });
    expect(known.fired.some(r => r.name === 'FROM_IN_USER_CONTACTS')).toBe(true);
  });

  it('normalizes gmail contacts before matching', () => {
    expect(normalizeContactAddress('John.Doe+tag@gmail.com')).toBe('johndoe@gmail.com');
  });

  it('explains every rule', () => {
    const explained = explainRules({ subject: 'viagra deal', body: '' });
    expect(explained.length).toBeGreaterThan(10);
    expect(explained.find(r => r.name === 'SUBJECT_PHARMA_KEYWORDS')?.fired).toBe(true);
  });
});
