import { describe, expect, it } from 'vitest';
import { eventMatchesSearch } from './eventSearch.js';
const event={summary:'Planning meeting',location:'Warsaw',organizer:{emailAddress:{name:'Żaneta',address:'zaneta@example.test'}},
  attendees:[{name:'Alice',status:'accepted',email:'alice@example.test'}]};
describe('event search matches values, not serialized field names',()=>{
  it.each(['alice','ŻANETA','accepted','WARSAW','planning'])('finds nested text %s',term=>expect(eventMatchesSearch(event,term)).toBe(true));
  it.each(['email','name','status','"',':','{',''])('does not match a key or JSON punctuation %s',term=>expect(eventMatchesSearch(event,term)).toBe(false));
  it('can match punctuation actually present in an event value',()=>expect(eventMatchesSearch({summary:'Question: "yes"'},':')).toBe(true));
  it('does not recurse forever on malformed cyclic objects',()=>{const cyclic:Record<string,unknown>={};cyclic.self=cyclic;expect(eventMatchesSearch({attendees:cyclic},'x')).toBe(false);});
});
