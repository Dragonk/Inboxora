// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixtures = vi.hoisted(() => ({ request: vi.fn(), currentEpoch: 1 }));
vi.mock('./api.ts', () => ({ api: { mcp: { request: fixtures.request } } }));
vi.mock('./authEpoch.ts', () => ({ getAuthEpoch: () => fixtures.currentEpoch, isCurrentAuthEpoch: (epoch: number) => epoch === fixtures.currentEpoch }));
import { clearMcpReturn, mcpRequest, newMcpGrant, pendingMcpReturn, rememberMcpReturn, safeMcpReturn } from './mcp.ts';
beforeEach(() => { sessionStorage.clear(); fixtures.currentEpoch = 1; fixtures.request.mockReset(); });
describe('MCP connection safety', () => {
  it('starts with read-only scopes and human confirmation', () => {
    expect(newMcpGrant()).toMatchObject({ scopes: ['mail.read','calendar.read','contacts.read'], requireConfirmation: true, expiresInDays: 90 });
  });
  it('only restores exact internal consent paths, not arbitrary redirects', () => {
    const path = `/ai/mcp/authorize?request=${'a'.repeat(43)}`;
    expect(safeMcpReturn(path)).toBe(path);
    for (const value of ['https://attacker.example','//attacker.example',path+'&redirect=https://attacker.example','/api/mcp/tokens',null]) expect(safeMcpReturn(value)).toBeNull();
    rememberMcpReturn(path); expect(pendingMcpReturn()).toBe(path);
    clearMcpReturn(); expect(pendingMcpReturn()).toBeNull();
  });
  it('never exposes a token returned after the authenticated identity changes', async () => {
    let resolve: (value: unknown) => void = () => {};
    fixtures.request.mockReturnValue(new Promise<unknown>((value: (result: unknown) => void) => { resolve = value; }));
    const request = mcpRequest('POST','/tokens',{name:'Fixture'});
    fixtures.currentEpoch = 2;
    resolve({token:'synthetic-secret'});
    await expect(request).rejects.toThrow('Session changed');
  });
});
