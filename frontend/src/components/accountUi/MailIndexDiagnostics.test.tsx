import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import type { ReactTestRenderer } from 'react-test-renderer';

registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.json')) return { format:'module', source:`export default ${readFileSync(new URL(url),'utf8')}`, shortCircuit:true };
  if (url.endsWith('.css')) return { format:'module', source:'export {};', shortCircuit:true };
  return nextLoad(url,context);
} });
Reflect.set(globalThis,'window',{history:{state:null,pushState:()=>{},back:()=>{}},addEventListener:()=>{},removeEventListener:()=>{}});
Reflect.set(globalThis,'localStorage',{getItem:()=>null,setItem:()=>{},removeItem:()=>{}});
const { api } = await import('../../utils/api.ts');
const { useStore } = await import('../../store/index.ts');
const { default: Diagnostics } = await import('./MailIndexDiagnostics.tsx');
const { create, act } = await import('react-test-renderer');
const originalGet=api.get;
const status={status:'ready',messages:12,folders:3,lastFolderSync:null};
let tree:ReactTestRenderer|null=null;
let reads=0;
let poll:()=>void=()=>{};
let releases:Array<()=>void>=[];
const action=()=>new Promise<void>(resolve=>{releases.push(resolve);});
const props={accountId:'account-a',onSyncFolders:action,onReindex:action,onReconnect:action};
const buttons=()=>tree!.root.findAllByType('button');
beforeEach(()=>{
  reads=0;releases=[];
  Reflect.set(globalThis,'window',{setInterval:(callback:()=>void)=>{poll=callback;return 1;},clearInterval:()=>{}});
  useStore.setState({authEpoch:12,user:{id:'owner'},isLocked:false});
  api.get=async()=>{reads++;return status;};
});
afterEach(async()=>{await act(async()=>tree?.unmount());tree=null;api.get=originalGet;});
async function mount(){await act(async()=>{tree=create(<Diagnostics {...props}/>);});}
async function click(index=0){await act(async()=>{buttons()[index].props.onClick();});}
async function release(index:number){await act(async()=>{releases[index]();});}

test('changing auth epoch releases the old action without letting its finally unlock a new one',async()=>{
  await mount();await click();assert.ok(buttons().every(button=>button.props.disabled));
  await act(async()=>{useStore.setState({authEpoch:13});});
  assert.ok(buttons().every(button=>!button.props.disabled));
  await click(1);assert.equal(releases.length,2);
  const before=reads;await release(0);
  assert.ok(buttons().every(button=>button.props.disabled));assert.equal(reads,before);
  await release(1);assert.ok(buttons().every(button=>!button.props.disabled));assert.equal(reads,before+1);
});

test('switching account resets the lock even if the old action never resolves',async()=>{
  await mount();await click();
  await act(async()=>{tree!.update(<Diagnostics {...props} accountId="account-b"/>);});
  assert.ok(buttons().every(button=>!button.props.disabled));
  await click(2);assert.equal(releases.length,2);
  await release(1);assert.ok(buttons().every(button=>!button.props.disabled));
  const before=reads;await release(0);assert.equal(reads,before);
});

test('an unmounted action cannot refresh the next diagnostics instance',async()=>{
  await mount();await click();
  await act(async()=>{tree!.unmount();});await mount();
  const before=reads;await release(0);assert.equal(reads,before);
  assert.ok(buttons().every(button=>!button.props.disabled));
});

test('out-of-order polling keeps the most recent index status',async()=>{
  await mount();
  const pending:Array<(value:typeof status)=>void>=[];
  api.get=()=>new Promise(resolve=>pending.push(resolve));
  await act(async()=>{poll();poll();});
  await act(async()=>{pending[1]({...status,messages:30});});
  assert.ok(tree!.root.findAllByType('dd').some(cell=>cell.children.includes('30')));
  await act(async()=>{pending[0]({...status,messages:15});});
  assert.ok(tree!.root.findAllByType('dd').some(cell=>cell.children.includes('30')));
  assert.ok(!tree!.root.findAllByType('dd').some(cell=>cell.children.includes('15')));
});
