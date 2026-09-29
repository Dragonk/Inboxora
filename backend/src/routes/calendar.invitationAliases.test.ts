import 'express-async-errors';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';
const mocks=vi.hoisted(()=>({query:vi.fn(),target:vi.fn(),put:vi.fn(),send:vi.fn()}));
vi.mock('../services/db.js',()=>({query:mocks.query,withTransaction:vi.fn()}));
vi.mock('../middleware/auth.js',()=>({requireAuth:(req:{session?:{userId:string}},_res:unknown,next:()=>void)=>{req.session={userId:'user-1'};next();}}));
vi.mock('../services/providers/caldavWriteBack.js',()=>({putCaldavEvent:mocks.put,deleteCaldavEvent:vi.fn()}));
vi.mock('../services/calendarInvitation.js',()=>({sendCalendarInvitation:mocks.send,prepareCalendarInvitation:vi.fn()}));
vi.mock('../services/externalCalendarSync.js',()=>({releaseCalendarSource:vi.fn(),scheduleCalendarSource:vi.fn(),stopCalendarSource:vi.fn(),syncCalendarSource:vi.fn()}));
vi.mock('../services/providerCalendarWrites.js',async original=>({...await original<typeof import('../services/providerCalendarWrites.js')>(),resolveCalendarWriteTarget:mocks.target}));
import express from 'express';
import routes from './calendar.js';
let server:Server;let base='';
const accountId='22222222-2222-4222-8222-222222222222';
const event={calendarId:'calendar-1',summary:'Test',startsAt:'2026-10-01T10:00:00Z',endsAt:'2026-10-01T11:00:00Z',sendInvites:true,inviteAccountId:accountId,attendees:['guest@example.test']};
beforeEach(async()=>{
  vi.clearAllMocks();
  mocks.query.mockImplementation(async(sql:string)=>({rows:sql.includes('FROM email_accounts')?[{id:accountId,smtp_host:'smtp.example.test'}]:[]}));
  if(!server){const app=express();app.use(express.json());app.use('/api/calendar',routes);
    app.use((_error:Error,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{res.status(500).json({error:'Internal server error'});});
    await new Promise<void>((resolve,reject)=>{server=app.listen(0,()=>resolve());server.once('error',reject);});base=`http://127.0.0.1:${listeningPort(server)}`;}
});
afterAll(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
for(const [method,kind] of [['POST','local'],['PATCH','local'],['PATCH','caldav']] as const){
  describe(`${method} ${kind} invitation sender aliases`,()=>{
    it.each([['invalid-alias',400],['33333333-3333-4333-8333-333333333333',409]])('returns %s alias failure as HTTP %s before writes',async(alias,status)=>{
      mocks.target.mockResolvedValue({kind,calendarId:'calendar-1',collectionId:'collection-1',externalUrl:'https://dav.example.test/calendar/'});
      const response=await fetch(`${base}/api/calendar/events${method==='PATCH'?'/event-1':''}`,{method,headers:{'content-type':'application/json'},body:JSON.stringify({...event,inviteAliasId:alias})});
      expect(response.status).toBe(status);expect(await response.json()).toMatchObject({error:expect.stringContaining('alias')});
      expect(mocks.put).not.toHaveBeenCalled();expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.query.mock.calls.some(([sql])=>/^\s*(INSERT|UPDATE|DELETE)/i.test(sql))).toBe(false);
    });
    it('keeps unrelated alias lookup failures as server errors',async()=>{
      mocks.target.mockResolvedValue({kind,calendarId:'calendar-1',collectionId:'collection-1',externalUrl:'https://dav.example.test/calendar/'});
      mocks.query.mockImplementation(async(sql:string)=>{if(sql.includes('FROM account_aliases'))throw new Error('database unavailable');return{rows:[{id:accountId,smtp_host:'smtp.example.test'}]};});
      const response=await fetch(`${base}/api/calendar/events${method==='PATCH'?'/event-1':''}`,{method,headers:{'content-type':'application/json'},body:JSON.stringify({...event,inviteAliasId:'33333333-3333-4333-8333-333333333333'})});
      expect(response.status).toBe(500);expect(mocks.put).not.toHaveBeenCalled();expect(mocks.send).not.toHaveBeenCalled();
    });
  });
}
