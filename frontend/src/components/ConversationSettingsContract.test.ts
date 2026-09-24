import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

describe('Conversation settings contract', () => {
  it('uses native preferences with two described choices instead of switches', () => {
    const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
    for (const [testId, preference, setter, label, offLabel, onLabel, offDescription, onDescription] of [
      ['conversation-list-toggle', 'threadedView', 'setThreadedView', 'groupIntoConversations', 'seriesOff', 'groupIntoConversationsOn', 'groupingOffDesc', 'groupingOnDesc'],
      ['conversation-reader-toggle', 'conversationReaderViewEnabled', 'setConversationReaderViewEnabled', 'conversationReader', 'readerOff', 'readerOn', 'readerOffDesc', 'readerOnDesc'],
    ]) {
      const choices = source.match(/<SettingsChoices\b[\s\S]*?\/>/g)?.find(block => block.includes(`testId="${testId}"`));
      assert.ok(choices, `${testId} must be a SettingsChoices control`);
      assert.ok(choices.includes(`label={t('conversation.${label}')}`));
      assert.ok(choices.includes(`value={${preference} ? 'on' : 'off'}`));
      assert.ok(choices.includes(`onChange={value => ${setter}(value === 'on')}`));
      assert.ok(choices.includes(`['off', t('conversation.${offLabel}'), t('conversation.${offDescription}')]`));
      assert.ok(choices.includes(`['on', t('conversation.${onLabel}'), t('conversation.${onDescription}')]`));
      assert.equal(choices.match(/\['(?:off|on)',/g)?.length, 2);
    }
    assert.doesNotMatch(source, /conversation_list_view_enabled/);
  });

  it('presents every settings option as a name with a short description', () => {
    const source = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
    // Both switch rows and choice groups keep their shared description rendering.
    assert.match(source, /function SettingsSwitchRow\(\{ label, description, checked/);
    assert.match(source, /function SettingsChoices(?:<[^>]*>)?\(\{ label, description, testId/);
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
