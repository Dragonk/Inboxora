import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui.tsx';
import ComposeBodyField from '../ComposeBodyField.tsx';
import ComposeSignatureField from '../ComposeSignatureField.tsx';
import { ChipInput } from '../ComposeModal.tsx';
import { sanitizeMessageHtml } from '../MessageBodyRenderer.tsx';
import { parseMcpRecipients } from '../../utils/mcpRecipients.ts';

type Review = Record<string, unknown>;
export interface McpMailEdits {
  to:string[]; cc:string[]; bcc:string[]; subject:string;
  body:string; bodyIsHtml:true; bodyChanged:boolean;
  signature:string; signatureIsHtml:true; signatureChanged:boolean;
}
function strings(value:unknown):string[]{return Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'):[];}
function text(value:unknown):string {return typeof value==='string'?value:'';}
function encodePlain(value:string):string {return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');}
function initialHtml(html:unknown,plain:unknown):string {
  return sanitizeMessageHtml(text(html)||encodePlain(text(plain)),{remoteImages:false,tone:'light'});
}
function commit(chips:string[],pending:string):string[] {
  return parseMcpRecipients([...chips, pending].filter(Boolean).join('; '));
}

export default function McpMailEditor({review,busy,onCancel,onSave}:{review:Review;busy:boolean;onCancel:()=>void;onSave:(edits:McpMailEdits)=>Promise<void>|void}){
  const {t}=useTranslation();
  const [toChips,setToChips]=useState(()=>strings(review.to)); const [toInput,setToInput]=useState('');
  const [ccChips,setCcChips]=useState(()=>strings(review.cc)); const [ccInput,setCcInput]=useState('');
  const [bccChips,setBccChips]=useState(()=>strings(review.bcc)); const [bccInput,setBccInput]=useState('');
  const [subject,setSubject]=useState(text(review.subject));
  const [body,setBody]=useState(()=>initialHtml(review.bodyHtml,review.bodyText));
  const [signature,setSignature]=useState(()=>initialHtml(review.signatureHtml,review.signatureText));
  const [bodyChanged,setBodyChanged]=useState(false); const [signatureChanged,setSignatureChanged]=useState(false);
  const recipientStyle={background:'none',border:'none',outline:'none',color:'var(--text-primary)',fontSize:13};
  const save=()=>onSave({
    to:commit(toChips,toInput),cc:commit(ccChips,ccInput),bcc:commit(bccChips,bccInput),subject,
    body,bodyIsHtml:true,bodyChanged,signature,signatureIsHtml:true,signatureChanged,
  });
  const row=(label:string,chips:string[],setChips:(v:string[])=>void,value:string,setValue:(v:string)=>void,testId:string)=><div className="mcp-compose-row"><span>{label}</span><ChipInput chips={chips} onChipsChange={setChips} value={value} onChange={setValue} inputTestId={testId} ariaLabel={label} inputStyle={recipientStyle} disabled={busy}/></div>;
  return <section className="mcp-compose-editor" aria-label={t('mcp.editMessage')}>
    <div className="mcp-compose-header"><strong>{t('mcp.editMessage')}</strong><span>{t('mcp.editHint')}</span></div>
    {row(t('compose.to'),toChips,setToChips,toInput,setToInput,'mcp-mail-to')}
    {row(t('compose.cc'),ccChips,setCcChips,ccInput,setCcInput,'mcp-mail-cc')}
    {row(t('compose.bcc'),bccChips,setBccChips,bccInput,setBccInput,'mcp-mail-bcc')}
    <div className="mcp-compose-subject"><input data-testid="mcp-mail-subject" aria-label={t('compose.subject')} value={subject} onChange={e=>setSubject(e.target.value)} disabled={busy} placeholder={t('compose.subject')}/></div>
    <div className="mcp-compose-body">
      <ComposeBodyField value={body} disabled={busy} onChange={html=>{setBody(html);setBodyChanged(true);}} testId="mcp-mail-body-editor" minHeight={180}/>
      <div className="mcp-compose-signature"><div className="mcp-compose-signature-label">-- {t('admin.accounts.signatureSection')}</div>
        <ComposeSignatureField html value={signature} disabled={busy} onChange={value=>{setSignature(value);setSignatureChanged(true);}}/></div>
    </div>
    <div className="mcp-actions"><Button disabled={busy} onClick={onCancel}>{t('mcp.cancel')}</Button><Button variant="primary" disabled={busy} onClick={()=>void save()}>{busy?t('mcp.savingEdit'):t('mcp.saveEdit')}</Button></div>
  </section>;
}
