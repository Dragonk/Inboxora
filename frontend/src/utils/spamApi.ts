import { CSRF_HEADER, CSRF_VALUE } from './api.ts';

const BASE = '/api';

export interface SpamStatus {
  enabled: boolean;
  masterEnabled: boolean;
  antispamAccounts: number;
  modelVersion: number | null;
  trainingRecords: number;
  lastTrainedAt: string | null;
  decayThresholdDays: number;
  maturity: 'mature' | 'fresh' | 'insufficient';
}

export interface SpamExplain {
  verdict: string | null;
  storedScore: number | null;
  method: string;
  confidence: number;
  rulesFired: Array<{ name: string; weight: number }>;
  rulesScore: number;
  mlProbability: number | null;
  mlTopTokens: Array<{ token: string; contribution: number }>;
  storedDetails: unknown;
}

async function spamRequest<T>(method: string, path: string, body: unknown = undefined): Promise<T> {
  const headers: Record<string, string> = { [CSRF_HEADER]: CSRF_VALUE };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    credentials: 'include',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Spam request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const spamApi = {
  status: () => spamRequest<SpamStatus>('GET', '/spam/status'),
  explain: (messageId: string) => spamRequest<SpamExplain>('GET', `/spam/explain?messageId=${encodeURIComponent(messageId)}`),
  setEnabled: (enabled: boolean) => spamRequest<{ enabled: boolean }>('POST', '/spam/enable', { enabled }),
  retrainNow: () => spamRequest<{ ok: boolean }>('POST', '/spam/retrain-now', {}),
  setDecay: (decayThresholdDays: number) =>
    spamRequest<{ decayThresholdDays: number }>('PATCH', '/spam/decay-threshold', { decayThresholdDays }),
  resetAll: () => spamRequest<{ ok: boolean }>('POST', '/spam/reset-training-all', { confirm: true }),
  resetAccount: (accountId: string) =>
    spamRequest<{ ok: boolean }>('POST', `/accounts/${encodeURIComponent(accountId)}/spam/reset-training`, { confirm: true }),
};
