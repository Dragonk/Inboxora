import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, inputStyle } from '../ui.tsx';
import RichTextEditor from '../RichTextEditor.tsx';
import { sanitizeMessageHtml } from '../MessageBodyRenderer.tsx';
import { parseMcpRecipients } from '../../utils/mcpRecipients.ts';

type Review = Record<string, unknown>;
export interface McpMailEdits {
  to:string[]; cc:string[]; bcc:string[]; subject:string;
  body:string; bodyIsHtml:true; bodyChanged:boolean;
  signature:string; signatureIsHtml:true; signatureChanged:boolean;
}
function strings(value:unknown):string[]{ return Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'):[]; }
function text(value:unknown):string { return typeof value==='string'?value:''; }
function encodePlain(value:string):string { return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'); }
function initialHtml(html:unknown, plain:unknown):string {
  return sanitizeMessageHtml(text(html)||encodePlain(text(plain)),{remoteImages:false,tone:'light'});
}
export default function McpMailEditor({review,busy,onCancel,onSave}:{review:Review;busy:boolean;onCancel:()=>void;onSave:(edits:McpMailEdits)=>Promise<void>|void}){
  const {t}=useTranslation();
  const [to,setTo]=useState(strings(review.to).join('; '));
  const [cc,setCc]=useState(strings(review.cc).join('; '));
  const [bcc,setBcc]=useState(strings(review.bcc).join('; '));
  const [subject,setSubject]=useState(text(review.subject));
  const [body,setBody]=useState(()=>initialHtml(review.bodyHtml,review.bodyText));
  const [signature,setSignature]=useState(()=>initialHtml(review.signatureHtml,review.signatureText));
  const [bodyChanged,setBodyChanged]=useState(false);
  const [signatureChanged,setSignatureChanged]=useState(false);
  const save=()=>onSave({
    to:parseMcpRecipients(to),cc:parseMcpRecipients(cc),bcc:parseMcpRecipients(bcc),subject,
    body,bodyIsHtml:true,bodyChanged,signature,signatureIsHtml:true,signatureChanged,
  });
  return <section className="mcp-mail-editor" aria-label={t('mcp.editMessage')}>
    <div className="mcp-mail-editor-grid">
      <label>{t('compose.to')}<input data-testid="mcp-mail-to" style={inputStyle} value={to} onChange={e=>setTo(e.target.value)} disabled={busy}/></label>
      <label>{t('compose.cc')}<input data-testid="mcp-mail-cc" style={inputStyle} value={cc} onChange={e=>setCc(e.target.value)} disabled={busy}/></label>
      <label>{t('compose.bcc')}<input data-testid="mcp-mail-bcc" style={inputStyle} value={bcc} onChange={e=>setBcc(e.target.value)} disabled={busy}/></label>
      <label className="mcp-mail-editor-wide">{t('compose.subject')}<input data-testid="mcp-mail-subject" style={inputStyle} value={subject} onChange={e=>setSubject(e.target.value)} disabled={busy}/></label>
    </div>
    <label className="mcp-mail-editor-label">{t('mcp.messageBody')}</label>
    <RichTextEditor value={body} onChange={html=>{setBody(html);setBodyChanged(true);}} label={t('mcp.messageBody')} testId="mcp-mail-body-editor" minHeight={170}/>
    <label className="mcp-mail-editor-label">{t('admin.accounts.signatureSection')}</label>
    <RichTextEditor value={signature} onChange={html=>{setSignature(html);setSignatureChanged(true);}} label={t('admin.accounts.signatureSection')} testId="mcp-mail-signature-editor" minHeight={80}/>
    <p className="mcp-mail-editor-hint">{t('mcp.editHint')}</p>
    <div className="mcp-actions"><Button disabled={busy} onClick={onCancel}>{t('mcp.cancel')}</Button><Button variant="primary" disabled={busy} onClick={()=>void save()}>{busy?t('mcp.savingEdit'):t('mcp.saveEdit')}</Button></div>
  </section>;
}
