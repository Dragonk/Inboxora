import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('offset pages share the navigation-safe latest-request guard', async () => {
  const source = await readFile(new URL('./MessageList.tsx', import.meta.url), 'utf8');
  const loadMore = source.slice(source.indexOf('const loadMore = useCallback'), source.indexOf('  useEffect(() => {', source.indexOf('const loadMore = useCallback')));
  assert.match(loadMore, /await refreshRequest\.run\(\s*\(\) => api\.getMessages\(params, \{ signal \}\)/);
  assert.match(loadMore, /appendMessages\(applyDeleteGuard\(applyReadGuard\(data\.messages\)\)\)/);
  assert.match(loadMore, /setMessagesOffset\(currentOffset \+ data\.messages\.length\)/);
  assert.match(loadMore, /const signal = listAbortRef\.current\?\.signal/);
  assert.match(loadMore, /if \(!signal\?\.aborted && isCurrentListScope\(\)\) setLoadingMessages\(false\)/);
  assert.match(loadMore, /if \(!isCurrentListScope\(\)\) return;\s*appendMessages/);
  assert.doesNotMatch(loadMore, /const data = await api\.getMessages\(params, \{ signal \}\)/);
});
