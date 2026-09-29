import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposedMail } from './composedMail.js';
const mocks=vi.hoisted(()=>({smtp:vi.fn(),binding:vi.fn(),target:vi.fn(),query:vi.fn(),send:vi.fn(),preflight:vi.fn()}));
vi.mock('./db.js',()=>({query:mocks.query}));
vi.mock('./smtpTransport.js',()=>({createAccountSmtpTransport:mocks.smtp}));
vi.mock('./mailTransportTarget.js',()=>({resolveMailTransportForSync:mocks.target}));
vi.mock('./sendTransport.js',()=>({createAccountMailTransport:mocks.binding}));
import { prepareCalendarInvitation } from './calendarInvitation.js';
import { invitationActionsForStorage } from './calendarInvitationOutbox.js';
const accountId='a0000000-0000-4000-8000-000000000001';const userId='b0000000-0000-4000-8000-000000000001';const aliasId='c0000000-0000-4000-8000-000000000001';
const input={attendees:['guest@example.test'],uid:'event@example.test',summary:'Review',startsAt:new Date('2026-10-01T09:00:00Z'),endsAt:new Date('2026-10-01T10:00:00Z')};
beforeEach(()=>{vi.resetAllMocks();mocks.target.mockResolvedValue({kind:'graph'});mocks.binding.mockResolvedValue({transport:{send:mocks.send,preflight:mocks.preflight}});mocks.preflight.mockResolvedValue(null);mocks.send.mockResolvedValue({status:'accepted'});mocks.query.mockResolvedValue({rows:[{id:aliasId,email:'alias@example.test',name:'Alias'}]});});
describe('native invitation senders',()=>{
  it.each(['gmail_api','microsoft_graph'])('uses %s and the selected alias without falling back to SMTP',async mail_transport=>{
    const account={id:accountId,user_id:userId,name:'Owner',email_address:'owner@example.test',mail_transport,invitation_alias_id:aliasId,invitation_from_email:'alias@example.test',smtp_password:'must-not-be-stored'};
    const storage=invitationActionsForStorage([{...input,account}]);expect(storage[0]).toMatchObject({accountId,aliasId,senderEmail:'alias@example.test'});expect(JSON.stringify(storage)).not.toContain('must-not-be-stored');
    const prepared=await prepareCalendarInvitation({...input,account,aliasId,senderEmail:'alias@example.test'});
    expect(mocks.send).not.toHaveBeenCalled();const result=await prepared.dispatch();
    const mail=mocks.send.mock.calls[0][0].composed as ComposedMail;
    expect(mail.from.email).toBe('alias@example.test');expect(mail.attachments?.[0].content.toString()).toContain('ORGANIZER:mailto:alias@example.test');
    expect(result).toMatchObject({accepted:['guest@example.test'],rejected:[]});expect(mocks.smtp).not.toHaveBeenCalled();
  });
  it('stops before dispatch when a frozen alias was deleted or changed',async()=>{
    const account={id:accountId,user_id:userId,email_address:'owner@example.test',mail_transport:'microsoft_graph'};
    mocks.query.mockResolvedValueOnce({rows:[]});
    await expect(prepareCalendarInvitation({...input,account,aliasId,senderEmail:'alias@example.test'})).rejects.toMatchObject({status:409});
    await expect(prepareCalendarInvitation({...input,account,aliasId,senderEmail:'old-alias@example.test'})).rejects.toMatchObject({status:409});
    expect(mocks.send).not.toHaveBeenCalled();expect(mocks.binding).not.toHaveBeenCalled();expect(mocks.smtp).not.toHaveBeenCalled();
  });
  it('keeps an unknown provider outcome uncertain and never tries a second transport',async()=>{
    const account={id:accountId,user_id:userId,email_address:'owner@example.test',mail_transport:'microsoft_graph'};
    mocks.send.mockResolvedValue({status:'uncertain'});const prepared=await prepareCalendarInvitation({...input,account});
    await expect(prepared.dispatch()).rejects.toThrow('uncertain');expect(mocks.send).toHaveBeenCalledTimes(1);expect(mocks.smtp).not.toHaveBeenCalled();
  });
  it('does not send when native preflight refuses the selected identity',async()=>{
    mocks.preflight.mockResolvedValue({statusCode:409,error:'Alias is no longer available'});
    await expect(prepareCalendarInvitation({...input,account:{id:accountId,user_id:userId,email_address:'owner@example.test',mail_transport:'gmail_api'}})).rejects.toMatchObject({status:409});
    expect(mocks.send).not.toHaveBeenCalled();expect(mocks.smtp).not.toHaveBeenCalled();
  });
});
