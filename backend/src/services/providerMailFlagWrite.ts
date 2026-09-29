import type { EmailAccountRow } from './imapManager.js';
import { enqueueMailFlagIntent, enqueueMailFlagIntents, processMailFlagIntent } from './mailFlagState.js';
import type { MailFlagOutcome, MailFlagIntentInput, MailFlagPorts } from './mailFlagState.js';
export interface ImapFlagPort {
    pluginFacade?: unknown;
    setFlag(account: EmailAccountRow, uid: number | string, folder: string, flag: string, value: boolean, expectedUidValidity?: number | string | null): Promise<unknown>;
    _resolveFlagPush?(accountId: string, messageId: string, flag: string): void;
    _enqueueFlagPush?(accountId: string, messageId: string, flag: string, value: boolean): void | Promise<void>;
    readMessageFlags?(account: EmailAccountRow, uid: number | string, folder: string, expectedUidValidity: number | string | null): Promise<{
        isRead: boolean;
        isStarred: boolean;
    } | null>;
    broadcast?(event: {
        type: string;
        accountId: string;
        changes?: Array<{
            id: string;
            is_read: boolean;
            is_starred: boolean;
        }>;
    }, userId?: string): void;
}
export interface FlagWriteOptions {
    userId: string;
    account: EmailAccountRow;
    accountId: string;
    messageId: string;
    providerMessageId?: string | null;
    uid: number | string;
    folder: string;
    flag: string;
    value: boolean;
}
/** Every action, including a same-state click, persists a new generation before provider dispatch. */
export async function pushProviderMessageFlag(options: FlagWriteOptions & {
    manager: ImapFlagPort;
}): Promise<MailFlagOutcome> {
    const intent = await enqueueMailFlagIntent(options);
    if (!intent)
        return { status: 'permanent', code: 'RESOURCE_NOT_FOUND' };
    return processMailFlagIntent(intent.message_id, options.flag, { manager: options.manager }, intent.generation);
}
/** A large bulk action is accepted durably as one transaction. Only a bounded
 * slice is dispatched in the HTTP request; the worker owns the remaining rows.
 * A slow or failed provider never prevents later batch members from being saved. */
export async function pushProviderMessageFlags(inputs: readonly MailFlagIntentInput[], ports: MailFlagPorts,
    options: { immediateLimit?: number; timeBudgetMs?: number } = {}): Promise<Array<MailFlagOutcome & { id: string }>> {
    const intents = await enqueueMailFlagIntents(inputs);
    const outcomes: Array<MailFlagOutcome & { id: string }> = inputs.map((input, index) => ({ id: input.messageId,
        ...(intents[index] ? { status: 'pending' as const } : { status: 'permanent' as const, code: 'RESOURCE_NOT_FOUND' }) }));
    const jobs = new Map<string, { intent: NonNullable<typeof intents[number]>; indices: number[] }>();
    intents.forEach((intent, index) => {
        if (!intent) return;
        const key = `${intent.message_id}:${intent.flag}`;
        const job = jobs.get(key);
        if (job) job.indices.push(index); else jobs.set(key, { intent, indices: [index] });
    });
    const immediateLimit = Math.max(0, Math.min(25, Math.trunc(options.immediateLimit ?? 25)));
    const queue = [...jobs.values()].slice(0, immediateLimit);
    const deadline = performance.now() + Math.max(0, Math.min(2000, options.timeBudgetMs ?? 2000));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (next < queue.length && performance.now() < deadline && !ports.shouldStop?.()) {
            const job = queue[next++];
            let result: MailFlagOutcome;
            try {
                result = await processMailFlagIntent(job.intent.message_id, job.intent.flag, ports, job.intent.generation);
            } catch (error) {
                // A persisted writing claim remains readback-only after expiry.
                // Do not replay it or lose the rest of the already-durable batch.
                console.error('Mail flag batch item requires reconciliation:', error instanceof Error ? error.message : error);
                result = { status: 'outcome_unknown', code: 'MUTATION_OUTCOME_UNKNOWN' };
            }
            for (const index of job.indices) outcomes[index] = { id: inputs[index].messageId, ...result };
        }
    }));
    return outcomes;
}
const nativePort: ImapFlagPort = {
    async setFlag() { throw new Error('Native flag intent cannot dispatch IMAP'); },
    _resolveFlagPush() { },
    _enqueueFlagPush() { throw new Error('Native flag intent must be persisted before dispatch'); },
};
type NativeOptions = Omit<FlagWriteOptions, 'uid' | 'folder'>;
export async function pushGraphMessageFlag(options: NativeOptions): Promise<MailFlagOutcome> {
    return pushProviderMessageFlag({ ...options, uid: 0, folder: '', manager: nativePort });
}
export async function pushGmailMessageFlag(options: NativeOptions): Promise<MailFlagOutcome> {
    return pushProviderMessageFlag({ ...options, uid: 0, folder: '', manager: nativePort });
}
export function mailFlagResponse(outcomes: Array<MailFlagOutcome & {
    id: string;
}>) {
    return {
        ok: true,
        updated: outcomes.filter(row => row.status === 'confirmed').map(row => row.id),
        pending: outcomes.filter(row => !['confirmed', 'permanent', 'conflict'].includes(row.status)).map(row => row.id),
        failed: outcomes.filter(row => ['permanent', 'conflict'].includes(row.status)).map(row => row.id),
        outcomes,
    };
}
