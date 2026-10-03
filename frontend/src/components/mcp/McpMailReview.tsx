import { useTranslation } from 'react-i18next';
import MessageHeaderCard from '../MessageHeaderCard.tsx';
import MessageDetailContent from '../MessageDetailContent.tsx';
import AttachmentPreviewModal from '../attachments/AttachmentPreviewModal.tsx';
import { useStore } from '../../store/index.ts';
import { downloadBlob, fetchOriginalAttachment } from '../../utils/attachments/fetchAttachment.ts';

type Review = Record<string, unknown>;
type ReviewAttachment = { index:number; filename:string; bytes:number; contentType:string };

function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
function attachments(value:unknown):ReviewAttachment[] {
  if(!Array.isArray(value))return [];
  return value.flatMap((item,index)=>{
    if(!item||typeof item!=='object'||Array.isArray(item))return [];
    const row=item as Record<string,unknown>;
    return [{index:Number.isInteger(row.index)?Number(row.index):index,filename:text(row.filename)||'attachment',bytes:number(row.bytes),contentType:text(row.contentType)||'application/octet-stream'}];
  });
}
function plainToHtml(value:string):string {
  return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}
function renderedBody(review:Review):{html:string;text:string} {
  const bodyHtml=text(review.bodyHtml); const bodyText=text(review.bodyText);
  const signatureHtml=text(review.signatureHtml); const signatureText=text(review.signatureText);
  const quotedHtml=text(review.quotedHtml); const quotedText=text(review.quotedText);
  const hasHtml=Boolean(bodyHtml||signatureHtml||quotedHtml);
  if(!hasHtml) return {html:'',text:[bodyText,signatureText,quotedText].filter(Boolean).join('\n\n')};
  const body=bodyHtml||plainToHtml(bodyText);
  const signature=signatureHtml||plainToHtml(signatureText);
  const quote=quotedHtml||plainToHtml(quotedText);
  return {html:[
    body,
    signature ? '<div><br></div>'+signature : '',
    quote ? '<blockquote style="border-left:2px solid #ccc;margin:12px 0 0;padding-left:10px">'+quote+'</blockquote>' : '',
  ].join(''),text:''};
}

export function isMailReview(review: Review | null | undefined): boolean {
  return review?.kind === 'mail' && typeof review.senderEmail === 'string';
}

export default function McpMailReview({ operationId, review }: { operationId:string; review: Review }) {
  const { t }=useTranslation();
  const authEpoch=useStore(state=>state.authEpoch);
  const senderEmail=text(review.senderEmail);
  const senderName=text(review.senderName)||senderEmail;
  const files=attachments(review.attachments);
  const bcc=strings(review.bcc);
  const accountId=text(review.accountId)||'mcp-review';
  const pathFor=(part:string|undefined)=>part===undefined?'':'/api/mcp/operations/'+encodeURIComponent(operationId)+'/attachments/'+encodeURIComponent(part);
  const body=renderedBody(review);
  const download=async(part:string|undefined,filename:string|undefined)=>{
    const path=pathFor(part); if(!path)return;
    const controller=new AbortController();
    const blob=await fetchOriginalAttachment(path,authEpoch,controller.signal);
    downloadBlob(blob,filename||t('attachment.preview.unnamed'));
  };
  return <section className="mcp-mail-reader" aria-label={t('mcp.mailPreview')}>
    <MessageHeaderCard
      message={{subject:text(review.subject),from_email:senderEmail,from_name:senderName,account_email:senderEmail}}
      subject={text(review.subject)}
      toList={strings(review.to).map(email=>({email}))}
      ccList={strings(review.cc).map(email=>({email}))}
      recipientExtras={bcc.length?<div className="mcp-reader-bcc"><span>{t('compose.bcc')} </span><span>{bcc.join(', ')}</span></div>:undefined}
      date={review.priority==='high'?<span className="mcp-mail-priority">{t('mcp.priorityHigh')}</span>:review.priority==='low'?<span className="mcp-mail-priority">{t('mcp.priorityLow')}</span>:null}
    />
    <MessageDetailContent
      message={{id:operationId,account_id:accountId,from_email:senderEmail,from_name:senderName}}
      body={{html:body.html,text:body.text,attachments:files.map(file=>({part:String(file.index),filename:file.filename,type:file.contentType,size:file.bytes}))}}
      readOnly
      hideDownloadAll
      getAttachmentPath={part=>pathFor(part)}
      onDownloadAttachment={download}
      downloadErrorLabel={t('attachment.preview.failed')}
      className="mcp-mail-reader-content"
    />
    <AttachmentPreviewModal/>
  </section>;
}
