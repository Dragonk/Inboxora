interface NativeMessageEvent {
  source: unknown;
  origin: string;
}

interface ExpectedWindow {
  location: { origin: string };
}

export function isTrustedNativeMessage(event: NativeMessageEvent, expectedWindow: ExpectedWindow = window) {
  return event.source === expectedWindow && event.origin === expectedWindow.location.origin;
}

export function createBoundedActionIdTracker(limit = 1000) {
  const ids = new Set<string>();

  return {
    has(id: string) {
      return ids.has(id);
    },

    remember(id: string) {
      if (ids.has(id)) return false;
      ids.add(id);

      while (ids.size > limit) {
        const oldestId = ids.values().next().value;
        if (oldestId === undefined) break;
        ids.delete(oldestId);
      }

      return true;
    },
  };
}
