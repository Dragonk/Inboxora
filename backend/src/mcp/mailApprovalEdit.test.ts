import { beforeEach, describe, expect, it, vi } from 'vitest';

const f=vi.hoisted(()=>({execute:vi.fn()}));
vi.mock('../services/sendMail.js',()=>({executeSend:f.execute}));

import { mailReviewFromPrepared, reprepareEditedMail } from './mailApprovalEdit.js';

const existing={
  senderEmail:'sender@example.test',
  senderName:'Sender',
  payload:{
    accountId:'account-1',
    to:['old@example.test'],
    cc:[],
    bcc:[],
    subject:'Original',
    body:'Body',
    bodyIsHtml:false,
    editedSignature:'Signature',
    editedSignatureIsHtml:false,
    attachments:[
      {filename:'ai.txt',content:Buffer.from('AI attachment').toString('base64'),contentType:'text/plain'},
      {filename:'keep.pdf',content:Buffer.from('PDF bytes').toString('base64'),contentType:'application/pdf'},
    ],
  },
  review:{signatureMode:'configured'},
};

beforeEach(()=>{
  vi.clearAllMocks();
  f.execute.mockImplementation(async(_userId:string,payload:Record<string,unknown>)=>({
    status:200,
    body:{ok:true},
    prepared:{senderEmail:'sender@example.test',senderName:'Sender',payload},
  }));
});

describe('human edits of prepared MCP mail',()=>{
  it('keeps selected AI attachments, removes others and adds user files before re-preparing',async()=>{
    const userContent=Buffer.from('user-added').toString('base64');
    const prepared=await reprepareEditedMail('user-1',existing as never,{
      to:['new@example.test'],cc:[],bcc:[],subject:'Edited',body:'Body',bodyIsHtml:false,bodyChanged:false,
      signature:'Signature',signatureIsHtml:false,signatureChanged:false,
      keepAttachmentIndexes:[1],
      newAttachments:[{filename:'user.txt',content:userContent,contentType:'text/plain'}],
    });

    expect(f.execute).toHaveBeenCalledWith('user-1',expect.objectContaining({
      to:['new@example.test'],
      attachments:[
        expect.objectContaining({filename:'keep.pdf'}),
        {filename:'user.txt',content:userContent,contentType:'text/plain'},
      ],
    }),null,{prepareOnly:true,expectedSenderEmail:'sender@example.test',expectedSenderName:'Sender'});
    expect(prepared.review.attachments).toEqual([
      expect.objectContaining({index:0,filename:'keep.pdf'}),
      expect.objectContaining({index:1,filename:'user.txt'}),
    ]);
  });

  it('rejects a stale attachment index rather than silently sending a different set',async()=>{
    await expect(reprepareEditedMail('user-1',existing as never,{
      to:['old@example.test'],cc:[],bcc:[],subject:'Original',body:'Body',bodyIsHtml:false,bodyChanged:false,
      signature:'Signature',signatureIsHtml:false,signatureChanged:false,
      keepAttachmentIndexes:[7],newAttachments:[],
    })).rejects.toMatchObject({code:'ATTACHMENT_SELECTION_INVALID',status:409});
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('numbers prepared attachments so the browser can preview the exact frozen bytes',()=>{
    const review=mailReviewFromPrepared(existing as never,'configured');
    expect(review).toMatchObject({accountId:'account-1',attachments:[
      {index:0,filename:'ai.txt',contentType:'text/plain'},
      {index:1,filename:'keep.pdf',contentType:'application/pdf'},
    ]});
  });
});
