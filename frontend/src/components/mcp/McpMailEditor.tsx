import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui.tsx';
import ComposeBodyField from '../ComposeBodyField.tsx';
import ComposeSignatureField from '../ComposeSignatureField.tsx';
import { AttachmentChips, ChipInput } from '../ComposeModal.tsx';
import ComposeAttachmentPreview from '../attachments/ComposeAttachmentPreview.tsx';
import { sanitizeMessageHtml } from '../MessageBodyRenderer.tsx';
import { parseMcpRecipients } from '../../utils/mcpRecipients.ts';
import { attachmentBatchIssue, type AttachmentLimits } from '../../utils/attachmentUpload.ts';
import type { DraftPreviewSource } from '../../utils/attachments/draftPreview.ts';
import { api } from '../../utils/api.ts';
import { useStore } from '../../store/index.ts';

type Review = Record<string, unknown>;
type ExistingAttachment = { index: number; filename: string; bytes: number; contentType: string };
type AddedAttachment = { id: string; name: string; size: number; type: string; data: string };

export interface McpMailEdits {
  to:string[]; cc:string[]; bcc:string[]; subject:string;
  body:string; bodyIsHtml:true; bodyChanged:boolean;
  signature:string; signatureIsHtml:true; signatureChanged:boolean; priority:'high'|'normal'|'low';
  keepAttachmentIndexes:number[];
  newAttachments:Array<{filename:string;content:string;contentType?:string}>;
}

