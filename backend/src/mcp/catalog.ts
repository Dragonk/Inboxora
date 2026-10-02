import { attachmentTools } from './attachmentTools.js';
import { mailReadTools } from './mailReadTools.js';
import { mailComposeTools } from './mailComposeTools.js';
import { mailActionTools } from './mailActionTools.js';
import { calendarTools } from './calendarTools.js';
import { contactTools } from './contactTools.js';
import { id, readTool } from './registry.js';
import { readOperation } from './operations.js';
import { resourceUrl } from './config.js';

import { GUIDE } from './guide.js';
export { GUIDE } from './guide.js';

export const tools = [
  ...mailReadTools, ...attachmentTools, ...mailComposeTools, ...mailActionTools, ...calendarTools, ...contactTools,
  readTool('get_capabilities', 'Read this integration’s permissions, resource restrictions and operating rules before using Inboxora.', null, {}, async grant => ({
    name: grant.name, endpoint: resourceUrl(), scopes: grant.scopes, restrictions: grant.restrictions,
    requireConfirmation: grant.require_confirmation, expiresAt: grant.expires_at, instructions: GUIDE,
    limits: { pageSize: 100, searchCharacters: 500, bodyCharactersPerPage: 60000, uploadedAttachmentBytes: 3 * 1024 * 1024, calendarRangeDays: 366 },
  })),
  readTool('get_operation', 'Read the status of a mutation submitted by this integration. Does not approve, dispatch or retry it.', null,
    { operationId: id }, (grant, args) => readOperation(grant, args.operationId)),
];
if (new Set(tools.map(tool => tool.definition.name)).size !== tools.length) throw new Error('Duplicate MCP tool names');
