// Decision logic for the compose autosave timer (#413), kept out of the component so it can
// be tested directly: ComposeModal has no test harness, and the conditions below are exactly
// the part that is easy to get subtly wrong.
//
// Autosave exists because compose state is component-local and the modal is mounted
// conditionally, so a page refresh discarded everything typed. It writes back to the Drafts
// folder on an interval; doSaveDraft replaces the existing draft rather than appending a new
// one, so repeated saves update a single message.

/**
 * Whether the autosave timer should write a draft on this tick.
 *
 * @param {object}  s
 * @param {boolean} s.dirty        isDirty(): there are unsaved changes
 * @param {boolean} s.hasAccount   a From account resolved; the server requires one
 * @param {boolean} s.sending      a send is in progress
 * @param {boolean} s.savingDraft  a save is in progress (React state, updated after commit)
 * @param {boolean} s.inFlight     a save is in progress (ref, updated synchronously)
 * @param {boolean} s.dialogOpen   a close/discard/attachment dialog is showing
 */
export function shouldAutosave(s) {
  if (!s) return false;
  // Nothing to preserve.
  if (!s.dirty) return false;
  // POST /draft requires an accountId; without one there is nowhere to save.
  if (!s.hasAccount) return false;
  // Never write concurrently with a send: the draft would be appended around the moment the
  // message leaves, which can strand a copy in Drafts after it has already been sent.
  if (s.sending) return false;
  // Two overlapping saves would each append and then each claim the resulting uid, which can
  // leave a duplicate behind. `savingDraft` is React state and only refreshes after commit,
  // so `inFlight` (a ref, set synchronously) closes the window between the two.
  if (s.savingDraft || s.inFlight) return false;
  // A close/discard prompt renders different text and buttons depending on isDirty(). Saving
  // underneath it would flip that mid-decision, so leave the choice to the user.
  if (s.dialogOpen) return false;
  return true;
}

/**
 * Whether enough has happened to justify writing a draft on this tick.
 *
 * Polling on a fixed interval saves while the user is still mid-sentence and makes them wait
 * the full interval after they stop. Each save costs two IMAP round trips (APPEND the new
 * draft, then delete the previous uid) and re-uploads the whole body, so saving during active
 * typing is the expensive case and saving just after a pause is the useful one.
 *
 * So: save once typing has paused for idleMs, and regardless once maxMs has elapsed since the
 * last save, which bounds the loss window for someone who types continuously.
 *
 * @param {object} s
 * @param {number} s.now         current epoch ms
 * @param {number} s.lastEditAt  epoch ms of the last edit (body, recipients, subject)
 * @param {number} s.lastSaveAt  epoch ms of the last successful save, seeded at mount
 * @param {number} s.idleMs      quiet period after typing that triggers a save
 * @param {number} s.maxMs       longest a dirty compose may go unsaved
 */
export function isAutosaveDue(s) {
  if (!s) return false;
  const sinceSave = s.now - s.lastSaveAt;
  // The cap always wins: a dirty compose must never go longer than this unsaved.
  if (sinceSave >= s.maxMs) return true;
  // Floor. Without it, someone composing thoughtfully and pausing between phrases trips the
  // idle rule after every pause: measured at 18 saves in three minutes against 6 for plain
  // 30s polling, three times the IMAP cost for precisely the careful writer. The floor keeps
  // the benefit of saving soon after a pause while bounding how often that can happen.
  if (sinceSave < s.minGapMs) return false;
  if (s.now - s.lastEditAt >= s.idleMs) return true;
  return false;
}
