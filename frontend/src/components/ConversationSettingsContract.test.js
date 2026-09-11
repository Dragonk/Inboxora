import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
describe('Conversation settings contract', () => {
  it('uses the native grouping preference and a stable reader description', () => {
    const source = readFileSync(new URL('./AdminPanel.jsx', import.meta.url), 'utf8');
    assert.match(source, /conversation\.groupIntoConversations/);
    assert.match(source, /setThreadedView/);
    // Both switches explain what the option means instead of swapping the line
    // between an on/off wording, which is what the rest of the settings do.
    assert.match(source, /conversation\.readerDesc/);
    assert.match(source, /admin\.messageList\.threadingDesc/);
    assert.doesNotMatch(source, /conversation\.readerOnDesc/);
    assert.doesNotMatch(source, /conversation\.readerOffDesc/);
    assert.doesNotMatch(source, /conversation_list_view_enabled/);
  });

  it('presents every settings option as a name with a short description', () => {
    const source = readFileSync(new URL('./AdminPanel.jsx', import.meta.url), 'utf8');
    // The shared option row carries the description for switches...
    assert.match(source, /function SettingsSwitchRow\(\{ label, description, checked/);
    assert.match(source, /testId="conversation-list-toggle"/);
    assert.match(source, /testId="conversation-reader-toggle"/);
    // ...and the shared choice group carries one per value, so the calendar and the
    // mobile panel position read like the message-list settings.
    assert.match(source, /function SettingsChoices\(\{ label, description, testId/);
    assert.match(source, /calendar\.firstDayOfWeekDescription/);
    assert.match(source, /calendar\.mondayDescription/);
    assert.match(source, /calendar\.sundayDescription/);
    assert.match(source, /calendar\.workDaysDescription/);
    assert.match(source, /calendar\.workHoursStartDescription/);
    assert.match(source, /calendar\.workHoursEndDescription/);
    assert.match(source, /admin\.appearance\.navigationTopDesc/);
    assert.match(source, /admin\.appearance\.navigationBottomDesc/);
  });
});
