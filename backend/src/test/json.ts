/**
 * Shape used by route tests when asserting on JSON response bodies. Fields are
 * optional because one interface covers success and error responses; the index
 * signature keeps additional, unasserted fields accessible.
 */
export interface JsonBody {
  error?: string;
  code?: string;
  slug?: string;
  folders?: Record<string, string>;
  results?: unknown[];
  reserved?: unknown[];
  collisions?: unknown[];
  devices?: unknown[];
  conversations?: Array<{ conversation_id?: string; account_id?: string; [key: string]: unknown }>;
  deviceToken?: string;
  eventId?: string | null;
  unreadCount?: number;
  events?: unknown[];
  truncated?: boolean;
  incompleteSeries?: unknown[];
  invitation?: { summary?: string; [key: string]: unknown };
  device?: { endpoint?: string; [key: string]: unknown };
  message?: { title?: string; [key: string]: unknown };
  birthday?: string | null;
  [key: string]: unknown;
}
