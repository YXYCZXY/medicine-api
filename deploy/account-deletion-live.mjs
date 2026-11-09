// Explicit live verification. Secrets travel over SSH stdin, never CLI args/logs.
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { reloginRemote } from './account-deletion-relogin.mjs';
const mode = process.argv[2] ?? 'preflight';
const allowed = ['preflight', 'login-code', 'relogin-code', 'login-verify'];
if (!allowed.includes(mode)) throw new Error('Unsupported live verification mode');
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const remote = String.raw`
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
const input = JSON.parse(readFileSync(0, 'utf8'));
if (input.url !== process.env.SUPABASE_URL) throw new Error('PROJECT_MISMATCH');
const client = createClient(input.url, input.adminKey, {
  auth: {persistSession:false, autoRefreshToken:false, detectSessionInUrl:false},
  global: {fetch:(url, options)=>fetch(url,{...options,signal:AbortSignal.timeout(15000)})},
});
const report = {mode:input.mode, startedAt:new Date().toISOString(), checks:[]};
function record(stage, details) { const result={stage,...details}; report.checks.push(result); console.log(JSON.stringify(result)); }
try {
  const admins = await client.auth.admin.listUsers({page:1,perPage:1});
  record('supabase-admin-key', {ok:!admins.error, status:admins.error?.status, code:admins.error?.code});
  if (admins.error) process.exitCode=1;
  const buckets = await client.storage.listBuckets();
  record('supabase-storage', {ok:!buckets.error, bucketCount:buckets.data?.length});
  if (buckets.error) process.exitCode=1;
  if (buckets.data?.length) {
    const rpc = await client.rpc('account_deletion_owned_objects',{p_user_id:'00000000-0000-4000-8000-000000000000'});
    record('storage-ownership-rpc',{ok:!rpc.error,code:rpc.error?.code});
    if (rpc.error) process.exitCode=1;
  }
  const settingsResponse = await fetch(input.url+'/auth/v1/settings',{headers:{apikey:process.env.SUPABASE_PUBLISHABLE_KEY},signal:AbortSignal.timeout(15000)});
  const settings = await settingsResponse.json();
  record('supabase-phone-settings',{ok:settingsResponse.ok,phoneEnabled:settings.external?.phone,phoneAutoConfirm:settings.phone_autoconfirm});
  record('server-environment',{ok:true,adminKeyPresent:!!process.env.SUPABASE_SERVICE_ROLE_KEY,smsHookEnabled:process.env.SMS_HOOK_ENABLED==='true'});
  const db = new pg.Client({connectionString:process.env.DATABASE_URL});
  await db.connect();
  try {
    const migrations=await db.query("SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name");
    const task=await db.query("SELECT to_regclass('public.account_deletion_tasks') IS NOT NULL AS ready");
    record('business-database',{ok:true,migrationCount:migrations.rows.length,latestMigration:migrations.rows.at(-1)?.migration_name,deletionTablesReady:task.rows[0].ready});
    if (input.credentials) {
      const pub=createClient(input.url,process.env.SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
      const login=await pub.auth.signInWithPassword({phone:input.credentials.phone,password:input.credentials.password});
      if (login.error) {
        record('previous-test-account-login',{ok:false,code:login.error.code});
        const found=await db.query("SELECT id, nickname FROM users WHERE replace(phone,'+','')=replace($1,'+','')",[input.credentials.phone]);
        const candidateId=found.rows[0]?.id??input.credentials.userId;
        const lookup=await client.auth.admin.getUserById(candidateId);
        if (lookup.error) record('previous-test-account-lookup',{ok:false,status:lookup.error.status,code:lookup.error.code,businessAccountExists:!!found.rows.length});
        else {
          const user=lookup.data.user;
          const counts={};
          for(const table of ['medicine_items','visit_records','health_reminders','blood_pressure_records','sync_attachments']) counts[table]=Number((await db.query('SELECT count(*) AS n FROM '+table+' WHERE user_id=$1',[user.id])).rows[0].n);
          const named=await db.query("SELECT count(*) AS n FROM medicine_items WHERE user_id=$1 AND name NOT LIKE '[部署验收]%'",[user.id]);
          record('previous-test-account-lookup',{ok:true,idMatches:input.credentials.userId===user.id,phoneMatches:user.phone?.replace(/^\+/,'')===input.credentials.phone.replace(/^\+/,''),testNickname:user.user_metadata?.nickname,profileNickname:found.rows[0]?.nickname,counts,nonDeploymentMedicineCount:Number(named.rows[0].n)});
        }
      }
      else {
        const user=login.data.user;
        const profile=await db.query('SELECT nickname FROM users WHERE id=$1',[user.id]);
        const tables=['medicine_items','visit_records','health_reminders','blood_pressure_records','sync_attachments'];
        const counts={};
        for(const table of tables) counts[table]=Number((await db.query('SELECT count(*) AS n FROM '+table+' WHERE user_id=$1',[user.id])).rows[0].n);
        record('previous-test-account',{ok:true,idMatches:input.credentials.userId===user.id,testNickname:user.user_metadata?.nickname,profileNickname:profile.rows[0]?.nickname,phoneSuffix:user.phone?.slice(-4),counts});
        await pub.auth.signOut({scope:'local'});
      }
    }
  } finally {await db.end();}
} catch (error) {record('preflight-error',{ok:false,type:error.name,code:error.code??error.cause?.code});process.exitCode=1;}
report.ok=!process.exitCode; report.finishedAt=new Date().toISOString();
console.log(JSON.stringify({report}));
`;
const codeRemote=String.raw`
import {readFileSync} from 'node:fs';
import {createClient} from '@supabase/supabase-js';
import {DEFAULT_USER_DICTIONARY} from './dist/modules/auth/default-user-dictionary.js';
import pg from 'pg';
const input=JSON.parse(readFileSync(0,'utf8'));
if(input.url!==process.env.SUPABASE_URL)throw new Error('PROJECT_MISMATCH');
const db=new pg.Client({connectionString:process.env.DATABASE_URL});
await db.connect();
try{
 const rows=await db.query("SELECT id FROM users WHERE replace(phone,'+','')=replace($1,'+','') AND status='active'",[input.credentials.phone]);
 if(rows.rowCount!==1)throw new Error('TEST_ACCOUNT_NOT_UNAMBIGUOUS');
 const userId=rows.rows[0].id;
 for(const table of ['medicine_items','visit_records','health_reminders','blood_pressure_records','sync_attachments']){
   const result=await db.query('SELECT count(*) AS n FROM '+table+' WHERE user_id=$1',[userId]);
   if(Number(result.rows[0].n)!==0)throw new Error('EXISTING_HEALTH_DATA_DO_NOT_DELETE');
 }
 const dictionary=await db.query('SELECT categories,efficacies,symptoms FROM user_dictionaries WHERE user_id=$1',[userId]);
 const defaultOnly=dictionary.rows.every(row=>Object.keys(DEFAULT_USER_DICTIONARY).every(key=>JSON.stringify(row[key])===JSON.stringify(DEFAULT_USER_DICTIONARY[key])));
 if(!defaultOnly)throw new Error('CUSTOM_TAGS_DO_NOT_DELETE');
 const admin=createClient(input.url,input.adminKey,{auth:{persistSession:false,autoRefreshToken:false}});
 const found=await admin.auth.admin.getUserById(userId);
 if(found.error||found.data.user.phone?.replace(/^\+/,'')!==input.credentials.phone.replace(/^\+/,''))throw new Error('IDENTITY_MISMATCH');
 const pub=createClient(input.url,process.env.SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(u,i)=>fetch(u,{...i,signal:AbortSignal.timeout(15000)})}});
 const sent=await pub.auth.signInWithOtp({phone:input.credentials.phone,options:{shouldCreateUser:false,channel:'sms'}});
 console.log(JSON.stringify({stage:'login-code',ok:!sent.error,code:sent.error?.code,healthDataEmpty:true,customTagsAbsent:true,phoneSuffix:input.credentials.phone.slice(-4)}));
 if(sent.error)process.exitCode=1;
 else console.log(JSON.stringify({privateState:{userId,phone:input.credentials.phone,requestedAt:new Date().toISOString()}}));
}catch(error){console.log(JSON.stringify({stage:'login-code',ok:false,reason:error.message}));process.exitCode=1;}
finally{await db.end();}
`;
const verifyRemote=String.raw`
import {readFileSync} from 'node:fs';
import {createClient} from '@supabase/supabase-js';
const input=JSON.parse(readFileSync(0,'utf8'));
if(input.url!==process.env.SUPABASE_URL)throw new Error('PROJECT_MISMATCH');
const pub=createClient(input.url,process.env.SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(u,i)=>fetch(u,{...i,signal:AbortSignal.timeout(15000)})}});
try{
 const verified=await pub.auth.verifyOtp({phone:input.state.phone,token:input.code,type:'sms'});
 if(verified.error||!verified.data.session){console.log(JSON.stringify({stage:'login-verify',ok:false,code:verified.error?.code}));process.exitCode=1;}
 else if(verified.data.user.id!==input.state.userId){await pub.auth.signOut({scope:'local'});throw new Error('IDENTITY_CHANGED_DO_NOT_DELETE');}
 else {
  const response=await fetch('https://api.uk-io.com/users/me',{headers:{authorization:'Bearer '+verified.data.session.access_token},signal:AbortSignal.timeout(20000)});
  const profile=await response.json();
  if(!response.ok||profile.id!==input.state.userId)throw new Error('BUSINESS_LOGIN_FAILED');
  console.log(JSON.stringify({stage:'real-sms-login',ok:true,businessStatus:response.status,phoneSuffix:input.state.phone.slice(-4)}));
  console.log(JSON.stringify({privateState:{...input.state,session:verified.data.session,profile}}));
 }
}catch(error){console.log(JSON.stringify({stage:'login-verify',ok:false,reason:error.message}));process.exitCode=1;}
`;
let credentials;
try { credentials=JSON.parse(readFileSync('/private/tmp/qfj-phone-test.json','utf8')); } catch {}
const payload={mode,url:process.env.SUPABASE_URL,adminKey:process.env.SUPABASE_SERVICE_ROLE_KEY,credentials};
if(mode==='login-verify'||mode==='relogin-code'){
 payload.state=JSON.parse(readFileSync('/private/tmp/qfj-account-deletion-live.json','utf8'));
 if(payload.state.accepted||payload.state.completed)throw new Error('Deletion already submitted; use account-deletion-exercise.mjs verify.');
}
if(mode==='login-verify'){
 payload.code=process.argv[3];
 if(!/^\d{6}$/.test(payload.code??''))throw new Error('Six-digit verification code required.');
}
if (!payload.url || !payload.adminKey) throw new Error('Local server configuration is missing.');
const args=['-i',process.env.MEDICINE_SSH_KEY??homedir()+'/.ssh/id_ed25519_vultr','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no','-o','ConnectTimeout=15',process.env.MEDICINE_SSH_TARGET??'root@139.180.212.148',
  'docker exec -i medicine-api node --input-type=module -e '+shellQuote(mode==='login-verify'?verifyRemote:mode==='relogin-code'?reloginRemote:mode==='login-code'?codeRemote:remote)];
const result=spawnSync('ssh',args,{input:JSON.stringify(payload),encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
const output=(result.stdout??'').replaceAll(payload.adminKey,'[REDACTED]');
let publicOutput='';
for(const line of output.split('\n').filter(Boolean)){
  let parsed;try{parsed=JSON.parse(line);}catch{throw new Error('Unexpected remote output; secrets withheld.');}
  if(parsed.privateState)writeFileSync('/private/tmp/qfj-account-deletion-live.json',JSON.stringify(parsed.privateState),{mode:0o600});
  else publicOutput+=line+'\n';
}
process.stdout.write(publicOutput);
writeFileSync('/private/tmp/account-deletion-live-'+mode+'.json',publicOutput,{mode:0o600});
if(result.error) console.error(JSON.stringify({stage:'ssh',ok:false,code:result.error.code}));
if(result.stderr) process.stderr.write(result.stderr.replaceAll(payload.adminKey,'[REDACTED]').slice(0,2000));
process.exitCode=result.status??1;
