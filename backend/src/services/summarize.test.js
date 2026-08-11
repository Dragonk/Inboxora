import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
import { completeText, getAiStatus } from './aiProvider.js';
import {
  buildSummaryPrompt,
  sanitizeSummaryLine,
  summarizeAvailable,
  summarizeMessage,
} from './summarize.js';

describe('buildSummaryPrompt', () => {
  it('includes from, subject, and a whitespace-collapsed body', () => {
    const prompt = buildSummaryPrompt({ subject: 'Reports', from: 'Alice', content: 'pulling   the\n\nDeel  reports friday' });
    expect(prompt).toContain('From: Alice');
    expect(prompt).toContain('Subject: Reports');
    expect(prompt).toContain('Body: pulling the Deel reports friday');
    expect(prompt).toMatch(/ONE line of at most 120 characters/);
  });

  it('caps the body length and tolerates missing fields', () => {
    const prompt = buildSummaryPrompt({ content: 'x'.repeat(5000) });
    expect(prompt).toContain('From: (unknown)');
    expect(prompt.length).toBeLessThan(1400); // 1000-char body cap
  });

  it('honours a custom maxLen', () => {
    expect(buildSummaryPrompt({ maxLen: 60 })).toMatch(/ONE line of at most 60 characters/);
  });
});

describe('sanitizeSummaryLine', () => {
  it('takes the first non-empty line and trims', () => {
    expect(sanitizeSummaryLine('\n  pulling the Deel reports friday  \nextra')).toBe('pulling the Deel reports friday');
  });

  it('strips wrapping quotes and emoji', () => {
    expect(sanitizeSummaryLine('"waiting on their reply 🎉"')).toBe('waiting on their reply');
    expect(sanitizeSummaryLine('“sending the invoice ❤️ next week”')).toBe('sending the invoice next week');
  });

  it('collapses whitespace and hard-caps at 120 chars by default', () => {
    const out = sanitizeSummaryLine('a '.repeat(200));
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).not.toMatch(/\s{2,}/);
  });

  it('respects a custom maxLen cap', () => {
    expect(sanitizeSummaryLine('a '.repeat(200), 40).length).toBeLessThanOrEqual(40);
  });

  it('returns null for empty or non-string input', () => {
    expect(sanitizeSummaryLine('')).toBeNull();
    expect(sanitizeSummaryLine('   ')).toBeNull();
    expect(sanitizeSummaryLine(null)).toBeNull();
    expect(sanitizeSummaryLine(42)).toBeNull();
  });
});

describe('summarizeAvailable', () => {
  beforeEach(() => { getAiStatus.mockReset(); });

  it('is true only when enabled and summarize is not disabled', async () => {
    getAiStatus.mockResolvedValue({ enabled: true, features: { summarize: true } });
    expect(await summarizeAvailable()).toBe(true);
    getAiStatus.mockResolvedValue({ enabled: true, features: {} }); // absent => allowed
    expect(await summarizeAvailable()).toBe(true);
  });

  it('is false when disabled, when summarize is off, or when status throws', async () => {
    getAiStatus.mockResolvedValue({ enabled: false, features: { summarize: true } });
    expect(await summarizeAvailable()).toBe(false);
    getAiStatus.mockResolvedValue({ enabled: true, features: { summarize: false } });
    expect(await summarizeAvailable()).toBe(false);
    getAiStatus.mockRejectedValue(new Error('down'));
    expect(await summarizeAvailable()).toBe(false);
  });
});

describe('summarizeMessage', () => {
  beforeEach(() => { completeText.mockReset(); });

  it('sends the built prompt and returns the sanitised line', async () => {
    completeText.mockResolvedValue('"waiting on their reply 🎉"');
    const line = await summarizeMessage({ subject: 'S', from: 'Alice', content: 'body' });
    expect(line).toBe('waiting on their reply');
    expect(completeText).toHaveBeenCalledWith(
      [{ role: 'user', content: expect.stringContaining('Subject: S') }],
      { maxTokens: 120 }
    );
  });

  it('passes a custom maxLen through to the token budget', async () => {
    completeText.mockResolvedValue('short line');
    await summarizeMessage({ subject: 'S', content: 'b', maxLen: 60 });
    expect(completeText).toHaveBeenCalledWith(expect.anything(), { maxTokens: 60 });
  });

  it('returns null (never throws) when the provider errors', async () => {
    completeText.mockRejectedValue(new Error('provider down'));
    await expect(summarizeMessage({ subject: 'S', content: 'b' })).resolves.toBeNull();
  });
});
