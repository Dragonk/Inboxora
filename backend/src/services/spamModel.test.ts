import { describe, expect, it } from 'vitest';
import {
  createEmptyModel, updateIncremental, classifyMessage, blendScores,
  pruneVocabulary, retrainFromRecords, extractTopTokens,
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
});
