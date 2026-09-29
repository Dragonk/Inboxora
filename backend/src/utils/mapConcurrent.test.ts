import { describe, expect, it } from 'vitest';
import { mapConcurrent } from './mapConcurrent.js';

describe('bounded ordered concurrency', () => {
  it('limits work to four requests and keeps order with mixed completion times', async () => {
    let active = 0; let high = 0;
    const result = await mapConcurrent(Array.from({ length: 11 }, (_, i) => i), 4, async n => {
      active++; high = Math.max(high, active);
      await new Promise(resolve => setTimeout(resolve, n % 2 ? 1 : 10));
      active--;
      return n === 3 ? 'unavailable' : String(n);
    });
    expect(high).toBe(4); expect(active).toBe(0);
    expect(result).toEqual(['0','1','2','unavailable','4','5','6','7','8','9','10']);
  });
  it('handles empty lists and rejects invalid limits and worker errors', async () => {
    expect(await mapConcurrent([], 4, async x => x)).toEqual([]);
    await expect(mapConcurrent([1], 0, async x => x)).rejects.toThrow(RangeError);
    await expect(mapConcurrent([1], 1, async () => { throw new Error('provider failed'); })).rejects.toThrow('provider failed');
  });
});
