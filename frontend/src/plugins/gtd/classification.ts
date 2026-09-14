import type { GTD_STATES } from '../../utils/gtd.ts';
import type { api as appApi } from '../../utils/api.ts';

/** One of the five GTD states (todo/watch/delegated/someday/reference). */
type GtdState = (typeof GTD_STATES)[number];

/** The api methods the classify/undo flow drives — taken from the shared api object. */
type GtdClassifyApi = Pick<typeof appApi, 'gtdClassify' | 'gtdUndoClassify'>;

/** The notification shape this module emits and the store accepts. */
type GtdNotification = {
  pluginId: string;
  title: string;
  body: string;
  type?: string;
  onUndo?: () => Promise<boolean>;
};

/** The store slice the classify/undo flow drives. */
type GtdClassifyStore = {
  addNotification: (notification: GtdNotification) => void;
  scheduleGtdSectionsFetch: () => void;
};

/** The collaborators classifyWithUndo needs, so it stays free of store/React imports. */
type GtdClassifyDeps = {
  api: GtdClassifyApi;
  store: GtdClassifyStore;
  t: (key: string) => string;
};

export async function classifyWithUndo(messageId: string, state: GtdState, {
  api,
  store,
  t,
}: GtdClassifyDeps) {
  try {
    const result = await api.gtdClassify(messageId, state);
    store.scheduleGtdSectionsFetch();

    const notification: GtdNotification = {
      pluginId: 'gtd',
      title: t('gtd.classified'),
      body: t(`gtd.state.${state}`),
    };

    if (result?.applied && result.undoToken) {
      let consumed = false;
      notification.onUndo = async () => {
        if (consumed) return false;
        consumed = true;
        try {
          await api.gtdUndoClassify(result.undoToken);
          store.scheduleGtdSectionsFetch();
          return true;
        } catch (err) {
          console.error('GTD classification undo failed:', err);
          store.addNotification({
            pluginId: 'gtd',
            type: 'error',
            title: t('gtd.undoFailed'),
            body: t(`gtd.state.${state}`),
          });
          return false;
        }
      };
    }

    store.addNotification(notification);
    return result;
  } catch (err) {
    console.error('GTD classify failed:', err);
    store.addNotification({
      pluginId: 'gtd',
      type: 'error',
      title: t('gtd.classifyFailed'),
      body: t(`gtd.state.${state}`),
    });
    return null;
  }
}

/** The notification fields undoLatestGtdNotification reads; store rows carry other, unknown-valued fields. */
type GtdNotificationRow = {
  id: string;
  pluginId?: unknown;
  onUndo?: unknown;
};

/** A GTD notification that actually offers an undo action. */
type UndoableGtdNotification = GtdNotificationRow & {
  pluginId: 'gtd';
  onUndo: () => unknown;
};

export function undoLatestGtdNotification(
  notifications: ReadonlyArray<GtdNotificationRow>,
  removeNotification: (id: string) => void,
) {
  const notification = notifications.find(
    (item): item is UndoableGtdNotification => (
      item.pluginId === 'gtd' && typeof item.onUndo === 'function'
    ),
  );
  if (!notification) return false;

  removeNotification(notification.id);
  void notification.onUndo();
  return true;
}
