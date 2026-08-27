import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { plainTextBoundary, startsWithForwardMarker, startsWithReplyMarker } from './messageQuoteFolding.js';

describe('message quote folding classification', () => {
  it('protects forwarded messages, including the Gmail delimiter', () => {
    assert.equal(startsWithForwardMarker('---------- Forwarded message ---------\nFrom: sender@example.com'), true);
    assert.equal(startsWithForwardMarker('Begin forwarded message:\nFrom: sender@example.com'), true);
    assert.equal(startsWithForwardMarker('New reply\n\n---------- Forwarded message ---------'), false);
  });

  it('recognizes common reply markers without treating forwards as replies', () => {
    assert.equal(startsWithReplyMarker('On Tue, Aug 25, 2026 Name <n@example.com> wrote:\nOld body'), true);
    assert.equal(startsWithReplyMarker('Dnia 25 sierpnia 2026 Jan napisał(a):\nStara treść'), true);
    assert.equal(startsWithReplyMarker('-----Original Message-----\nFrom: sender@example.com'), true);
    assert.equal(startsWithReplyMarker('---------- Forwarded message ---------'), false);
  });

  it('folds a plain-text reply tail but keeps a forwarded message fully visible', () => {
    const reply = 'Current answer\n\nOn Tue, Name wrote:\n> old line one\n> old line two';
    assert.equal(plainTextBoundary(reply), reply.indexOf('On Tue'));
    const quotedTail = 'Current answer\n\n> old line one\n> old line two';
    assert.equal(plainTextBoundary(quotedTail), quotedTail.indexOf('> old'));
    assert.equal(plainTextBoundary('FYI\n\n---------- Forwarded message ---------\nFrom: sender@example.com'), -1);
    const nestedForward = 'FYI\n\n---------- Forwarded message ---------\nFrom: sender@example.com\n\nImmediate forwarded body\n\nDnia 25 sierpnia 2026 Jan napisał(a):\n> older reply';
    assert.equal(plainTextBoundary(nestedForward), nestedForward.indexOf('Dnia 25'));
  });

  it('does not fold a single incidental greater-than line or interleaved replies', () => {
    assert.equal(plainTextBoundary('Note\n> one quoted-looking line'), -1);
    assert.equal(plainTextBoundary('> question one\nanswer one\n> question two\nanswer two'), -1);
  });
});
