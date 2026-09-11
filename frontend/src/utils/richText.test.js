import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calendarDescriptionBody, isHtmlRichText, isEmptyRichText, richTextEditorContent, richTextOrNull } from './richText.js';

describe('calendar description payloads', () => {
  it('stores nothing for an untouched editor', () => {
    assert.equal(richTextOrNull(''), null);
    assert.equal(richTextOrNull('   '), null);
    assert.equal(richTextOrNull('<p></p>'), null);
    assert.equal(richTextOrNull('<p><br></p>'), null);
    assert.equal(richTextOrNull(undefined), null);
  });

  it('keeps rich text and plain text', () => {
    assert.equal(richTextOrNull('<p>Agenda</p>'), '<p>Agenda</p>');
    assert.equal(richTextOrNull('  Agenda  '), 'Agenda');
  });

  it('treats only real markup as HTML', () => {
    assert.equal(isHtmlRichText('meeting at 5 < 6, a > b'), false);
    assert.equal(isHtmlRichText('plain\ntext'), false);
    assert.equal(isHtmlRichText('<p>hello</p>'), true);
    assert.equal(isHtmlRichText('line one<br>line two'), true);
  });

  it('routes each description to the mail body renderer correctly', () => {
    assert.deepEqual(calendarDescriptionBody('<p>Plan</p>'), { html: '<p>Plan</p>', text: '' });
    assert.deepEqual(calendarDescriptionBody('Plan\nNext'), { html: '', text: 'Plan\nNext' });
    assert.deepEqual(calendarDescriptionBody(''), { html: '', text: '' });
    assert.deepEqual(calendarDescriptionBody(undefined), { html: '', text: '' });
  });

  it('treats an empty editor document as empty', () => {
    assert.equal(isEmptyRichText('<p></p>'), true);
    assert.equal(isEmptyRichText('<p> </p>'), true);
    assert.equal(isEmptyRichText('<p>Agenda</p>'), false);
  });

  it('gives the editor markup for a stored plain-text description', () => {
    assert.equal(richTextEditorContent(''), '');
    assert.equal(richTextEditorContent('<p>Agenda</p>'), '<p>Agenda</p>');
    assert.equal(richTextEditorContent('Line one\nLine two'), '<p>Line one</p><p>Line two</p>');
    assert.equal(richTextEditorContent('a < b & c'), '<p>a &lt; b &amp; c</p>');
  });
});
