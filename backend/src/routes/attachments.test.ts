import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import session from 'express-session';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { ProcessingInput, ProcessingOutput } from '../services/attachments/processing.js';
const {query}=vi.hoisted(()=>({query:vi.fn()}));
vi.mock('../services/db.js',()=>({query}));
vi.mock('../services/redis.js',()=>({redisClient:{}}));
import { createAttachmentRouter } from './attachments.js';
import { AttachmentProcessingError } from '../services/attachments/processing.js';

beforeEach(()=>{query.mockReset().mockResolvedValue({rows:[{id:'preview-user'}]});});
const file=()=>new Blob([readFileSync(new URL('../../fixtures/attachments/text.txt',import.meta.url))]);
const form=(password?:string)=>{const body=new FormData();body.append('file',file(),'ignored-filename.txt');if(password)body.append('password',password);return body;};
async function appFor(run:(origin:string,admit:ReturnType<typeof vi.fn>,process:ReturnType<typeof vi.fn>)=>Promise<void>) {
  const admit=vi.fn(async()=>undefined);
  const process=vi.fn(async(_input:ProcessingInput,_signal:AbortSignal):Promise<ProcessingOutput>=>({json:{encrypted:false}}));
  const app=express();app.use(session({secret:'public-attachment-route-test-secret',resave:false,saveUninitialized:true}));
  app.use((req,_res,next)=>{if(req.get('X-Test-Anonymous')!=='true')req.session.userId='preview-user';next();});
  app.use('/api/mail',createAttachmentRouter({admit,process}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  try {await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`,admit,process);}
  finally {server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
const headers={'X-Requested-With':'MailFlow'};

describe('attachment processing HTTP boundary',()=>{
  it('requires a current user and CSRF before admission or multipart processing',async()=>appFor(async(origin,admit,process)=>{
    const url=origin+'/api/mail/attachments/process/probe';
    const anonymous=await fetch(url,{method:'POST',headers:{...headers,'X-Test-Anonymous':'true'},body:form()});expect(anonymous.status).toBe(401);
    const csrf=await fetch(url,{method:'POST',body:form()});expect(csrf.status).toBe(403);
    expect(admit).not.toHaveBeenCalled();expect(process).not.toHaveBeenCalled();
  }));
  it('accepts only the supplied file and keeps sensitive output non-cacheable',async()=>appFor(async(origin,_admit,process)=>{
    const response=await fetch(origin+'/api/mail/attachments/process/probe',{method:'POST',headers,body:form()});
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.json()).toEqual({encrypted:false});expect(process).toHaveBeenCalledTimes(1);
    const body=form();body.append('url','https://outside.example.test/private');
    const rejected=await fetch(origin+'/api/mail/attachments/process/probe',{method:'POST',headers,body});
    expect(rejected.status).toBe(400);expect(process).toHaveBeenCalledTimes(1);
  }));
  it('separates incorrect passwords from authentication and never logs passwords',async()=>appFor(async(origin,_admit,process)=>{
    const errors=vi.spyOn(console,'error');const logs=vi.spyOn(console,'log');
    process.mockRejectedValueOnce(new AttachmentProcessingError('WRONG_PASSWORD'));
    const response=await fetch(origin+'/api/mail/attachments/process/unlock',{method:'POST',headers,body:form('do-not-log-this-password')});
    expect(response.status).toBe(422);expect(await response.json()).toEqual({code:'WRONG_PASSWORD'});
    expect(JSON.stringify([...errors.mock.calls,...logs.mock.calls])).not.toContain('do-not-log-this-password');errors.mockRestore();logs.mockRestore();
  }));
  it('fails closed for Redis outages and rate limits before reading files',async()=>appFor(async(origin,admit,process)=>{
    admit.mockRejectedValueOnce({msBeforeNext:60000});
    const limited=await fetch(origin+'/api/mail/attachments/process/unlock',{method:'POST',headers,body:form('fixture')});expect(limited.status).toBe(429);expect(limited.headers.get('retry-after')).toBe('60');
    admit.mockRejectedValueOnce(new Error('redis unavailable'));
    const outage=await fetch(origin+'/api/mail/attachments/process/probe',{method:'POST',headers,body:form()});expect(outage.status).toBe(503);expect(process).not.toHaveBeenCalled();
  }));
  it('reserves per-user capacity before awaited admission or parsing',async()=>appFor(async(origin,admit)=>{
    let release:()=>void=()=>{};let entered:()=>void=()=>{};
    const started=new Promise<void>(resolve=>{entered=resolve;});
    admit.mockImplementationOnce(async()=>{entered();await new Promise<void>(resolve=>{release=resolve;});});
    const first=fetch(origin+'/api/mail/attachments/process/probe',{method:'POST',headers,body:form()});await started;
    const second=await fetch(origin+'/api/mail/attachments/process/probe',{method:'POST',headers,body:form()});expect(second.status).toBe(429);
    release();expect((await first).status).toBe(200);
  }));
  it('bounds multipart fields and rejects duplicate file parts',async()=>appFor(async(origin,_admit,process)=>{
    const multiple=form();multiple.append('file',file(),'second.txt');
    const duplicate=await fetch(origin+'/api/mail/attachments/process/probe',{method:'POST',headers,body:multiple});expect(duplicate.status).toBe(413);
    const large=form('x'.repeat(257));
    const overlong=await fetch(origin+'/api/mail/attachments/process/unlock',{method:'POST',headers,body:large});expect(overlong.status).toBe(400);expect(process).not.toHaveBeenCalled();
  }));
});

it('rejects ambiguous MIME part indexes before handing data to a worker', async () => appFor(async (origin, _admit, process) => {
  for (const index of ['', ' ', '-1', '+1', '01', '1.0', '1e0', '0x1', 'Infinity', '1000', 'bad']) {
    const body = form(); body.append('index', index);
    const response = await fetch(origin + '/api/mail/attachments/process/eml-part', { method: 'POST', headers, body });
    expect(response.status, JSON.stringify(index)).toBe(400);
    expect(await response.json()).toEqual({ code: 'INVALID_INPUT' });
  }
  expect(process).not.toHaveBeenCalled();
  for (const index of ['0', '1', '99']) {
    const body = form(); body.append('index', index);
    const response = await fetch(origin + '/api/mail/attachments/process/eml-part', { method: 'POST', headers, body });
    expect(response.status).toBe(200);
    expect(process.mock.lastCall?.[0].index).toBe(Number(index));
  }
}));
