import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The editor must offer the same three scopes the server implements — only this occurrence, this and every
 * following one, or the whole series — because a scope the interface cannot ask for is a scope the user does
 * not have. These cases pin the control and the request shape behind each choice.
 */

const page = new URL('./CalendarPage.tsx', import.meta.url);
const view = new URL('./calendarView.ts', import.meta.url);

test('the event editor offers all three series scopes', async () => {
  const source = await readFile(page, 'utf8');
  for (const scope of ['single', 'following', 'series']) {
    assert.match(source, new RegExp(`data-testid="calendar-edit-scope-${scope}"`), `the ${scope} scope has no control`);
  }
  // Each control changes the scope, and the rule fields are shown for the two that state a rule.
  assert.match(source, /onClick=\{\(\) => onEditScopeChange\('following'\)\}/);
  assert.match(source, /const recurrenceMode = form\.mode === 'create' \|\| form\.editScope === 'series' \|\| form\.editScope === 'following';/);
  // The hint says which of the two occurrence scopes is active rather than assuming one of them.
  assert.match(source, /form\.editScope === 'single' && <p className="calendar-edit-scope-hint">\{t\('calendar\.editOccurrence'\)\}/);
  assert.match(source, /form\.editScope === 'following' && <p className="calendar-edit-scope-hint">\{t\('calendar\.editFollowing'\)\}/);
});

test('a this-and-following edit states the scope and the rule the remainder keeps', async () => {
  const source = await readFile(view, 'utf8');
  assert.match(source, /editScope\?: 'single' \| 'following' \| 'series';/);
  // The request names the occurrence and the scope, and carries the rule the remainder continues with.
  assert.match(source, /\.\.\.\(form\.editScope === 'following' \? \{ scope: 'following' \} : \{\}\)/);
  assert.match(source, /form\.editScope === 'series' \|\| form\.editScope === 'following'\) && !form\.recurrencePreserve/);
});

test('switching to this-and-following keeps the occurrence start and takes the series rule', async () => {
  const source = await readFile(page, 'utf8');
  const handler = source.slice(source.indexOf('const changeEditScope'), source.indexOf('const save = async () =>'));
  assert.match(handler, /scope === 'following'/);
  assert.match(handler, /recurrence: seriesSnapshot\.recurrence/);
  // The occurrence's own time survives: the remainder starts where the user is looking.
  assert.match(handler, /\.\.\.occurrenceSnapshot/);
});

test('every locale carries the hint for the new scope', async () => {
  for (const language of ['en', 'de', 'es', 'fr', 'it', 'pl', 'ru', 'cs', 'zhCN']) {
    const raw = await readFile(new URL(`../locales/${language}.json`, import.meta.url), 'utf8');
    const messages = JSON.parse(raw) as { calendar?: Record<string, string> };
    const hint = messages.calendar?.editFollowing;
    assert.equal(typeof hint, 'string', `${language} is missing calendar.editFollowing`);
    assert.notEqual(hint?.trim(), '', `${language} has an empty calendar.editFollowing`);
    assert.notEqual(hint, messages.calendar?.editOccurrence, `${language} reuses the single-occurrence hint`);
  }
});
