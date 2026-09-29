import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { sessionUserId } from '../utils/query.js';
import { uuidParam } from '../utils/uuid.js';
import { createDavAccount, updateDavAccount, deleteDavAccount, listDavAccounts, davAccountDiagnostics, syncDavAccount, discoverSavedDavAccount, type DavAccountInput, type DavAccountPatch } from '../services/davAccounts.js';
import { DavAccountError, discoverDavAccount, type DavCredentials } from '../services/davDiscovery.js';
const router = Router();
router.use(requireAuth); router.param('id',uuidParam('id'));
const object = (value:unknown):Record<string,unknown> => value !== null && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
function text(body:Record<string,unknown>,key:string,max:number):string {
  const value = body[key]; if (typeof value!=='string' || !value.trim() || value.length>max) throw new DavAccountError('DAV_INVALID_SETTINGS');
  return key==='password' ? value : value.trim();
}
function credentials(body:Record<string,unknown>):DavCredentials {
  return {serverUrl:text(body,'serverUrl',2048),username:text(body,'username',320),password:text(body,'password',4096)};
}
function settings(body:Record<string,unknown>):Omit<DavAccountInput,keyof DavCredentials> {
  if (typeof body.calendarEnabled!=='boolean' || typeof body.contactsEnabled!=='boolean' || !Number.isInteger(body.intervalMin)
    || Number(body.intervalMin)<15 || Number(body.intervalMin)>1440) throw new DavAccountError('DAV_INVALID_SETTINGS');
  return {name:text(body,'name',120),calendarEnabled:body.calendarEnabled,contactsEnabled:body.contactsEnabled,intervalMin:Number(body.intervalMin)};
}
router.get('/',async(req,res)=>res.json({accounts:await listDavAccounts(sessionUserId(req))}));
router.post('/discover',async(req,res)=>{
  const discovery=await discoverDavAccount(credentials(object(req.body)));
  res.json({calendarSupported:Boolean(discovery.calendars),contactsSupported:Boolean(discovery.contacts),
    calendarCount:discovery.calendars?.collections.length || 0,contactBookCount:discovery.contacts?.collections.length || 0});
});
router.post('/',async(req,res)=>{
  const body=object(req.body); res.status(201).json(await createDavAccount(sessionUserId(req),{...credentials(body),...settings(body)}));
});
router.patch('/:id',async(req,res)=>{
  const body=object(req.body); const password=body.password;
  if (password!==undefined && (typeof password!=='string' || password.length>4096)) throw new DavAccountError('DAV_INVALID_SETTINGS');
  const patch:DavAccountPatch={...settings(body),revision:text(body,'revision',80),...(password ? {password:String(password)} : {})};
  res.json(await updateDavAccount(sessionUserId(req),req.params.id,patch));
});
router.post('/:id/discover',async(req,res)=>{
  const password=object(req.body).password;
  if(password!==undefined&&(typeof password!=='string'||password.length>4096))throw new DavAccountError('DAV_INVALID_SETTINGS');
  const discovery=await discoverSavedDavAccount(sessionUserId(req),req.params.id,typeof password==='string'?password:undefined);
  res.json({calendarSupported:Boolean(discovery.calendars),contactsSupported:Boolean(discovery.contacts),calendarCount:discovery.calendars?.collections.length||0,contactBookCount:discovery.contacts?.collections.length||0});
});
router.get('/:id/diagnostics',async(req,res)=>res.json(await davAccountDiagnostics(sessionUserId(req),req.params.id)));
router.post('/:id/sync',async(req,res)=>{await syncDavAccount(sessionUserId(req),req.params.id);res.status(202).json({ok:true});});
router.delete('/:id',async(req,res)=>{await deleteDavAccount(sessionUserId(req),req.params.id);res.status(204).end();});
router.use((error:unknown,_req:import('express').Request,res:import('express').Response,next:import('express').NextFunction)=>{
  if (error instanceof DavAccountError) return res.status(error.status).json({code:error.code,error:error.code});
  next(error);
});
export default router;
