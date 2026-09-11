import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

const source = path => readFile(new URL(path, import.meta.url), 'utf8');

describe('Calendar event preview contract', () => {
  test('opening an event always shows the mail-like preview first', async () => {
    const calendar = await source('./CalendarPage.jsx');
    // Opening a local event used to jump straight into the editor, so its
    // description was never rendered the way a message body is.
    assert.match(calendar, /const openEvent = event => \{[\s\S]*?setPreview\(event\);/);
    assert.doesNotMatch(calendar, /if \(!event\.read_only && event\.source === 'local'\) openEdit\(event\);/);
    // Editing stays reachable from the preview, for editable events only, and the
    // preview closes as the editor opens so two dialogs are never stacked.
    assert.match(calendar, /const editablePreview = Boolean\(preview && !preview\.read_only && preview\.source === 'local'\);/);
    assert.match(calendar, /data-testid="calendar-preview-edit"[\s\S]{0,120}setPreview\(null\); openEdit\(event\);/);
  });

  test('the description renders through the message body renderer', async () => {
    const calendar = await source('./CalendarPage.jsx');
    assert.match(calendar, /calendarDescriptionBody\(preview\?\.description\)/);
    assert.match(calendar, /data-testid="calendar-event-description-body"><MessageBodyRenderer \{\.\.\.descriptionBody\}/);
  });

  test('a mail-derived event links back to the message it came from', async () => {
    const calendar = await source('./CalendarPage.jsx');
    assert.match(calendar, /preview\.source_message_id && <Button data-testid="calendar-open-source-message"/);
    // The message may live in another account or folder and may not be in the loaded
    // list, so it is fetched and published as a one-message thread before selecting
    // it — selecting an unknown id would open a blank reader.
    assert.match(calendar, /await openDeepLinkMessage\(messageId, \{ getMessage: api\.getMessage, setThreadMessages, setSelectedMessage \}\)/);
    assert.match(calendar, /setSelectedAccount\(preview\.source_account_id, preview\.source_folder \|\| 'INBOX'\)/);
    assert.match(calendar, /setShowCalendar\(false\)/);
  });

  test('preview and editor are full screen on a phone', async () => {
    const calendar = await source('./CalendarPage.jsx');
    assert.match(calendar, /className=\{isMobile \? 'calendar-event-dialog-full ui-fullscreen' : ''\}/);
    assert.match(calendar, /fullScreen=\{isMobile\}/);
    const css = await source('../ui.css');
    assert.match(css, /\.ui-dialog\.ui-fullscreen \{[\s\S]*?height: 100dvh/);
  });
});
