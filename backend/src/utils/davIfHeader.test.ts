import { describe, expect, it } from 'vitest';
import { evaluateDavIf } from './davPreconditions.js';

const CONTEXT = { etag: 'etag-1', syncToken: 'urn:inboxora:carddav:book-1:7' };

describe('evaluateDavIf', () => {
  it('has no condition when the header is absent or empty', () => {
    expect(evaluateDavIf(undefined, CONTEXT)).toEqual({ status: 'proceed' });
    expect(evaluateDavIf(null, CONTEXT)).toEqual({ status: 'proceed' });
    expect(evaluateDavIf('   ', CONTEXT)).toEqual({ status: 'proceed' });
  });

  it('accepts a matching state token and rejects a stale one', () => {
    expect(evaluateDavIf('(<urn:inboxora:carddav:book-1:7>)', CONTEXT)).toEqual({ status: 'proceed' });
    // A stale token means the client's view of the collection is out of date.
    expect(evaluateDavIf('(<urn:inboxora:carddav:book-1:6>)', CONTEXT)).toEqual({ status: 'precondition-failed' });
  });

  it('compares an entity-tag condition strongly, like If-Match', () => {
    expect(evaluateDavIf('(["etag-1"])', CONTEXT)).toEqual({ status: 'proceed' });
    expect(evaluateDavIf('(["other"])', CONTEXT)).toEqual({ status: 'precondition-failed' });
    // A weak validator never satisfies a strong comparison.
    expect(evaluateDavIf('([W/"etag-1"])', CONTEXT)).toEqual({ status: 'precondition-failed' });
  });

  it('understands Not, and a negated condition on a missing resource holds', () => {
    expect(evaluateDavIf('(Not <urn:inboxora:carddav:book-1:6>)', CONTEXT)).toEqual({ status: 'proceed' });
    expect(evaluateDavIf('(Not <urn:inboxora:carddav:book-1:7>)', CONTEXT)).toEqual({ status: 'precondition-failed' });
    expect(evaluateDavIf('(Not ["etag-1"])', CONTEXT)).toEqual({ status: 'precondition-failed' });
    expect(evaluateDavIf('(Not ["gone"])', CONTEXT)).toEqual({ status: 'proceed' });
    // Nothing is protected by a condition on a resource that does not exist.
    expect(evaluateDavIf('(["etag-1"])', { etag: null, syncToken: null })).toEqual({ status: 'precondition-failed' });
    expect(evaluateDavIf('(Not ["etag-1"])', { etag: null, syncToken: null })).toEqual({ status: 'proceed' });
  });

  it('requires every condition in one list and any list overall', () => {
    expect(evaluateDavIf('(["etag-1"] <urn:inboxora:carddav:book-1:7>)', CONTEXT)).toEqual({ status: 'proceed' });
    // One false condition fails the whole list.
    expect(evaluateDavIf('(["etag-1"] <urn:inboxora:carddav:book-1:6>)', CONTEXT)).toEqual({ status: 'precondition-failed' });
    // Lists are alternatives.
    expect(evaluateDavIf('(["gone"]) (["etag-1"])', CONTEXT)).toEqual({ status: 'proceed' });
    expect(evaluateDavIf('(["gone"]) (["also-gone"])', CONTEXT)).toEqual({ status: 'precondition-failed' });
  });

  it('tolerates the whitespace a client may add', () => {
    expect(evaluateDavIf('  (  ["etag-1"]   )  ', CONTEXT)).toEqual({ status: 'proceed' });
    expect(evaluateDavIf('(Not   <urn:inboxora:carddav:book-1:6>)', CONTEXT)).toEqual({ status: 'proceed' });
  });

  it('joins a repeated header, which is equivalent to one header', () => {
    expect(evaluateDavIf(['(["gone"])', '(["etag-1"])'], CONTEXT)).toEqual({ status: 'proceed' });
  });

  it('reports a malformed header as a client error', () => {
    // An unterminated group, an empty group, garbage inside a group, a bare Not, an
    // unclosed token and a stray word are all syntactically invalid.
    for (const header of ['(<token>', '()', '(garbage)', '(Not)', '(>', '([etag-1]', 'whatever', ')']) {
      expect(evaluateDavIf(header, CONTEXT), header).toEqual({ status: 'bad-request' });
    }
  });

  it('fails closed on a valid header form it does not evaluate', () => {
    // A tagged list is legitimate RFC 4918 and could name another resource; the
    // server must not silently treat that as "no condition".
    expect(evaluateDavIf('</caldav/user-1/cal-1/> (<urn:inboxora:caldav:cal-1:3>)', CONTEXT))
      .toEqual({ status: 'precondition-failed' });
    expect(evaluateDavIf('</dav/user-1/book-1/> (["etag-1"])', CONTEXT))
      .toEqual({ status: 'precondition-failed' });
  });
});
