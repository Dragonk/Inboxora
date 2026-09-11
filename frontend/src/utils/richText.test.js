import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calendarDescriptionBody, isHtmlRichText, isEmptyRichText, plainTextToHtml, richTextEditorContent, richTextOrNull } from './richText.js';

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
    assert.deepEqual(calendarDescriptionBody('Plan\nNext'), { html: '<p>Plan<br>Next</p>', text: '' });
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

describe('plain-text calendar descriptions', () => {
  it('renders paragraphs and line breaks instead of one run-on block', () => {
    assert.equal(plainTextToHtml('First line\nSecond line'), '<p>First line<br>Second line</p>');
    assert.equal(plainTextToHtml('One\n\nTwo'), '<p>One</p><p>Two</p>');
    assert.equal(plainTextToHtml(''), '');
  });

  it('escapes markup so plain text can never inject HTML', () => {
    assert.equal(plainTextToHtml('<b>not bold</b> & <i>x</i>'), '<p>&lt;b&gt;not bold&lt;/b&gt; &amp; &lt;i&gt;x&lt;/i&gt;</p>');
  });

  it('turns an Outlook angle-bracket link into a real link without the brackets', () => {
    const html = plainTextToHtml('Potrzebujesz pomocy? <https://aka.ms/JoinTeamsMeeting?omkt=pl-PL>');
    assert.equal(html, '<p>Potrzebujesz pomocy? <a href="https://aka.ms/JoinTeamsMeeting?omkt=pl-PL" target="_blank" rel="noopener noreferrer">https://aka.ms/JoinTeamsMeeting?omkt=pl-PL</a></p>');
    assert.ok(!html.includes('&lt;https'));
  });

  it('keeps sentence punctuation outside the link', () => {
    assert.equal(
      plainTextToHtml('See https://example.test/agenda.'),
      '<p>See <a href="https://example.test/agenda" target="_blank" rel="noopener noreferrer">https://example.test/agenda</a>.</p>',
    );
  });

  it('links a bare www address and escapes query ampersands in the href', () => {
    assert.equal(
      plainTextToHtml('www.example.test'),
      '<p><a href="https://www.example.test" target="_blank" rel="noopener noreferrer">www.example.test</a></p>',
    );
    assert.equal(
      plainTextToHtml('https://teams.microsoft.com/x?a=1&b=2'),
      '<p><a href="https://teams.microsoft.com/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">https://teams.microsoft.com/x?a=1&amp;b=2</a></p>',
    );
  });

  it('routes a plain-text description to the mail body renderer as HTML', () => {
    const body = calendarDescriptionBody('UWAGA! Spotkanie o 14:00.\n\nMicrosoft Teams <https://teams.microsoft.com/l/meetup-join/demo>');
    assert.equal(body.text, '');
    assert.ok(body.html.startsWith('<p>UWAGA!'));
    assert.ok(body.html.includes('<a href="https://teams.microsoft.com/l/meetup-join/demo"'));
    assert.ok(!body.html.includes('&lt;https'));
  });
});
