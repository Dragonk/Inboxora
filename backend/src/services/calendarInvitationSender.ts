import { query } from './db.js';
import { isUuid } from '../utils/uuid.js';
interface Alias { id: string; email: string; name: string | null }
export interface InvitationAliasFields { [key: string]: unknown; invitation_alias_id?: string; invitation_from_email?: string; invitation_from_name?: string | null }
interface Account extends InvitationAliasFields { id?: string; email_address?: string | null; name?: string | null; [key:string]:unknown }
export async function withInvitationAlias<T extends Account>(account:T,aliasId:unknown,
  execute:(sql:string,values:unknown[])=>Promise<{rows:Alias[]}>=query):Promise<T & InvitationAliasFields> {
  if (aliasId===undefined || aliasId===null || aliasId==='') return account;
  if (!isUuid(aliasId) || !account.id) throw Object.assign(new Error('Invalid invitation sender alias'),{status:400});
  const alias=(await execute('SELECT id,email,name FROM account_aliases WHERE id=$1 AND account_id=$2',[aliasId,account.id])).rows[0];
  if (!alias?.email) throw Object.assign(new Error('Selected invitation sender alias is unavailable'),{status:409});
  return {...account,invitation_alias_id:alias.id,invitation_from_email:alias.email,invitation_from_name:alias.name};
}
