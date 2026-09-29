import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveScheduleTime, scheduleWallTime, schedulePreview } from './scheduleTime.ts';

test('exact zoned future time yields UTC instant and offset preview', () => {
  assert.deepEqual(resolveScheduleTime('2030-07-01T10:30', 'Europe/Warsaw', 0), { instant: '2030-07-01T08:30:00.000Z' });
  assert.equal(scheduleWallTime('2030-07-01T08:30:00Z', 'Europe/Warsaw'), '2030-07-01T10:30');
  const preview = schedulePreview('2030-07-01T08:30:00Z', 'Europe/Warsaw', 'en');
  assert.match(preview, /10:30/);
  assert.match(preview, /GMT\+2\b|CEST/);
  assert.doesNotMatch(preview, /Europe\/Warsaw/);
});
test('DST gaps and repeated hours never silently shift', () => {
  assert.deepEqual(resolveScheduleTime('2030-03-10T02:30', 'America/New_York', 0), { error: 'invalidTime' });
  assert.deepEqual(resolveScheduleTime('2030-11-03T01:30', 'America/New_York', 0), { error: 'ambiguousTime' });
  assert.deepEqual(resolveScheduleTime('2030-04-07T01:45', 'Australia/Lord_Howe', 0), { error: 'ambiguousTime' });
  assert.deepEqual(resolveScheduleTime('2030-10-06T02:15', 'Australia/Lord_Howe', 0), { error: 'invalidTime' });
});
test('invalid dates, invalid zones and past times reject', () => {
  assert.deepEqual(resolveScheduleTime('2030-02-30T12:00', 'UTC', 0), { error: 'invalidTime' });
  assert.deepEqual(resolveScheduleTime('2030-02-01T12:00', 'Not/A_Zone', 0), { error: 'invalidTime' });
  assert.deepEqual(resolveScheduleTime('2000-02-01T12:00', 'UTC'), { error: 'pastTime' });
});

test('reopening in another browser zone preserves the exact saved instant until a field changes', async () => {
  const { resolveScheduleSelection } = await import('./scheduleTime.ts');
  const saved = '2030-01-15T12:45:37.123Z';
  for (const zone of ['Europe/Warsaw', 'America/New_York', 'Asia/Kathmandu', 'Pacific/Auckland']) {
    const wall = scheduleWallTime(saved, zone);
    assert.deepEqual(resolveScheduleSelection(wall, zone, saved, 0), { instant: saved });
  }
  assert.deepEqual(resolveScheduleSelection('2030-01-15T14:46', 'Europe/Warsaw', saved, 0), { instant: '2030-01-15T13:46:00.000Z' });
});
test('an existing exact fold instant can be reopened, while a newly chosen fold remains ambiguous', async () => {
  const { resolveScheduleSelection } = await import('./scheduleTime.ts');
  for (const saved of ['2030-10-27T00:30:00.000Z', '2030-10-27T01:30:00.000Z']) {
    assert.deepEqual(resolveScheduleSelection('2030-10-27T02:30', 'Europe/Warsaw', saved, 0), { instant: saved });
  }
  assert.deepEqual(resolveScheduleSelection('2030-10-27T02:30', 'Europe/Warsaw', undefined, 0), { error: 'ambiguousTime' });
  assert.deepEqual(resolveScheduleSelection('2030-03-31T02:30', 'Europe/Warsaw', undefined, 0), { error: 'invalidTime' });
});
test('preserving an old saved value never permits a past schedule', async () => {
  const { resolveScheduleSelection } = await import('./scheduleTime.ts');
  assert.deepEqual(resolveScheduleSelection('2020-01-01T01:00', 'Europe/Warsaw', '2020-01-01T00:00:00Z', Date.parse('2026-01-01')), { error: 'pastTime' });
});

test('the current minute and an expired future selection are rejected at confirmation time', async () => {
  const { resolveScheduleSelection } = await import('./scheduleTime.ts');
  const deadline = Date.parse('2030-01-15T01:45:00Z');
  assert.deepEqual(resolveScheduleTime('2030-01-15T02:45', 'Europe/Warsaw', deadline), { error: 'pastTime' });
  assert.deepEqual(resolveScheduleTime('2030-01-15T02:45', 'Europe/Warsaw', deadline - 1), { instant: '2030-01-15T01:45:00.000Z' });
  assert.deepEqual(resolveScheduleSelection('2030-01-15T02:45', 'Europe/Warsaw', '2030-01-15T01:45:00Z', deadline + 1), { error: 'pastTime' });
});
