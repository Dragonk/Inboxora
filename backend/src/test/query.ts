/**
 * The [sql, params] pair of one recorded query call, narrowed for assertions. Tests record calls
 * through the shared db mock; this keeps every one of them free of undefined checks.
 */
export function queryCall(mock: { mock: { calls: unknown[][] } }, index = 0): [string, unknown[]] {
  const call = mock.mock.calls[index];
  if (!call) throw new Error('expected a query call at index ' + index);
  const sql = call[0];
  const params = call[1];
  if (typeof sql !== 'string') throw new Error('expected the SQL text as the first argument');
  if (!Array.isArray(params)) throw new Error('expected an array of query parameters');
  return [sql, params];
}

