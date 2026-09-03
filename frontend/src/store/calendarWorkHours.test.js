import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return {
        format: 'module',
        source: `export default ${readFileSync(new URL(url), 'utf8')}`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { api } = await import('../utils/api.js');
const { useStore } = await import('./index.js');
const originalSavePreferences = api.savePreferences;

const waitForSave = () => new Promise(resolve => setTimeout(resolve, 1100));

describe('calendar working-hour preferences', () => {
  beforeEach(() => {
    useStore.setState({
      calendarWorkHoursStart: '09:00',
      calendarWorkHoursEnd: '17:00',
      calendarWorkHoursPersisted: { start: '09:00', end: '17:00' },
      calendarWorkHoursError: '',
    });
  });

  afterEach(() => {
    api.savePreferences = originalSavePreferences;
  });

  it('rejects a start-only change that would reverse the working-hour pair', async () => {
    const saves = [];
    api.savePreferences = async prefs => { saves.push(prefs); };

    useStore.getState().setCalendarWorkHoursStart('18:00');

    assert.deepEqual({
      start: useStore.getState().calendarWorkHoursStart,
      end: useStore.getState().calendarWorkHoursEnd,
      error: useStore.getState().calendarWorkHoursError,
    }, {
      start: '09:00',
      end: '17:00',
      error: 'Working hours must end after they start.',
    });
    await waitForSave();
    assert.deepEqual(saves, []);
  });

  it('persists a valid follow-up adjustment as the same full pair shown in the store', async () => {
    const saves = [];
    api.savePreferences = async prefs => { saves.push(prefs); };

    useStore.getState().setCalendarWorkHoursStart('18:00');
    useStore.getState().setCalendarWorkHoursEnd('19:00');
    await waitForSave();

    assert.deepEqual({
      start: useStore.getState().calendarWorkHoursStart,
      end: useStore.getState().calendarWorkHoursEnd,
      error: useStore.getState().calendarWorkHoursError,
    }, { start: '09:00', end: '19:00', error: '' });
    assert.deepEqual(saves, [{ calendarWorkHoursStart: '09:00', calendarWorkHoursEnd: '19:00' }]);
  });

  it('restores the persisted pair and exposes an error when a valid save fails', async () => {
    api.savePreferences = async () => { throw new Error('save failed'); };

    useStore.getState().setCalendarWorkHoursEnd('18:00');
    await waitForSave();

    assert.deepEqual({
      start: useStore.getState().calendarWorkHoursStart,
      end: useStore.getState().calendarWorkHoursEnd,
      error: useStore.getState().calendarWorkHoursError,
    }, {
      start: '09:00',
      end: '17:00',
      error: 'Working hours could not be saved. The previous range was restored.',
    });
  });

  it('uses a one-control update to recover a legacy reversed pair', async () => {
    const saves = [];
    useStore.setState({
      calendarWorkHoursStart: '17:00',
      calendarWorkHoursEnd: '09:00',
      calendarWorkHoursPersisted: { start: '17:00', end: '09:00' },
    });
    api.savePreferences = async prefs => { saves.push(prefs); };

    useStore.getState().setCalendarWorkHoursEnd('18:00');
    await waitForSave();

    assert.deepEqual({
      start: useStore.getState().calendarWorkHoursStart,
      end: useStore.getState().calendarWorkHoursEnd,
    }, { start: '09:00', end: '18:00' });
    assert.deepEqual(saves, [{ calendarWorkHoursEnd: '18:00' }]);
  });
});
