import { describe, expect, it } from 'vitest';
import {
  createEmptyModel, updateIncremental, classifyMessage, blendScores,
  pruneVocabulary, retrainFromRecords, extractTopTokens, isModelMature,
} from './spamModel.js';

describe('spam Naive Bayes model', () => {
  it('starts uncertain on a cold model', () => {
    const result = classifyMessage(createEmptyModel(), ['viagra'], null);
    expect(result.verdict).toBe('uncertain');
    expect(result.probability).toBe(0.5);
  });

  it('learns spam tokens incrementally', () => {
    let model = createEmptyModel();
    model = updateIncremental(model, ['viagra', 'prize'], null, 'spam');
    model = updateIncremental(model, ['meeting', 'agenda'], null, 'ham');
    const result = classifyMessage(model, ['viagra'], null);
    expect(result.verdict).toBe('spam');
    expect(result.probability).toBeGreaterThan(0.5);
  });

  it('stays in rules-only mode below 50 records', () => {
    expect(blendScores(0.99, 0.2, 10)).toBe(0.2);
    expect(blendScores(0.99, 0.2, 100)).toBeCloseTo(0.6 * 0.2 + 0.4 * 0.99, 5);
    expect(blendScores(0.99, 0.2, 1000)).toBeCloseTo(0.2 * 0.2 + 0.8 * 0.99, 5);
  });

  it('prunes rare and stopword-like tokens', () => {
    let model = createEmptyModel();
    model = updateIncremental(model, ['rareword'], null, 'spam');
    model = updateIncremental(model, ['rareword', 'common'], null, 'spam');
    model = updateIncremental(model, ['common'], null, 'ham');
    const pruned = pruneVocabulary(model, 10000);
    expect(pruned.vocabulary['rareword']).toBeUndefined();
  });

  it('retrains with time decay from log records', () => {
    const now = new Date('2026-09-18T00:00:00Z');
    const model = retrainFromRecords([
      { label: 'spam', created_at: new Date('2026-09-17T00:00:00Z'), token_counts: { viagra: 2 }, flag_features: null },
      { label: 'ham', created_at: new Date('2026-06-01T00:00:00Z'), token_counts: { meeting: 1 }, flag_features: null },
    ], 90, now);
    expect(model.trainingRecords).toBe(2);
    expect(model.totalSpam).toBeGreaterThan(model.totalHam);
  });

  it('counts one mail confirmed many times as a single usable sample', () => {
    const now = new Date('2026-09-18T00:00:00Z');
    const rows = Array.from({ length: 50 }, () => ({
      label: 'spam',
      created_at: now,
      message_id_header: '<same@mail.example>',
      token_counts: { viagra: 2 },
      flag_features: null,
    }));
    const model = retrainFromRecords(rows, 90, now);
    expect(model.trainingRecords).toBe(50);
    expect(model.usableSpam).toBe(1);
    expect(model.usableHam).toBe(0);
    expect(isModelMature(model, { minRecords: 50 })).toBe(false);
  });

  it('requires a minimum of each class before ML activates', () => {
    const now = new Date('2026-09-18T00:00:00Z');
    const spamOnly = Array.from({ length: 60 }, (_, i) => ({
      label: 'spam',
      created_at: now,
      message_id_header: `<spam-${i}@mail.example>`,
      token_counts: { viagra: 1 },
      flag_features: null,
    }));
    expect(isModelMature(retrainFromRecords(spamOnly, 90, now), { minRecords: 50 })).toBe(false);
    const mixed = [
      ...spamOnly.slice(0, 40),
      ...Array.from({ length: 12 }, (_, i) => ({
        label: 'ham',
        created_at: now,
        message_id_header: `<ham-${i}@mail.example>`,
        token_counts: { meeting: 1 },
        flag_features: null,
      })),
    ];
    const model = retrainFromRecords(mixed, 90, now);
    expect(model.usableSpam).toBe(40);
    expect(model.usableHam).toBe(12);
    expect(isModelMature(model, { minRecords: 50 })).toBe(true);
  });

  it('ignores legacy featureless rows when counting usable samples', () => {
    const now = new Date('2026-09-18T00:00:00Z');
    const rows = Array.from({ length: 60 }, (_, i) => ({
      label: i % 2 === 0 ? 'spam' : 'ham',
      created_at: now,
      message_id_header: `<legacy-${i}@mail.example>`,
      token_counts: null,
      subject: null,
      body_text: null,
      flag_features: null,
    }));
    const model = retrainFromRecords(rows, 90, now);
    expect(model.trainingRecords).toBe(60);
    expect(model.usableSpam).toBe(0);
    expect(model.usableHam).toBe(0);
    expect(isModelMature(model, { minRecords: 50 })).toBe(false);
  });

  it('explains top tokens', () => {
    let model = createEmptyModel();
    model = updateIncremental(model, ['viagra'], null, 'spam');
    model = updateIncremental(model, ['meeting'], null, 'ham');
    const top = extractTopTokens(model, ['viagra', 'meeting', 'unknown'], 5);
    expect(top.length).toBe(2);
    expect(top[0]?.token).toBe('viagra');
    expect(top[0]?.contribution).not.toBe(0);
    expect(top[1]?.token).toBe('meeting');
  });

  it('applies latest-decision-wins for a corrected Spam→Ham message', () => {
    const earlier = new Date('2026-09-18T09:00:00Z');
    const later = new Date('2026-09-18T09:05:00Z');
    const spamRow = {
      id: 'row-1', label: 'spam', created_at: earlier,
      message_id_header: '<same@mail.example>', training_identity: 'mid:<same@mail.example>',
      token_counts: { viagra: 2 }, flag_features: null,
    };
    const hamRow = {
      id: 'row-2', label: 'ham', created_at: later,
      message_id_header: '<same@mail.example>', training_identity: 'mid:<same@mail.example>',
      token_counts: { viagra: 1 }, flag_features: null,
    };
    // Order-independent: newest decision wins regardless of input order.
    for (const rows of [[spamRow, hamRow], [hamRow, spamRow]]) {
      const model = retrainFromRecords(rows, 90, later);
      expect(model.trainingRecords).toBe(2);
      expect(model.usableSpam).toBe(0);
      expect(model.usableHam).toBe(1);
      // The earlier spam row must not teach the vocabulary: only the latest
      // (ham) row trains.
      expect(model.vocabulary['viagra']).toEqual({ spam: 0, ham: 1 });
    }
  });

  it('counts a re-confirmed same-label mail once under stored training_identity', () => {
    const now = new Date('2026-09-18T00:00:00Z');
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: `row-${i}`, label: 'spam', created_at: now,
      message_id_header: '<same@mail.example>', training_identity: 'mid:<same@mail.example>',
      token_counts: { viagra: 2 }, flag_features: null,
    }));
    const model = retrainFromRecords(rows, 90, now);
    expect(model.trainingRecords).toBe(50);
    expect(model.usableSpam).toBe(1);
    expect(model.usableHam).toBe(0);
    expect(isModelMature(model, { minRecords: 50 })).toBe(false);
  });
});
