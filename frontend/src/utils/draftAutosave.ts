// Pure decision helpers for ComposeModal's draft safety net.
export function shouldAutosave(s) {
  if (!s) return false;
  if (!s.dirty || !s.hasAccount) return false;
  if (s.sending || s.savingDraft || s.inFlight || s.dialogOpen) return false;
  return true;
}

export function isAutosaveDue(s) {
  if (!s) return false;
  const sinceSave = s.now - s.lastSaveAt;
  if (sinceSave >= s.maxMs) return true;
  if (sinceSave < s.minGapMs) return false;
  return s.now - s.lastEditAt >= s.idleMs;
}
