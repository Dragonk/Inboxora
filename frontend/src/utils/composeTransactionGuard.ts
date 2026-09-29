import { Plugin } from '@tiptap/pm/state';

/** Reject document changes from stale toolbar/portal/image callbacks once a send snapshot is frozen. */
export function createComposeTransactionGuard(isLocked: () => boolean): Plugin {
  return new Plugin({ filterTransaction: transaction => !transaction.docChanged || !isLocked() });
}
