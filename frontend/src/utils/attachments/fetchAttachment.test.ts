import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireAttachment, attachmentPath, clearAttachmentCache } from './fetchAttachment.ts';
import { setAuthEpoch } from '../authEpoch.ts';
const path='/api/mail/messages/message-1/attachments/part%252F1';

test('attachment sources cannot point to a remote URL or an unrelated application endpoint',()=>{
  for(const value of ['https://example.test/file','//evil/file','/api/users','/api/mail/messages/x/attachments/y?password=x']) assert.throws(()=>attachmentPath(value));
  assert.equal(attachmentPath('/api/mail/scheduled/q/attachments/0?revision=7'),'/api/mail/scheduled/q/attachments/0?revision=7');
});
test('shared subscribers fetch once, release independently and retain immutable queue revisions',async()=>{
  const original=globalThis.fetch;let reads=0;setAuthEpoch(810);clearAttachmentCache();
  globalThis.fetch=async (_url,options)=>{reads++;assert.equal(options?.credentials,'include');return new Response('fixture');};
  try{
    const one=acquireAttachment(path,810);const two=acquireAttachment(path,810);one.release();
    assert.equal(await (await two.promise).text(),'fixture');assert.equal(reads,1);two.release();
    const again=acquireAttachment(path,810);await again.promise;assert.equal(reads,1);again.release();
    for(const revision of [1,2]) {const queued=acquireAttachment(`/api/mail/scheduled/q/attachments/0?revision=${revision}`,810);await queued.promise;queued.release();}
    assert.equal(reads,3);
  }finally{clearAttachmentCache();globalThis.fetch=original;}
});
test('pending byte reservations prevent unlimited pinned fetches and logout aborts their work',async()=>{
  const original=globalThis.fetch;setAuthEpoch(811);clearAttachmentCache();let aborted=0;
  globalThis.fetch=async(_url,options)=>new Promise<Response>((_resolve,reject)=>{
    options?.signal?.addEventListener('abort',()=>{aborted++;reject(new DOMException('Cancelled','AbortError'));},{once:true});
  });
  try{
    const one=acquireAttachment(path,811);const first=one.promise.catch(error=>error);
    const two=acquireAttachment('/api/mail/messages/message-2/attachments/part',811);const second=two.promise.catch(error=>error);
    assert.throws(()=>acquireAttachment('/api/mail/messages/message-3/attachments/part',811),/LIMIT/);
    setAuthEpoch(812);assert.equal(aborted,2);assert.equal((await first).name,'AbortError');assert.equal((await second).name,'AbortError');
    assert.throws(()=>acquireAttachment(path,811),/cancelled/i);one.release();two.release();
  }finally{clearAttachmentCache();globalThis.fetch=original;}
});
test('the streamed byte limit is enforced even when content-length is false',async()=>{
  const original=globalThis.fetch;setAuthEpoch(813);clearAttachmentCache();let sent=0;
  globalThis.fetch=async()=>new Response(new ReadableStream<Uint8Array>({pull(controller){if(sent++<51)controller.enqueue(new Uint8Array(1024*1024));else controller.close();}}),{headers:{'content-length':'1'}});
  try{const read=acquireAttachment(path,813);await assert.rejects(read.promise,/LIMIT/);read.release();}
  finally{clearAttachmentCache();globalThis.fetch=original;}
});

test('late completed reads cannot repopulate the cache after a session change', async () => {
  const original = globalThis.fetch; setAuthEpoch(814); clearAttachmentCache();
  let finish: ((response: Response) => void) | undefined;
  globalThis.fetch = () => new Promise<Response>(resolve => { finish = resolve; });
  try {
    const read = acquireAttachment(path, 814); const rejected = assert.rejects(read.promise, { name: 'AbortError' });
    setAuthEpoch(815); finish?.(new Response('previous private attachment')); await rejected; read.release();
    let count = 0;
    globalThis.fetch = async url => { count++; return new Response(String(url)); };
    for (const message of ['message-1', 'message-2']) {
      const url = `/api/mail/messages/${message}/attachments/1`;
      const next = acquireAttachment(url, 815); assert.equal(await (await next.promise).text(), url + '?preview=1'); next.release();
    }
    assert.equal(count, 2);
  } finally { clearAttachmentCache(); globalThis.fetch = original; }
});

test('progress reaches current subscribers, replays to late joiners and stops after lease release', async () => {
  const original = globalThis.fetch; setAuthEpoch(816); clearAttachmentCache();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined; let reads = 0;
  globalThis.fetch = async () => {
    reads++;
    return new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), { headers: { 'content-length': '6' } });
  };
  const first: number[][] = []; const shared: number[][] = [];
  const callback = (loaded: number, total: number) => { shared.push([loaded, total]); };
  try {
    const one = acquireAttachment(path, 816, (loaded, total) => { first.push([loaded, total]); });
    controller?.enqueue(new Uint8Array([1, 2]));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(first, [[2, 6]]);
    const two = acquireAttachment(path, 816, callback);
    const three = acquireAttachment(path, 816, callback);
    assert.deepEqual(shared, [[2, 6], [2, 6]]);
    one.release(); two.release();
    controller?.enqueue(new Uint8Array([3, 4, 5, 6])); controller?.close();
    await Promise.all([one.promise, two.promise, three.promise]);
    assert.equal(reads, 1);
    assert.deepEqual(first, [[2, 6]], 'released subscriber receives no further progress');
    assert.deepEqual(shared, [[2, 6], [2, 6], [6, 6]], 'a shared callback survives the other lease being released');
    three.release();
    const cached: number[][] = [];
    const later = acquireAttachment(path, 816, (loaded, total) => { cached.push([loaded, total]); });
    await later.promise; assert.deepEqual(cached, [[6, 6]]); assert.equal(reads, 1); later.release();
  } finally { clearAttachmentCache(); globalThis.fetch = original; }
});
