import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarSenders, calendarSenderValue } from './calendarSenders.ts';

test('API-only mailboxes offer the primary identity and every valid owned alias',()=>{
  for(const mail_transport of ['gmail_api','microsoft_graph']) {
    const choices=calendarSenders([{id:'mailbox',enabled:true,mail_transport,email_address:'primary@example.test',name:'Work',aliases:[
      {id:'one',email:'one@example.test',name:'One'},{id:'two',email:'two@example.test'},{id:'empty',email:null},
    ]}]);
    assert.deepEqual(choices.map(choice=>[choice.value,choice.accountId,choice.aliasId,choice.email]),[
      ['mailbox','mailbox','','primary@example.test'],['mailbox:one','mailbox','one','one@example.test'],['mailbox:two','mailbox','two','two@example.test'],
    ]);
    assert.equal(choices[1].label,'One · one@example.test');
  }
});
test('disabled and receive-only IMAP accounts do not become invitation senders',()=>{
  assert.deepEqual(calendarSenders([
    {id:'disabled',enabled:false,smtp_host:'smtp.example.test'},
    {id:'imap-only',enabled:true,mail_transport:'imap'},
    {id:'native-disabled',enabled:false,mail_transport:'microsoft_graph'},
  ]),[]);
  assert.equal(calendarSenders([{id:'smtp',enabled:true,smtp_host:'smtp.example.test',email_address:'me@example.test'}])[0].value,'smtp');
});
test('an unavailable stored alias never resolves to the primary mailbox',()=>{
  const choices=calendarSenders([{id:'mailbox',enabled:true,mail_transport:'gmail_api',email_address:'primary@example.test'}]);
  assert.equal(choices.find(choice=>choice.value===calendarSenderValue('mailbox','deleted-alias')),undefined);
  assert.equal(calendarSenderValue('','old-alias'),'');
  assert.equal(calendarSenderValue('mailbox'),'mailbox');
});
