import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/index.ts';
import { api } from '../utils/api.ts';
import { installCapacitorNativeBridge } from '../utils/capacitorNativeBridge.ts';
import { createBoundedActionIdTracker, isTrustedNativeMessage } from '../utils/nativeActionSecurity.ts';
import type { StoreMessageRow, StoreState } from '../store/index.ts';
import { toAppError } from '../utils/errors.ts';

function linuxInstructionPath(filePath: string | null | undefined) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  if (!normalized) return null;
  return normalized.replace(/^\/home\/[^/]+(?=\/)/, '$HOME');
}

function getLinuxInstallCommandFromPath(filePath: string | null | undefined) {
  const normalized = linuxInstructionPath(filePath);
  if (!normalized) return null;

  const escaped = normalized.startsWith('$HOME/')
    ? normalized.replace(/(["\\`])/g, '\\$1')
    : normalized.replace(/(["\\$`])/g, '\\$1');
  const quotedPath = `"${escaped}"`;

  if (/\.deb$/i.test(normalized)) return `sudo apt install ${quotedPath}`;
  if (/\.rpm$/i.test(normalized)) return `sudo dnf install ${quotedPath}`;
  return null;
}

function isLinuxPackagePath(filePath: string | null | undefined) {
  return /\.(deb|rpm)$/i.test(String(filePath || ''));
}

type NativeAction = 'new-mail' | 'open-message' | 'reply-message' | 'delete-message' | 'star-message' | 'sync';

interface NativeComposeData {
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject?: string;
  body?: string;
  [key: string]: unknown;
}

interface NativeActionPayload {
  action: NativeAction;
  id?: string;
  messageId?: string;
  accountId?: string;
  folder?: string;
  message?: StoreMessageRow;
  composeData?: NativeComposeData;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNativeComposeData(value: unknown): value is NativeComposeData {
  if (!isRecord(value)) return false;
  const recipientFields = ['to', 'cc', 'bcc'];
  const textFields = ['subject', 'body'];
  return recipientFields.every((field) => {
    const recipient = value[field];
    return recipient === undefined || typeof recipient === 'string' || isStringList(recipient);
  }) && textFields.every((field) => value[field] === undefined || typeof value[field] === 'string');
}

function isStoreMessageRow(value: unknown): value is StoreMessageRow {
  return isRecord(value) && typeof value.id === 'string' && typeof value.account_id === 'string';
}

function nativeActionFrom(value: unknown): NativeAction | null {
  switch (value) {
    case 'new-mail':
    case 'open-message':
    case 'reply-message':
    case 'delete-message':
    case 'star-message':
    case 'sync':
      return value;
    default:
      return null;
  }
}

function parseNativeActionPayload(value: unknown): NativeActionPayload | null {
  const action = nativeActionFrom(typeof value === 'string' ? value : isRecord(value) ? value.action : undefined);
  if (!action || !isRecord(value)) return action ? { action } : null;
  if (
    (value.id !== undefined && typeof value.id !== 'string')
    || (value.messageId !== undefined && typeof value.messageId !== 'string')
    || (value.accountId !== undefined && typeof value.accountId !== 'string')
    || (value.folder !== undefined && typeof value.folder !== 'string')
    || (value.message !== undefined && !isStoreMessageRow(value.message))
    || (value.composeData !== undefined && !isNativeComposeData(value.composeData))
  ) return null;

  const payload: NativeActionPayload = { action };
  if (typeof value.id === 'string') payload.id = value.id;
  if (typeof value.messageId === 'string') payload.messageId = value.messageId;
  if (typeof value.accountId === 'string') payload.accountId = value.accountId;
  if (typeof value.folder === 'string') payload.folder = value.folder;
  if (isStoreMessageRow(value.message)) payload.message = value.message;
  if (isNativeComposeData(value.composeData)) payload.composeData = value.composeData;
  return payload;
}

export default function ElectronNotificationBridge() {
  const addNotification = useStore((state: StoreState) => state.addNotification);
  const openCompose = useStore((state: StoreState) => state.openCompose);
  const setSelectedAccount = useStore((state: StoreState) => state.setSelectedAccount);
  const setSelectedMessage = useStore((state: StoreState) => state.setSelectedMessage);
  const setSearchQuery = useStore((state: StoreState) => state.setSearchQuery);
  const totalUnread = useStore((state: StoreState) => state.unreadCounts.total);
  const lastActionRef = useRef<{ action: NativeAction | null; time: number }>({ action: null, time: 0 });
  const processedActionIdsRef = useRef(createBoundedActionIdTracker());
  const [nativeBridgeReady, setNativeBridgeReady] = useState(() => Boolean(window.inboxoraNative));

  useEffect(() => {
    let cancelled = false;
    installCapacitorNativeBridge().then(() => {
      if (!cancelled) setNativeBridgeReady(Boolean(window.inboxoraNative));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!nativeBridgeReady) return undefined;
    window.__inboxoraNativeBridgeReady = true;

    return () => {
      window.__inboxoraNativeBridgeReady = false;
    };
  }, [nativeBridgeReady]);

  useEffect(() => {
    if (!nativeBridgeReady) return;
    window.inboxoraNative?.badges?.setUnreadCount?.(totalUnread || 0);
  }, [nativeBridgeReady, totalUnread]);

  useEffect(() => {
    if (!nativeBridgeReady) return undefined;
    const unsubscribe = window.inboxoraNative?.notifications?.onPush?.((notification) => {
      addNotification({
        type: notification.type === 'negative' ? 'error' : notification.type,
        title: notification.title,
        body: notification.body || notification.message,
      });
    });

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [addNotification, nativeBridgeReady]);

  useEffect(() => {
    if (!nativeBridgeReady) return undefined;
    const unsubscribe = window.inboxoraNative?.updates?.onStatus?.((status) => {
      if (status?.type !== 'downloaded') return;

      const platform = window.inboxoraNative?.platform;
      const filePath = status?.data?.filePath || status?.data?.updatePath || '';
      const installCommand = status?.data?.installCommand
        || (platform === 'linux' ? getLinuxInstallCommandFromPath(filePath) : null);
      const manualInstall = Boolean(
        status?.data?.manualInstall
        || installCommand
        || (platform === 'linux' && (isLinuxPackagePath(filePath) || status?.data?.manual))
      );
      addNotification({
        type: 'success',
        title: 'Update ready',
        body: manualInstall
          ? `Inboxora downloaded and verified the update.${installCommand ? ` Install it from a terminal with:\n${installCommand}` : ''}`
          : 'Inboxora downloaded the update.',
        allowWrap: true,
        persistent: true,
        actionLabel: manualInstall ? 'Copy & Quit' : 'Install',
        onAction: async () => {
          if (manualInstall) {
            const result = await window.inboxoraNative?.updates?.copyInstallCommandAndQuit?.({
              installCommand,
              filePath,
            });
            if (!result?.copied) {
              addNotification({
                type: 'error',
                title: 'Copy failed',
                body: 'The update command could not be copied.',
              });
            }
            return;
          }

          const result = await window.inboxoraNative?.updates?.installDownloaded?.();
          if (result?.reason === 'manual-install-required' && result.installCommand) {
            addNotification({
              type: 'success',
              title: 'Update ready',
              body: `Inboxora downloaded and verified the update. Install it from a terminal with:\n${result.installCommand}`,
              allowWrap: true,
              persistent: true,
              actionLabel: 'Copy & Quit',
              onAction: async () => {
                await window.inboxoraNative?.updates?.copyInstallCommandAndQuit?.({
                  installCommand: result.installCommand,
                  filePath,
                });
              },
            });
            return;
          }

          if (result && result.installed === false) {
            addNotification({
              type: 'error',
              title: 'Install failed',
              body: 'The update was downloaded, but the installer could not be started.',
            });
          }
        },
      });
    });

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [addNotification, nativeBridgeReady]);

  useEffect(() => {
    if (!nativeBridgeReady) return;
    if (window.inboxoraNative?.platform !== 'android') return;
    window.inboxoraNative?.updates?.check?.(false)?.catch?.(() => {});
  }, [nativeBridgeReady]);

  useEffect(() => {
    if (!nativeBridgeReady) return undefined;
    const getPayloadMessage = (payload: NativeActionPayload) => {
      if (payload.message) return payload.message;
      if (!payload.messageId) return null;
      return useStore.getState().messages.find((item) => item.id === payload.messageId) || null;
    };

    const openMessageFromPayload = (payload: NativeActionPayload) => {
      const { messageId } = payload;
      if (!messageId) return null;

      const folder = payload.folder || 'INBOX';
      const message = getPayloadMessage(payload);
      const state = useStore.getState();

      setSearchQuery('');
      if (payload.accountId) {
        setSelectedAccount(payload.accountId, folder);
      }

      if (message && !state.messages.some((item: Record<string, unknown>) => item.id === message.id)) {
        useStore.setState((current) => ({
          messages: [message, ...current.messages],
        }));
      }

      window.dispatchEvent(new CustomEvent('inboxora:refresh'));
      window.setTimeout(() => setSelectedMessage(messageId), 0);
      return message;
    };

    const isRecipient = (value: unknown): value is { email: string; name?: string | null } => {
      return isRecord(value)
        && typeof value.email === 'string'
        && (value.name === undefined || value.name === null || typeof value.name === 'string');
    };

    const normalizeAddressList = (value: unknown): Array<{ email: string; name?: string | null }> => {
      const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
      return Array.isArray(parsed) ? parsed.filter(isRecipient) : [];
    };

    const openReplyFromPayload = (payload: NativeActionPayload) => {
      const message = getPayloadMessage(payload);
      if (!message) return;

      let replyTarget: { email: string; name?: string | null } | null;
      try {
        const replyTo = normalizeAddressList(message.reply_to);
        replyTarget = replyTo[0] || null;
      } catch {
        replyTarget = null;
      }
      if (!replyTarget && message.from_email) {
        replyTarget = { name: message.from_name, email: message.from_email };
      }
      const sender = replyTarget ? [replyTarget] : [];
      const rawSubject = message.subject?.trim() || '';
      const subject = rawSubject.startsWith('Re:') ? rawSubject : rawSubject ? `Re: ${rawSubject}` : 'Re:';
      const originalMessageId = message.message_id || null;

      openCompose({
        to: sender,
        cc: [],
        subject,
        body: '',
        inReplyTo: originalMessageId,
        references: originalMessageId,
        accountId: message.account_id,
        isReply: true,
        originalFrom: sender,
        allRecipients: [],
      });
    };

    const runNativeAction = async (value: unknown) => {
      const payload = parseNativeActionPayload(value);
      if (!payload) return;

      const { action, id } = payload;
      if (id && !processedActionIdsRef.current.remember(id)) return;

      const now = Date.now();
      const last = lastActionRef.current;

      if (!id && last.action === action && now - last.time < 500) return;
      lastActionRef.current = { action, time: now };

      try {
        if (action === 'new-mail') {
          openCompose(payload.composeData);
          return;
        }

        if (action === 'open-message') {
          openMessageFromPayload(payload);
          return;
        }

        if (action === 'reply-message') {
          openReplyFromPayload(payload);
          return;
        }

        if (action === 'delete-message') {
          const { messageId } = payload;
          if (!messageId) return;

          await api.deleteMessage(messageId);
          useStore.getState().removeMessage(messageId);
          window.dispatchEvent(new CustomEvent('inboxora:refresh'));
          return;
        }

        if (action === 'star-message') {
          const { messageId } = payload;
          if (!messageId) return;

          await api.markStarred(messageId, true);
          useStore.getState().updateMessage(messageId, { is_starred: true });
          return;
        }

        if (action === 'sync') {
          try {
            addNotification({
              type: 'info',
              title: 'Sync started',
              body: 'Inboxora is checking for new mail.',
            });
            await api.syncNow();
          } catch (error) {
            addNotification({
              type: 'error',
              title: 'Sync failed',
              body: toAppError(error).message || 'Could not sync mail.',
            });
          }
        }
      } finally {
        if (id) {
          window.inboxoraNative?.actions?.ack?.(id);
        }
      }
    };

    const handleNativeAction = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      runNativeAction(event.detail);
    };

    const handleNativeMessage = (event: Event) => {
      if (!(event instanceof MessageEvent)) return;
      if (!isTrustedNativeMessage(event) || !isRecord(event.data)) return;
      if (event.data.type === 'inboxora:native-action') {
        runNativeAction(event.data.payload);
      } else if (event.data.type === 'inboxora:native-actions-ready') {
        drainInjectedActions();
      }
    };

    const drainInjectedActions = () => {
      // The Android shell injects into __inboxoraPendingNativeActions; the
      // Electron shell has historically used __mailflowPendingNativeActions.
      // Read (and clear) whichever is present so a notification action is never
      // dropped on a cold start.
      const queue = [window.__inboxoraPendingNativeActions, window.__mailflowPendingNativeActions]
        .find(candidate => Array.isArray(candidate));
      const actions = queue ? queue.splice(0) : [];
      actions.forEach(runNativeAction);
    };

    const unsubscribe = window.inboxoraNative?.actions?.onAction?.((payload) => {
      runNativeAction(payload);
    });

    window.inboxoraNative?.actions?.getPending?.()
      .then((actions) => {
        actions.forEach(runNativeAction);
      })
      .catch(() => {});

    drainInjectedActions();
    window.addEventListener('inboxora:native-action', handleNativeAction);
    window.addEventListener('inboxora:native-actions-ready', drainInjectedActions);
    window.addEventListener('message', handleNativeMessage);
    return () => {
      window.removeEventListener('inboxora:native-action', handleNativeAction);
      window.removeEventListener('inboxora:native-actions-ready', drainInjectedActions);
      window.removeEventListener('message', handleNativeMessage);
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [addNotification, nativeBridgeReady, openCompose, setSearchQuery, setSelectedAccount, setSelectedMessage]);

  return null;
}
