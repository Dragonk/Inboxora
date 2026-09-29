import { afterEach, describe, expect, it, vi } from 'vitest';
import addressparser from 'nodemailer/lib/addressparser/index.js';

vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn(async work => work({ query: vi.fn(async () => ({ rows: [] })) })) }));
vi.mock('./redis.js', () => ({ redisClient: { get: vi.fn(), set: vi.fn(), eval: vi.fn() } }));
const append = vi.hoisted(() => vi.fn());
vi.mock('../index.js', () => ({ imapManager: { appendToSent: append, syncFolderOnDemand: vi.fn() } }));
const smtp = vi.hoisted(() => vi.fn(() => { throw new Error('Unexpected SMTP dispatch'); }));
vi.mock('./smtpTransport.js', () => ({ createAccountSmtpTransport: smtp }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn(async () => null) }));
vi.mock('./contactRecipientLearning.js', () => ({ learnLocalRecipient: vi.fn(async () => null) }));
vi.mock('./providerTokenService.js', () => ({ getGoogleAccessToken: vi.fn(async () => ({ accessToken: 'synthetic-token' })) }));
import { query } from './db.js';
import { executeSend } from './sendMail.js';

const accountId='a1000000-0000-4000-8000-000000000001';
const userId='a2000000-0000-4000-8000-000000000001';
const parentId='a3000000-0000-4000-8000-000000000001';
const account={ id:accountId,user_id:userId,name:'Gmail test',sender_name:'Owner, Gmail',
  email_address:'owner@gmail.example.test',mail_transport:'gmail_api',provider_connection_id:'synthetic-connection',
  imap_host:'unused.example.test',oauth_provider:'google',enabled:true };

afterEach(() => { vi.unstubAllGlobals();vi.unstubAllEnvs();vi.clearAllMocks(); });

describe('Gmail reply recipient bytes at the provider boundary', () => {
  it.each(['admin@ovh.example.test','"Admin, OVH <not-a-recipient@example.test>" <admin@ovh.example.test>'])(
    'posts the selected recipient and fresh reply identity for %s without SMTP or APPEND', async recipient => {
    vi.mocked(query).mockImplementation(async sql => {
      if(sql.includes('FROM messages m')) return { rows:[{ id:parentId,account_id:accountId,
        message_id:'<merge-parent@ovh.example.test>',canonical_message_id:null,in_reply_to:null,
        thread_references:'<root@ovh.example.test>',provider_thread_id:'gmail-thread',thread_id:'gmail:gmail-thread',
      }] };
      if(sql.includes('FROM email_accounts')) return { rows:[account] };
      if(sql.includes('SELECT preferences')) return { rows:[{preferences:{}}] };
      if(sql.includes('INSERT INTO address_books')) return { rows:[{id:'synthetic-book'}] };
      return {rows:[],rowCount:1};
    });
    vi.stubEnv('GOOGLE_CLIENT_ID','synthetic-client');vi.stubEnv('GOOGLE_CLIENT_SECRET','synthetic-secret');
    const posted:Array<{raw:string;threadId?:string}>=[];
    vi.stubGlobal('fetch',vi.fn(async (url:string,init?:RequestInit) => {
      // This test never forwards a request: every byte is inspected locally.
      expect(String(url)).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
      expect(init?.method).toBe('POST');
      posted.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({id:'synthetic-sent',threadId:'gmail-thread'}),{status:200,headers:{'content-type':'application/json'}});
    }));
    const result=await executeSend(userId,{accountId,to:[recipient],cc:[],bcc:[],subject:'Re: Test merge',body:'Synthetic reply',
      sendKind:'reply',replyToMessageId:parentId,replyParentAccountId:accountId,
      inReplyTo:'<stale-client-hint@example.test>'},null);
    await new Promise<void>(resolve=>setImmediate(resolve));
    expect(result.status).toBe(200);
    expect(posted).toHaveLength(1);
    expect(posted[0].threadId).toBe('gmail-thread');
    const headers=Buffer.from(posted[0].raw,'base64url').toString('utf8').split('\r\n\r\n')[0].replace(/\r\n[ \t]+/g,' ');
    const header=(name:string)=>new RegExp(`^${name}: (.*)$`,'mi').exec(headers)?.[1]?.trim();
    expect(addressparser(header('To')??'',{flatten:true}).map(item=>item.address)).toEqual(['admin@ovh.example.test']);
    expect(addressparser(header('From')??'',{flatten:true}).map(item=>item.address)).toEqual(['owner@gmail.example.test']);
    expect(header('Cc')).toBeUndefined();expect(header('Bcc')).toBeUndefined();
    expect(header('In-Reply-To')).toBe('<merge-parent@ovh.example.test>');
    expect(header('References')).toBe('<root@ovh.example.test> <merge-parent@ovh.example.test>');
    expect(header('Message-ID')).toMatch(/^<[a-f0-9]{32}@gmail\.example\.test>$/);
    expect(append).not.toHaveBeenCalled();expect(smtp).not.toHaveBeenCalled();
  });
});
