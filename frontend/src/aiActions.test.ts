import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SUMMARIZE_PROMPT, summarizePromptForLocale, newAiAction } from './aiActions.ts';

describe('summarizePromptForLocale (#255)', () => {
  it('keeps the base English prompt for English and unknown/empty locales', () => {
    assert.equal(summarizePromptForLocale('en'), SUMMARIZE_PROMPT);
    assert.equal(summarizePromptForLocale('xx'), SUMMARIZE_PROMPT);
    assert.equal(summarizePromptForLocale(undefined), SUMMARIZE_PROMPT);
  });

  it('appends a language directive for supported non-English locales', () => {
    assert.equal(summarizePromptForLocale('zhCN'), `${SUMMARIZE_PROMPT} Respond in Simplified Chinese.`);
    assert.equal(summarizePromptForLocale('de'), `${SUMMARIZE_PROMPT} Respond in German.`);
    assert.equal(summarizePromptForLocale('cs'), `${SUMMARIZE_PROMPT} Respond in Czech.`);
    assert.equal(summarizePromptForLocale('ru'), `${SUMMARIZE_PROMPT} Respond in Russian.`);
  });
});


describe('newAiAction', () => {
  it('creates an action with default empty values and an id', () => {
    const action = newAiAction();
    assert.equal(typeof action.id, 'string');
    assert.ok(action.id.length > 0);
    assert.equal(action.label, '');
    assert.equal(action.prompt, '');
  });

  it('creates an action with provided label and prompt', () => {
    const action = newAiAction('Custom Label', 'Custom Prompt');
    assert.equal(typeof action.id, 'string');
    assert.ok(action.id.length > 0);
    assert.equal(action.label, 'Custom Label');
    assert.equal(action.prompt, 'Custom Prompt');
  });

  it('generates unique ids for each action', () => {
    const action1 = newAiAction();
    const action2 = newAiAction();
    assert.notEqual(action1.id, action2.id);
  });
});
