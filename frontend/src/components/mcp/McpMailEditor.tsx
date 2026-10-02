import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, inputStyle } from '../ui.tsx';
import { sanitizeMessageHtml } from '../MessageBodyRenderer.tsx';

type Review = Record<string, unknown>;
export interface McpMailEdits { to:string[]; cc:string[]; bcc:string[]; subject:string; body:string; bodyIsHtml:true; bodyChanged:boolean; signature:string; signatureIsHtml:true; signatureChanged:boolean; }
function strings(value:unknown):string[]{ return Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'):[]; }
function text(value:unknown):string { return typeof value==='string'?value:''; }
function encodePlain(value:string):string { return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'); }
function parseRecipients(value:string):string[]{ return [...new Set(value.split(/[;\n]+/).map(item=>item.trim()).filter(Boolean))]; }

export default function McpMailEditor({review,busy,onCancel,onSave}:{review:Review;busy:boolean;onCancel:()=>void;onSave:(edits:McpMailEdits)=>Promise<void>|void}){
  const {t}=useTranslation();
  const [to,setTo]=useState(strings(review.to).join('; ')); const [cc,setCc]=useState(strings(review.cc).join('; ')); const [bcc,setBcc]=useState(strings(review.bcc).join('; '));
  const [subject,setSubject]=useState(text(review.subject)); const bodyRef=useRef<HTMLDivElement|null>(null); const signatureRef=useRef<HTMLDivElement|null>(null);
  const [bodyChanged,setBodyChanged]=useState(false); const [signatureChanged,setSignatureChanged]=useState(false);
  useEffect(()=>{
    if(bodyRef.current) bodyRef.current.innerHTML=sanitizeMessageHtml(text(review.bodyHtml)||encodePlain(text(review.bodyText)),{remoteImages:false,tone:'light'});
    if(signatureRef.current) signatureRef.current.innerHTML=sanitizeMessageHtml(text(review.signatureHtml)||encodePlain(text(review.signatureText)),{remoteImages:false,tone:'light'});
    setBodyChanged(false); setSignatureChanged(false);
  },[review]);
  const save=()=>onSave({to:parseRecipients(to),cc:parseRecipients(cc),bcc:parseRecipients(bcc),subject,body:bodyRef.current?.innerHTML||'',bodyIsHtml:true,bodyChanged,signature:signatureRef.current?.innerHTML||'',signatureIsHtml:true,signatureChanged});
  return <section className="mcp-mail-editor" aria-label={t('mcp.editMessage')}>
    <div className="mcp-mail-editor-grid">
      <label>{t('compose.to')}<input style={inputStyle} value={to} onChange={e=>setTo(e.target.value)} disabled={busy}/></label>
      <label>{t('compose.cc')}<input style={inputStyle} value={cc} onChange={e=>setCc(e.target.value)} disabled={busy}/></label>
      <label>{t('compose.bcc')}<input style={inputStyle} value={bcc} onChange={e=>setBcc(e.target.value)} disabled={busy}/></label>
      <label className="mcp-mail-editor-wide">{t('compose.subject')}<input style={inputStyle} value={subject} onChange={e=>setSubject(e.target.value)} disabled={busy}/></label>
    </div>
    <label className="mcp-mail-editor-label">{t('mcp.messageBody')}</label>
    <div ref={bodyRef} className="mcp-mail-rich-editor" contentEditable={!busy} suppressContentEditableWarning data-testid="mcp-mail-body-editor" onInput={()=>setBodyChanged(true)}/>
    <label className="mcp-mail-editor-label">{t('admin.accounts.signatureSection')}</label>
    <div ref={signatureRef} className="mcp-mail-rich-editor mcp-mail-signature-editor" contentEditable={!busy} suppressContentEditableWarning data-testid="mcp-mail-signature-editor" onInput={()=>setSignatureChanged(true)}/>
    <p className="mcp-mail-editor-hint">{t('mcp.editHint')}</p>
    <div className="mcp-actions"><Button disabled={busy} onClick={onCancel}>{t('mcp.cancel')}</Button><Button variant="primary" disabled={busy} onClick={()=>void save()}>{busy?t('mcp.savingEdit'):t('mcp.saveEdit')}</Button></div>
  </section>;
}
