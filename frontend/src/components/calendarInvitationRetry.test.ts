import assert from 'node:assert/strict';
import test from 'node:test';
import { createInvitationOperationController } from './calendarInvitationRetry.ts';

/** The argument tuple of the controller's save method, taken from the exported factory. */
type InvitationSaveArgs = Parameters<ReturnType<typeof createInvitationOperationController>['save']>;
/** The calendar API and payload shapes the save method declares. */
type InvitationCalendarApi = InvitationSaveArgs[2];
type InvitationPayload = InvitationSaveArgs[1];

test('retries ambiguous invitation saves with the original key and payload', async () => {
  const calls: Array<{ method: string; id?: string; payload: InvitationPayload; key?: string }> = [];
  const responses = [
    { invitationError: 'delivery failed', invitationStatus: { status: 'failed' } },
    { invitationStatus: { status: 'sent' } },
  ];
  const api: InvitationCalendarApi = {
    createEvent: async (payload, key) => { calls.push({ method: 'create', payload, key }); return responses.shift(); },
    updateEvent: async (id, payload, key) => { calls.push({ method: 'update', id, payload, key }); return responses.shift(); },
  };
  const controller = createInvitationOperationController({ randomUUID: () => 'retry-key' });
  const form = { mode: 'create' };
  const payload = { summary: 'Planning', sendInvites: true };

  const first = await controller.save(form, payload, api);
  const second = await controller.save(form, payload, api);

  assert.equal(first.retryable, true);
  assert.equal(second.retryable, false);
  assert.deepEqual(calls, [
    { method: 'create', payload, key: 'retry-key' },
    { method: 'create', payload, key: 'retry-key' },
  ]);
  assert.equal(controller.currentKey(), null);
});

test('keeps an uncertain cancellation retryable without generating a new invitation key (V7-01)', async () => {
  const calls: Array<{ payload: InvitationPayload; key?: string }> = [];
  const api: InvitationCalendarApi = {
    createEvent: async () => { throw new Error('not used by edit retry'); },
    updateEvent: async (_id, payload, key) => {
      calls.push({ payload, key });
      return { invitationStatus: { status: 'uncertain' }, invitationOperation: { kind: 'cancellation', outboxId: 'cancel-1' } };
    },
  };
  const controller = createInvitationOperationController({ randomUUID: () => 'unexpected-key' });
  const payload = { summary: 'Planning', sendInvites: false, cancellationOutboxId: 'cancel-1' };

  const first = await controller.save({ mode: 'edit', id: 'event-1' }, payload, api);
  const second = await controller.save({ mode: 'edit', id: 'event-1' }, payload, api);

  assert.equal(first.retryable, true);
  assert.equal(second.retryable, true);
  assert.deepEqual(calls, [{ payload, key: undefined }, { payload, key: undefined }]);
  assert.equal(controller.currentKey(), null);
});

test('resetting an abandoned retry prevents cross-event key reuse', async () => {
  const calls: Array<{ payload: InvitationPayload; key?: string }> = [];
  const api: InvitationCalendarApi = {
    createEvent: async (payload, key) => { calls.push({ payload, key }); return { invitationError: 'delivery failed' }; },
  };
  const controller = createInvitationOperationController({ randomUUID: (() => { let i = 0; return () => `key-${++i}`; })() });

  await controller.save({ mode: 'create' }, { summary: 'First', sendInvites: true }, api);
  controller.reset();
  await controller.save({ mode: 'create' }, { summary: 'Second', sendInvites: true }, api);

  assert.deepEqual(calls.map(call => call.key), ['key-1', 'key-2']);
});

test('changing the payload starts a distinct invitation operation', async () => {
  const calls: Array<{ payload: InvitationPayload; key?: string }> = [];
  const api: InvitationCalendarApi = {
    createEvent: async (payload, key) => { calls.push({ payload, key }); return { invitationError: 'delivery failed' }; },
  };
  const controller = createInvitationOperationController({ randomUUID: (() => { let i = 0; return () => `key-${++i}`; })() });

  await controller.save({ mode: 'create' }, { summary: 'First', sendInvites: true }, api);
  await controller.save({ mode: 'create' }, { summary: 'Changed', sendInvites: true }, api);

  assert.deepEqual(calls.map(call => call.key), ['key-1', 'key-2']);
});