function strings(value:unknown):string[]{return Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'):[];}
function text(value:unknown):string {return typeof value==='string'?value:'';}
function number(value:unknown):number {return typeof value==='number'&&Number.isFinite(value)?value:0;}
function encodePlain(value:string):string {return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');}
function initialHtml(html:unknown,plain:unknown):string {
  return sanitizeMessageHtml(text(html)||encodePlain(text(plain)),{remoteImages:false,tone:'light'});
}
function commit(chips:string[],pending:string):string[] {
  return parseMcpRecipients([...chips, pending].filter(Boolean).join('; '));
}
function humanBytes(bytes:number):string {
  if(bytes<1024)return bytes+' B';
  if(bytes<1024*1024)return Math.round(bytes/1024)+' KB';
  return (bytes/(1024*1024)).toFixed(1)+' MB';
}
function preparedAttachments(value:unknown):ExistingAttachment[] {
  if(!Array.isArray(value))return [];
  return value.flatMap((item,index)=>{
    if(!item||typeof item!=='object'||Array.isArray(item))return [];
    const row=item as Record<string,unknown>;
    return [{
      index:Number.isInteger(row.index)?Number(row.index):index,
      filename:text(row.filename)||'attachment',
      bytes:number(row.bytes),
      contentType:text(row.contentType)||'application/octet-stream',
    }];
  });
}

export default function McpMailEditor({operationId,review,busy,onCancel,onSave}:{operationId:string;review:Review;busy:boolean;onCancel:()=>void;onSave:(edits:McpMailEdits)=>Promise<void>|void}){
  const {t}=useTranslation();
  const authEpoch=useStore(state=>state.authEpoch);
  const fileInput=useRef<HTMLInputElement|null>(null);
  const [toChips,setToChips]=useState(()=>strings(review.to)); const [toInput,setToInput]=useState('');
  const [ccChips,setCcChips]=useState(()=>strings(review.cc)); const [ccInput,setCcInput]=useState('');
  const [bccChips,setBccChips]=useState(()=>strings(review.bcc)); const [bccInput,setBccInput]=useState('');
  const [showCc,setShowCc]=useState(()=>strings(review.cc).length>0);
  const [showBcc,setShowBcc]=useState(()=>strings(review.bcc).length>0);
  const [subject,setSubject]=useState(text(review.subject));
  const [body,setBody]=useState(()=>initialHtml(review.bodyHtml,review.bodyText));
  const [signature,setSignature]=useState(()=>initialHtml(review.signatureHtml,review.signatureText));
  const initialSignature=initialHtml(review.signatureHtml,review.signatureText);
  const showSignature=Boolean(initialSignature||signature);
  const initialPriority=text(review.priority);
  const [priority,setPriority]=useState<'high'|'normal'|'low'>(initialPriority==='high'||initialPriority==='low'?initialPriority:'normal');
  const [bodyChanged,setBodyChanged]=useState(false); const [signatureChanged,setSignatureChanged]=useState(false);
  const [existing,setExisting]=useState(()=>preparedAttachments(review.attachments));
  const [added,setAdded]=useState<AddedAttachment[]>([]);
  const [readingFiles,setReadingFiles]=useState(false);
  const [attachmentError,setAttachmentError]=useState('');
  const [limits,setLimits]=useState<AttachmentLimits>({singleAttachmentBytes:25*1024*1024,totalAttachmentBytes:25*1024*1024});
  const [preview,setPreview]=useState<{files:DraftPreviewSource[];index:number}|null>(null);

  useEffect(()=>{
    const accountId=text(review.accountId);
    if(!accountId)return;
    let current=true;
    void api.getSendLimits(accountId).then((response:{limits?:AttachmentLimits})=>{
      if(current&&response?.limits)setLimits(response.limits);
    }).catch(()=>{});
    return()=>{current=false;};
  },[review.accountId]);

  const recipientStyle={background:'none',border:'none',outline:'none',color:'var(--text-primary)',fontSize:13};
  const allBytes=()=>existing.reduce((sum,item)=>sum+item.bytes,0)+added.reduce((sum,item)=>sum+item.size,0);
  const previewSources=():DraftPreviewSource[]=>[
    ...existing.map(item=>({filename:item.filename,type:item.contentType,size:item.bytes,path:'/api/mcp/operations/'+encodeURIComponent(operationId)+'/attachments/'+item.index})),
    ...added.map(item=>({filename:item.name,type:item.type,size:item.size,content:item.data})),
  ];
  const openPreview=(index:number)=>setPreview({files:previewSources(),index});
  const removeAttachment=(index:number)=>{
    if(index<existing.length)setExisting(current=>current.filter((_item,i)=>i!==index));
    else setAdded(current=>current.filter((_item,i)=>i!==index-existing.length));
  };
  const readFiles=(files:File[])=>{
    setAttachmentError('');
    const uniqueNames=new Set([...existing.map(item=>item.filename),...added.map(item=>item.name)]);
    const candidates=files.filter(file=>{if(uniqueNames.has(file.name))return false;uniqueNames.add(file.name);return true;});
    if(existing.length+added.length+candidates.length>100){setAttachmentError(t('attachment.compose.tooMany'));return;}
    const issue=attachmentBatchIssue(candidates,allBytes(),0,limits);
    if(issue){
      setAttachmentError(issue.kind==='single'
        ? t('compose.limitAttachmentTooLarge',{name:issue.name,actual:humanBytes(issue.actual),limit:humanBytes(issue.limit),transport:'provider'})
        : t('compose.limitTooLarge',{actual:humanBytes(issue.actual),limit:humanBytes(issue.limit),transport:'provider'}));
      return;
    }
    if(!candidates.length)return;
    setReadingFiles(true);
    let remaining=candidates.length;
    for(const file of candidates){
      const reader=new FileReader();
      const finish=()=>{remaining-=1;if(remaining===0)setReadingFiles(false);};
      reader.onload=()=>{
        try{
          const result=reader.result;
          if(typeof result!=='string'||!result.includes(',')){setAttachmentError(t('attachment.compose.readError'));return;}
          setAdded(current=>[...current,{id:crypto.randomUUID?.()||String(Date.now())+Math.random(),name:file.name,size:file.size,type:file.type||'application/octet-stream',data:result.slice(result.indexOf(',')+1)}]);
        }finally{finish();}
      };
      reader.onerror=()=>{setAttachmentError(t('attachment.compose.readError'));finish();};
      reader.onabort=finish;
      reader.readAsDataURL(file);
    }
  };
  const onFileInput=(event:React.ChangeEvent<HTMLInputElement>)=>{readFiles(Array.from(event.target.files||[]));event.target.value='';};
  const save=()=>onSave({
    to:commit(toChips,toInput),cc:commit(ccChips,ccInput),bcc:commit(bccChips,bccInput),subject,
    body,bodyIsHtml:true,bodyChanged,signature,signatureIsHtml:true,signatureChanged,priority,
    keepAttachmentIndexes:existing.map(item=>item.index),
    newAttachments:added.map(item=>({filename:item.name,content:item.data,contentType:item.type||undefined})),
  });
  const row=(label:string,chips:string[],setChips:(v:string[])=>void,value:string,setValue:(v:string)=>void,testId:string)=><div className="mcp-compose-row"><span>{label}</span><ChipInput chips={chips} onChipsChange={setChips} value={value} onChange={setValue} inputTestId={testId} ariaLabel={label} inputStyle={recipientStyle} disabled={busy}/></div>;
  const attachmentRows=[...existing.map(item=>({name:item.filename,size:item.bytes})),...added.map(item=>({name:item.name,size:item.size}))];

  return <section className="mcp-compose-editor" aria-label={t('mcp.editMessage')}
    onDragOver={event=>{if(Array.from(event.dataTransfer.types).includes('Files'))event.preventDefault();}}
    onDrop={event=>{if(!Array.from(event.dataTransfer.types).includes('Files'))return;event.preventDefault();readFiles(Array.from(event.dataTransfer.files));}}>
    <input ref={fileInput} type="file" multiple style={{display:'none'}} onChange={onFileInput}/>
    <div className="mcp-compose-header"><strong>{t('mcp.editMessage')}</strong><span>{t('mcp.editHint')}</span></div>
    <div className="mcp-compose-row mcp-compose-from"><span>{t('compose.from')}</span><strong>{text(review.senderName)||text(review.senderEmail)}</strong><small>{text(review.senderEmail)}</small></div>
    <div className="mcp-compose-to-row">
      {row(t('compose.to'),toChips,setToChips,toInput,setToInput,'mcp-mail-to')}
      {(!showCc||!showBcc)&&<div className="mcp-compose-ccbcc-quickadd">
        {!showCc&&<button type="button" onClick={()=>setShowCc(true)}>{t('compose.cc')}</button>}
        {!showBcc&&<button type="button" onClick={()=>setShowBcc(true)}>{t('compose.bcc')}</button>}
      </div>}
    </div>
    {showCc&&row(t('compose.cc'),ccChips,setCcChips,ccInput,setCcInput,'mcp-mail-cc')}
    {showBcc&&row(t('compose.bcc'),bccChips,setBccChips,bccInput,setBccInput,'mcp-mail-bcc')}
    <div className="mcp-compose-row mcp-compose-subject"><span>{t('compose.subject')}</span><input data-testid="mcp-mail-subject" aria-label={t('compose.subject')} value={subject} onChange={e=>setSubject(e.target.value)} disabled={busy} placeholder={t('compose.subject')}/></div>
    {attachmentRows.length>0&&<AttachmentChips attachments={attachmentRows} onPreview={openPreview} onRemove={removeAttachment}/>}
    {readingFiles&&<p role="status" className="compose-attachment-notice">{t('attachment.compose.reading')}</p>}
    {attachmentError&&<p role="alert" className="mcp-error mcp-compose-attachment-error">{attachmentError}</p>}
    <div className="mcp-compose-body">
      <ComposeBodyField value={body} disabled={busy} onAttach={()=>fileInput.current?.click()} allowInlineImages onChange={html=>{setBody(html);setBodyChanged(true);}} testId="mcp-mail-body-editor" minHeight={200}/>
      {showSignature&&<div className="mcp-compose-signature">
        <div className="mcp-compose-signature-label">-- {t('admin.accounts.signatureSection')}</div>
        <ComposeSignatureField html value={signature} disabled={busy} onChange={value=>{setSignature(value);setSignatureChanged(true);}}/>
      </div>}
    </div>
    <div className="mcp-compose-footer">
      <div className="mcp-actions"><Button disabled={busy||readingFiles} onClick={onCancel}>{t('mcp.cancel')}</Button><Button variant="primary" disabled={busy||readingFiles} onClick={()=>void save()}>{busy?t('mcp.savingEdit'):t('mcp.saveEdit')}</Button></div>
      <select value={priority} onChange={event=>setPriority(event.target.value as 'high'|'normal'|'low')} title={t('compose.priority')} disabled={busy}>
        <option value="high">{t('compose.priorityHigh')}</option>
        <option value="normal">{t('compose.priorityNormal')}</option>
        <option value="low">{t('compose.priorityLow')}</option>
      </select>
    </div>
    {preview&&<ComposeAttachmentPreview files={preview.files} initialIndex={preview.index} epoch={authEpoch} onClose={()=>setPreview(null)}/>}
  </section>;
}
