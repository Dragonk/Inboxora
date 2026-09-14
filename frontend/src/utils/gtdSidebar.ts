export const GTD_SIDEBAR_PREVIEW_LIMITS = Object.freeze({
  todo: 6,
  waiting: 6,
  reference: 3,
  someday: 3,
});

type GtdSidebarPreviewKey = keyof typeof GTD_SIDEBAR_PREVIEW_LIMITS;

type GtdSidebarSection<Thread> = {
  key?: string;
  threads?: readonly Thread[] | null;
  total?: unknown;
};

function isGtdSidebarPreviewKey(key: string | undefined): key is GtdSidebarPreviewKey {
  return key === 'todo' || key === 'waiting' || key === 'reference' || key === 'someday';
}

function previewLimit(section: GtdSidebarSection<unknown> | null | undefined): number {
  if (section === null || section === undefined || !isGtdSidebarPreviewKey(section.key)) return 6;
  return GTD_SIDEBAR_PREVIEW_LIMITS[section.key];
}

function previewThreads<Thread>(section: GtdSidebarSection<Thread> | null | undefined): readonly Thread[] {
  if (section === null || section === undefined || !Array.isArray(section.threads)) return [];
  return section.threads;
}

function previewTotal(section: GtdSidebarSection<unknown> | null | undefined, available: number): number {
  if (section === null || section === undefined) return available;
  const value = Number(section.total);
  return Math.max(Number.isNaN(value) ? 0 : value, available);
}

export function getGtdSidebarPreview<Thread>(
  section: GtdSidebarSection<Thread> | null | undefined,
  expanded: boolean,
) {
  const allThreads = previewThreads(section);
  const limit = previewLimit(section);
  const available = allThreads.length;
  const total = previewTotal(section, available);

  return {
    threads: expanded ? allThreads : allThreads.slice(0, limit),
    limit,
    available,
    total,
    expandable: available > limit,
    bounded: total > available,
  };
}
