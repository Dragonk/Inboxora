import { describe, expect, it } from 'vitest';
import { canonicalJson, classifyOperation } from './operations.js';

describe('MCP operation integrity', () => {
  it('binds semantic arguments independent of object key order, preserving recipient order and text', () => {
    expect(canonicalJson({b:2,a:{z:'text',r:['a','b']}})).toBe(canonicalJson({a:{r:['a','b'],z:'text'},b:2}));
    expect(canonicalJson({to:['a','b']})).not.toBe(canonicalJson({to:['b','a']}));
    expect(canonicalJson({body:'ok'})).not.toBe(canonicalJson({body:'different'}));
  });
  it('does not misreport an uncertain, partially applied or pending provider write as success', () => {
    expect(classifyOperation({status:200,body:{ok:true}})).toBe('succeeded');
    expect(classifyOperation({status:200,body:{pending:['message']}})).toBe('partial');
    expect(classifyOperation({status:200,body:{invitationError:'SMTP failed'}})).toBe('partial');
    expect(classifyOperation({status:200,body:{failed:['message']}})).toBe('partial');
    expect(classifyOperation({status:409,body:{code:'SEND_OUTCOME_UNKNOWN'}})).toBe('uncertain');
    expect(classifyOperation({status:503,body:{error:'timeout'}})).toBe('uncertain');
    expect(classifyOperation({status:400,body:{error:'bad input'}})).toBe('failed');
  });
});
