import { OleFileIO } from 'office-crypto';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { processAttachment, type ProcessingInput } from './processing.js';
import { runAttachmentWorker } from './pool.js';
const bytes=(name:string)=>new Uint8Array(readFileSync(new URL(`../../../fixtures/attachments/${name}`,import.meta.url)));

describe('stateless attachment processing',()=>{
  it.each([
    ['example_password.docx','Password1234_','agile'],
    ['example_password.xlsx','Password1234_','agile'],
    ['ecma376standard_password.docx','Password1234_','standard'],
    ['rc4cryptoapi_password.xls','Password1234_','xls97'],
    ['xor_password_123456789012345.xls','123456789012345','xls97'],
  ])('probes and unlocks the real %s fixture without persisting it',async(name,password,encryption)=>{
    const encrypted=bytes(name);const initial=Buffer.from(encrypted);
    const probe=await processAttachment({action:'probe',bytes:encrypted});
    expect(probe.json).toMatchObject({encrypted:true,encryption});
    await expect(processAttachment({action:'unlock',bytes:encrypted,password:'wrong-password'})).rejects.toMatchObject({code:'WRONG_PASSWORD'});
    const unlocked=await processAttachment({action:'unlock',bytes:encrypted,password});
    expect(unlocked.bytes?.length).toBeGreaterThan(100);expect(Buffer.from(encrypted)).toEqual(initial);
    const after=await processAttachment({action:'probe',bytes:unlocked.bytes!});expect(after.json?.encrypted).toBe(false);
  });
  it('refuses a corrupted Agile payload even with the correct password', async () => {
    const container = new OleFileIO(bytes('example_password.docx'));
    const packed = container.openstream('EncryptedPackage').getValue().slice();
    packed[packed.length - 1] ^= 1;
    container.writeStream('EncryptedPackage', packed);
    await expect(processAttachment({ action: 'unlock', bytes: container.getBuffer(), password: 'Password1234_' })).rejects.toMatchObject({ code: 'CORRUPT' });
  });
  it('checks encrypted plaintext size before attempting password derivation', async () => {
    const container = new OleFileIO(bytes('example_password.docx'));
    const packed = container.openstream('EncryptedPackage').getValue().slice();
    new DataView(packed.buffer).setBigUint64(0, 1024n * 1024n * 1024n, true);
    container.writeStream('EncryptedPackage', packed);
    await expect(processAttachment({ action: 'unlock', bytes: container.getBuffer() })).rejects.toMatchObject({ code: 'LIMIT' });
  });
  it('does not mistake every compound file for an encrypted document',async()=>{
    const result=await processAttachment({action:'probe',bytes:bytes('plain.xls')});
    expect(result.json).toMatchObject({encrypted:false,format:'xls97'});
    await expect(processAttachment({action:'unlock',bytes:bytes('text.txt'),password:'anything'})).rejects.toMatchObject({code:'UNSUPPORTED'});
  });
  it('parses EML without executing or fetching its HTML, and returns exact inner attachment bytes',async()=>{
    const result=await processAttachment({action:'eml-parse',bytes:bytes('message.eml')});
    expect(result.json).toMatchObject({subject:'EML fixture'});expect(result.json?.html).toContain('EML safe body');
    expect(result.json?.attachments).toHaveLength(2);
    const part=await processAttachment({action:'eml-part',bytes:bytes('message.eml'),index:0});
    expect(Buffer.from(part.bytes!).toString()).toBe('Nested EML attachment bytes\n');expect(part.filename).toBe('inner.txt');
    await expect(processAttachment({action:'eml-part',bytes:bytes('message.eml'),index:99})).rejects.toMatchObject({code:'INVALID_INPUT'});
  });
  it('reuses calendar/contact parsers, retains identifiers and returns selectable records',async()=>{
    const calendar=await processAttachment({action:'cards',bytes:bytes('events.ics'),kind:'ics'});
    const contacts=await processAttachment({action:'cards',bytes:bytes('contacts.vcf'),kind:'vcf'});
    expect(calendar.json?.cards).toHaveLength(2);expect(contacts.json?.cards).toHaveLength(2);
    expect(JSON.stringify(calendar.json)).toContain('preview-event-1');expect(JSON.stringify(contacts.json)).toContain('preview-contact-2');
  });
  it('executes the same parser in a disposable real worker and supports cancellation',async()=>{
    const controller=new AbortController();
    const result=await runAttachmentWorker({action:'unlock',bytes:bytes('example_password.docx'),password:'Password1234_'},controller.signal);
    expect(result.bytes?.[0]).toBe(80);expect(result.bytes?.[1]).toBe(75);
    const cancelled=new AbortController();cancelled.abort();
    expect(()=>runAttachmentWorker({action:'probe',bytes:bytes('plain.xls')},cancelled.signal)).toThrow();
    const active=new AbortController();const pending=runAttachmentWorker({action:'unlock',bytes:bytes('example_password.docx'),password:'Password1234_'},active.signal);
    active.abort();await expect(pending).rejects.toMatchObject({code:'CANCELLED'});
  });
  it('rejects empty, oversized and invalid work without leaking supplied values',async()=>{
    for(const input of [
      {action:'probe',bytes:new Uint8Array()},
      {action:'probe',bytes:new Uint8Array(50*1024*1024+1)},
    ] satisfies ProcessingInput[]) await expect(processAttachment(input)).rejects.toMatchObject({code:'LIMIT'});
    await expect(processAttachment({action:'cards',bytes:bytes('text.txt'),kind:'other'})).rejects.toMatchObject({code:'INVALID_INPUT'});
  });
});
