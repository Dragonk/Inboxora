// Injectable handle to the mail engine (imapManager) for the plugin platform (v3.0).
//
// The mail engine is a singleton created at boot in index.js (it needs the WebSocket server).
// The plugin-api barrel binds mail capabilities (apply a label, archive, broadcast) to it — but
// the barrel must NOT `import` it from index.js, because index.js is the application entry with
// heavy side effects (server listen, DB, account connects); importing it into the barrel would
// boot the whole app inside any unit test that loads a plugin file. So index.js pushes the engine
// here at boot via setMailEngine, and the barrel pulls it lazily via getMailEngine — this leaf
// module has no side effects and is trivial to inject in tests.
let engine = null;

// Called once, at boot, by index.js after the ImapManager instance exists. Tests inject a mock.
export function setMailEngine(instance) {
  engine = instance;
}

// The bound capabilities call this at request time (never at import time), by which point the
// engine has been set. Throws a clear error if a capability is used before initialization.
export function getMailEngine() {
  if (!engine) throw new Error('mail engine not initialized — setMailEngine() must run at boot');
  return engine;
}
