import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { alignReaderHeader, readerVisibleTop } from './readerScrollAlignment.js';

function rect(top, bottom = top + 40) { return { top, bottom }; }

function reader({ top = 100, scrollTop = 0, scrollHeight = 3000, clientHeight = 600, sticky = [] } = {}) {
  return {
    scrollTop, scrollHeight, clientHeight,
    getBoundingClientRect: () => rect(top, top + clientHeight),
    querySelectorAll: selector => selector === '[data-conversation-reader-sticky="true"]' ? sticky : [],
  };
}

describe('reader header alignment', () => {
  it('places the selected physical header immediately below actual sticky obstruction', () => {
    const sticky = { getBoundingClientRect: () => rect(100, 156) };
    const viewport = reader({ scrollTop: 120, sticky: [sticky] });
    const header = { getBoundingClientRect: () => rect(476, 516) };
    alignReaderHeader(viewport, header, 8);
    const headerTopAfterScroll = 476 - (viewport.scrollTop - 120);
    const visibleReaderTop = readerVisibleTop(viewport);
    assert.ok(headerTopAfterScroll >= visibleReaderTop);
    assert.ok(headerTopAfterScroll <= visibleReaderTop + 12);
  });

  it('uses the reader viewport itself below mobile parent chrome, not a desktop offset', () => {
    const viewport = reader({ top: 184, scrollTop: 400 });
    const header = { getBoundingClientRect: () => rect(564, 604) };
    alignReaderHeader(viewport, header, 8);
    assert.equal(viewport.scrollTop, 772);
  });

  it('uses final max scroll for a short terminal card but preserves header alignment for a long card', () => {
    const short = reader({ top: 100, scrollTop: 400, scrollHeight: 2000, clientHeight: 800 });
    const shortCard = { getBoundingClientRect: () => rect(500, 760), nextElementSibling: null };
    const shortHeader = { getBoundingClientRect: () => rect(500, 540), closest: () => shortCard };
    alignReaderHeader(short, shortHeader, 8);
    assert.equal(short.scrollTop, 1200);

    const long = reader({ top: 100, scrollTop: 400, scrollHeight: 3000, clientHeight: 800 });
    const longCard = { getBoundingClientRect: () => rect(500, 2100), nextElementSibling: null };
    const longHeader = { getBoundingClientRect: () => rect(500, 540), closest: () => longCard };
    alignReaderHeader(long, longHeader, 8);
    assert.equal(long.scrollTop, 792);
  });

  it('clamps safely at the start and end of the scroll range', () => {
    const atStart = reader({ scrollTop: 0 });
    alignReaderHeader(atStart, { getBoundingClientRect: () => rect(80, 120) }, 8);
    assert.equal(atStart.scrollTop, 0);
    const atEnd = reader({ scrollTop: 2380, scrollHeight: 3000, clientHeight: 600 });
    alignReaderHeader(atEnd, { getBoundingClientRect: () => rect(900, 940) }, 8);
    assert.equal(atEnd.scrollTop, 2400);
  });
});
