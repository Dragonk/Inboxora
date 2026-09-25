import { randomUUID } from 'node:crypto'; import { Client } from 'pg'; import { describe, expect, it } from 'vitest';
const suite=process.env.DB_HOST&&process.env.DB_NAME?describe:describe.skip;
suite('calendar collection projection receipt migration',()=>{
 it('records a durable local-projection obligation with account/connection ownership',async()=>{
  const c=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT??5432),database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD});await c.connect();try{await c.query('BEGIN');const user=randomUUID(),account=randomUUID(),connection=randomUUID(),op=randomUUID();
   await c.query("INSERT INTO users (id,username,password_hash) VALUES ($1,$2,'x')",[user,`projection-${user}`]);
   await c.query("INSERT INTO email_accounts (id,user_id,name,email_address,protocol,imap_host,imap_port,smtp_host,smtp_port) VALUES ($1,$2,'Projection',$3,'imap','example.test',993,'example.test',587)",[account,user,`${account}@example.test`]);
   await c.query("INSERT INTO provider_connections (id,user_id,provider,issuer,subject) VALUES ($1,$2,'google','https://accounts.google.com',$3)",[connection,user,connection]);
   await c.query('UPDATE email_accounts SET provider_connection_id=$1 WHERE id=$2',[connection,account]);
   await c.query("INSERT INTO provider_operations (id,user_id,account_id,connection_id,resource_type,operation,status) VALUES ($1,$2,$3,$4,'calendar_collection','create','committed')",[op,user,account,connection]);
   await c.query("INSERT INTO calendar_collection_projection_receipts(operation_id,user_id,account_id,connection_id,action,remote_calendar_id) VALUES($1,$2,$3,$4,'create','remote')",[op,user,account,connection]);
   const row=await c.query('SELECT state,collection_id,local_calendar_id FROM calendar_collection_projection_receipts WHERE operation_id=$1',[op]);expect(row.rows[0]).toMatchObject({state:'pending',collection_id:null,local_calendar_id:null});
   await c.query("UPDATE calendar_collection_projection_receipts SET state='projected',projected_at=NOW() WHERE operation_id=$1",[op]);expect((await c.query('SELECT state FROM calendar_collection_projection_receipts WHERE operation_id=$1',[op])).rows[0]).toMatchObject({state:'projected'});
  }finally{try{await c.query('ROLLBACK')}finally{await c.end()}};
 })
});
