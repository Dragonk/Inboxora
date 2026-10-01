import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { liveGrant, requireScope, type Grant, type Scope } from './policy.js';
import { runOperation } from './operations.js';
import type { DomainResult } from './bridge.js';

export interface RegisteredTool {
  definition: Tool;
  scope: Scope | null;
  invoke: (grant: Grant, input: unknown) => Promise<Record<string, unknown>>;
}
export function readTool<S extends z.ZodRawShape>(name: string, description: string, scope: Scope | null,
  shape: S, read: (grant: Grant, args: z.output<z.ZodObject<S>>) => Promise<Record<string, unknown>>): RegisteredTool {
  const schema = z.object(shape).strict();
  return {
    scope,
    definition: { name, description, inputSchema: z.toJSONSchema(schema, { io: 'input' }) as Tool['inputSchema'],
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
    async invoke(grant, input) {
      const current = await liveGrant(grant.id, grant.user_id, grant.scopes);
      if (scope) requireScope(current, scope);
      return read(current, schema.parse(input));
    },
  };
}
const requestId = z.string().min(1).max(128).describe('Stable unique ID for this exact intended operation, reused for approval and retries. Never change it to retry an uncertain result.');
export function writeTool<S extends z.ZodRawShape>(name: string, description: string, scope: Scope, shape: S,
  authorize: (grant: Grant, args: z.output<z.ZodObject<S & { requestId: typeof requestId }>>) => Promise<void>,
  execute: (grant: Grant, args: z.output<z.ZodObject<S & { requestId: typeof requestId }>>, operationId: string) => Promise<DomainResult>): RegisteredTool {
  const schema = z.object({ ...shape, requestId }).strict();
  return {
    scope,
    definition: { name, description: `${description} Writes may require user approval in Inboxora. A pending approval is not a completed operation.`,
      inputSchema: z.toJSONSchema(schema, { io: 'input' }) as Tool['inputSchema'],
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } },
    async invoke(grant, input) {
      const args = schema.parse(input);
      return runOperation(grant, name, args, async current => { requireScope(current, scope); await authorize(current, args); },
        operationId => execute(grant, args, operationId));
    },
  };
}
export const id = z.uuid();
export const page = { limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).max(5000).default(0) };
export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item)) : [];
}
export function selectedFields(value: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter(field => Object.prototype.hasOwnProperty.call(value, field)).map(field => [field, value[field]]));
}
export function queryPath(path: string, params: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
  return `${path}?${query}`;
}
