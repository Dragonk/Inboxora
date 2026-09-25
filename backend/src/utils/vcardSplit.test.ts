import { describe, expect, it } from 'vitest';
import { splitVCards } from './vcard.js';

const ADA = ['BEGIN:VCARD', 'VERSION:3.0', 'UID:ada-1', 'FN:Ada Lovelace', 'EMAIL:ada@example.test', 'END:VCARD'].join('\r\n');
const GRACE = ['BEGIN:VCARD', 'VERSION:3.0', 'UID:grace-1', 'FN:Grace Hopper', 'EMAIL:grace@example.test', 'END:VCARD'].join('\n');

describe('splitVCards', () => {
  it('splits a file that concatenates cards with different line endings', () => {
    const cards = splitVCards(`${ADA}\r\n${GRACE}\r\n`);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain('UID:ada-1');
    expect(cards[1]).toContain('UID:grace-1');
  });

  it('keeps a folded line inside its own card', () => {
    const folded = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:f1\r\nNOTE:a long note that was\r\n folded here\r\nEND:VCARD';
    const cards = splitVCards(folded);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain(' folded here');
  });

  it('ignores everything outside a card and a BOM before the first one', () => {
    const cards = splitVCards(`\uFEFFnotes the user pasted above\n\n${ADA}\n\nsome trailing text\n`);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain('FN:Ada Lovelace');
  });

  it('does not treat an empty block as a card', () => {
    expect(splitVCards('BEGIN:VCARD\r\nEND:VCARD')).toEqual([]);
  });

  it('yields nothing when the file has no card at all, so the caller can report it', () => {
    expect(splitVCards('')).toEqual([]);
    expect(splitVCards('just,some,csv\na,b,c')).toEqual([]);
    expect(splitVCards('BEGIN:VCARD\r\nUID:unterminated')).toEqual([]);
  });
});
