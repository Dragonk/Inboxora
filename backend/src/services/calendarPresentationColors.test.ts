import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(async () => ({ rows: [] })) }));
vi.mock('./db.js', () => mocks);
import { calendarColorFields, colorPreferenceMap, parseCalendarPresentationPatch, withCalendarPresentationColor, writeCalendarPresentationPatch } from './calendarPresentationColors.js';
beforeEach(() => { mocks.query.mockClear(); });
describe('personal calendar color presentation', () => {
  it('does not overwrite the source color', () => {
    const prefs = colorPreferenceMap([{ calendar_id: 'calendar', color_override: '#123456' }]);
    expect(calendarColorFields('calendar','#abcdef',prefs)).toEqual({ source_color: '#abcdef', color_override: '#123456', color: '#123456' });
  });
  it('applies the override to every event kind, including synthetic dates', () => {
    for (const id of ['materialized','expanded','contacts-birthdays']) {
      const prefs = colorPreferenceMap([{ calendar_id: id, color_override: '#123456' }]);
      expect(withCalendarPresentationColor({ calendar_id:id, calendar_color:'#abcdef', summary:'Own name' },prefs)).toEqual({ calendar_id:id, calendar_color:'#123456',calendar_source_color:'#abcdef',summary:'Own name' });
    }
  });
  it('resets to the source color without a persistent personal override', () => {
    expect(calendarColorFields('calendar','#abcdef',new Map([['calendar',null]]))).toEqual({ source_color:'#abcdef',color_override:null,color:'#abcdef' });
  });
  it('rejects invalid patch fields while accepting an explicit null reset', () => {
    expect(parseCalendarPresentationPatch({ colorOverride:null })).toEqual({ colorOverride:null });
    expect(parseCalendarPresentationPatch({ colorOverride:'red' })).toBeNull();
    expect(parseCalendarPresentationPatch({ colorOverride:'#123456',sidebarHidden:'false' })).toBeNull();
    expect(parseCalendarPresentationPatch({ colorOverride:'#123456',userId:'foreign' })).toBeNull();
  });
  it('keeps a hidden preference unchanged on a color-only write', async () => {
    await writeCalendarPresentationPatch('owner','calendar',{ colorOverride:'#123456' });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('CASE WHEN $5::boolean'), ['owner','calendar',null,'#123456',false,true]);
  });
  it('keeps color unchanged on a visibility-only write', async () => {
    await writeCalendarPresentationPatch('owner','calendar',{ sidebarHidden:false });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('CASE WHEN $6::boolean'), ['owner','calendar',false,null,true,false]);
  });
});
