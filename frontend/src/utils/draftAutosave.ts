// Pure decision helpers for ComposeModal's draft safety net.
type AutosaveState = Readonly<{
  dirty: boolean;
  hasAccount: boolean;
  sending: boolean;
  savingDraft: boolean;
  inFlight: boolean;
  dialogOpen: boolean;
}>;

type AutosaveSchedule = Readonly<{
  now: number;
  lastEditAt: number;
  lastSaveAt: number;
  idleMs: number;
  minGapMs: number;
  maxMs: number;
}>;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isAutosaveState(value: unknown): value is AutosaveState {
  if (!isRecord(value)) return false;

  return value.dirty === true
    && value.hasAccount === true
    && value.sending === false
    && value.savingDraft === false
    && value.inFlight === false
    && value.dialogOpen === false;
}

function isAutosaveSchedule(value: unknown): value is AutosaveSchedule {
  if (!isRecord(value)) return false;

  return isFiniteNumber(value.now)
    && isFiniteNumber(value.lastEditAt)
    && isFiniteNumber(value.lastSaveAt)
    && isFiniteNumber(value.idleMs)
    && isFiniteNumber(value.minGapMs)
    && isFiniteNumber(value.maxMs);
}

export function shouldAutosave(state: AutosaveState | null | undefined): boolean {
  return isAutosaveState(state);
}

export function isAutosaveDue(schedule: AutosaveSchedule | null | undefined): boolean {
  if (!isAutosaveSchedule(schedule)) return false;

  const sinceSave = schedule.now - schedule.lastSaveAt;
  if (sinceSave >= schedule.maxMs) return true;
  if (sinceSave < schedule.minGapMs) return false;
  return schedule.now - schedule.lastEditAt >= schedule.idleMs;
}
