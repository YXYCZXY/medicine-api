// Explicit live test on the user-selected EMPTY account. Never selects other users.
import 'dotenv/config';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {randomBytes,randomUUID} from 'node:crypto';
const mode=process.argv[2];
if(!['seed','deletion-code','delete','verify'].includes(mode))throw new Error('Unsupported exercise mode');
const statePath='/private/tmp/qfj-account-deletion-live.json';
const state=JSON.parse(readFileSync(statePath,'utf8'));
if(!state.session||state.userId!==state.session.user.id)throw new Error('Verified test identity required');
if(!state.seed){state.seed={};for(const name of ['medicine','removedMedicine','visit','visitMedicine','reminder','bpReminder','attachment','device','opMedicine','opRemoved','opDelete','opVisit','opReminder','operationId'])state.seed[name]=randomUUID();state.seed.receiptSecret=randomBytes(32).toString('hex');writeFileSync(statePath,JSON.stringify(state),{mode:0o600});}
const remote=String.raw`
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createClient} from '@supabase/supabase-js';
import pg from 'pg';
const input=JSON.parse(readFileSync(0,'utf8'));
const state=input.state,seed=state.seed,userId=state.userId;
if(userId!==state.session.user.id||input.url!==process.env.SUPABASE_URL)throw new Error('IDENTITY_MISMATCH');
const base='https://api.uk-io.com';let token=state.session.access_token;
const report={mode:input.mode,startedAt:new Date().toISOString(),checks:[]};
function pass(stage,details={}){const check={stage,ok:true,...details};report.checks.push(check);console.log(JSON.stringify(check));}
async function request(path,{method='GET',body,expected=200,credential=token}={}){
 const r=await fetch(base+path,{method,headers:{authorization:'Bearer '+credential,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
 const data=r.status===204?null:await r.json();
 if(r.status!==expected)throw new Error(method+' '+path+' HTTP '+r.status+' '+String(data?.code??''));
 return data;
}
const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
const ownership={users:'t.id',user_dictionaries:'t.user_id',medicine_items:'t.user_id',visit_records:'t.user_id',health_reminders:'t.user_id',blood_pressure_records:'t.user_id',sync_attachments:'t.user_id',sync_tombstones:'t.user_id',sync_command_receipts:'t.user_id',sync_reminder_revisions:'t.user_id',
 visit_medicines:'(SELECT v.user_id FROM visit_records v WHERE v.id=t.visit_id)',health_reminder_medicines:'(SELECT r.user_id FROM health_reminders r WHERE r.id=t.reminder_id)',health_reminder_checkins:'(SELECT r.user_id FROM health_reminders r WHERE r.id=t.reminder_id)',medicine_expiry_states:'(SELECT m.user_id FROM medicine_items m WHERE m.id=t.medicine_id)'};
async function fingerprints(other){const result={};for(const [table,owner]of Object.entries(ownership)){const r=await db.query('SELECT count(*)::int AS count,md5(coalesce(string_agg(row_to_json(t)::text,chr(10) ORDER BY row_to_json(t)::text),\'\')) AS digest FROM '+table+' t WHERE '+owner+(other?'<>':'=')+'$1::uuid',[userId]);result[table]=r.rows[0];}return result;}
try{
 if(input.mode!=='verify'){
  const auth=createClient(input.url,process.env.SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(u,i)=>fetch(u,{...i,signal:AbortSignal.timeout(15000)})}});
  const restored=await auth.auth.setSession({access_token:state.session.access_token,refresh_token:state.session.refresh_token});
  if(restored.error||!restored.data.session)throw new Error('TEST_SESSION_REFRESH_FAILED '+String(restored.error?.code));
  assert.equal(restored.data.session.user.id,userId);state.session=restored.data.session;token=state.session.access_token;
 }
 if(input.mode==='seed'){
  const profile=await request('/users/me');assert.equal(profile.id,userId);
  if(!state.beforeOther)state.beforeOther=await fingerprints(true);
  const existing=await request('/medicines');
  assert.ok(existing.every(row=>[seed.medicine,seed.removedMedicine].includes(row.id)),'Daily data appeared; stop testing');
  await request('/users/me',{method:'PATCH',body:{nickname:'删除联调专用账号'}});pass('nickname-real-update');
  const content='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
  await request('/sync/attachments',{method:'POST',expected:201,body:{id:seed.attachment,base64:content}});pass('real-attachment-upload');
  let sequence=0;
  const command=(id,entity_id,type,payload,depends=[],base_version=null)=>({id,user_id:userId,device_id:seed.device,entity_id,type,schema_version:2,payload:JSON.stringify(payload),base_version,base_op_id:null,depends_on:JSON.stringify(depends),client_occurred_at:state.requestedAt,sequence:++sequence});
  const med={name:'[删除联调] 临时药品',category:'其他药品',quantity:2,unit:'片',expirationDate:'2027-01-01'};
  const commands=[
   command(seed.opMedicine,seed.medicine,'medicine.create',med),
   command(seed.opRemoved,seed.removedMedicine,'medicine.create',{...med,name:'[删除联调] 删除标记样本'}),
   command(seed.opVisit,seed.visit,'visit.create',{visitDate:'2026-11-08',initialVisitId:null,hospitalName:'[删除联调] 测试记录',symptomTags:['其他'],photos:[{id:seed.attachment}],medicines:[{id:seed.visitMedicine,medicineId:seed.medicine,name:med.name,unit:'片'}]},[seed.opMedicine]),
   command(seed.opReminder,seed.reminder,'reminder.create',{type:'med',title:'[删除联调] 提醒',frequency:'daily',time:'08:00',medicine:{medicineId:seed.medicine,name:med.name,unit:'片'}},[seed.opMedicine]),
   command(seed.opDelete,seed.removedMedicine,'medicine.delete',{},[seed.opRemoved],1),
  ];
  const sync=await request('/sync/commands',{method:'POST',expected:201,body:{commands}});
  for(const result of sync.results)assert.equal(result.status,'accepted','Fixture command rejected: '+JSON.stringify(result));
  const replay=await request('/sync/commands',{method:'POST',expected:201,body:{commands}});assert.ok(replay.results.every(row=>row.status==='accepted'));pass('real-sync-five-commands-and-replay');
  let bp=await db.query('SELECT id FROM health_reminders WHERE id=$1',[seed.bpReminder]);
  if(!bp.rowCount)await request('/reminders',{method:'POST',expected:201,body:{id:seed.bpReminder,type:'daily',title:'[删除联调] 测量',frequency:'daily',time:'08:00',recordBloodPressure:true}});
  const today='2026-11-08';
  const checked=await db.query('SELECT id FROM health_reminder_checkins WHERE reminder_id=$1',[seed.bpReminder]);
  if(!checked.rowCount)await request('/reminders/'+seed.bpReminder+'/checkins/'+today,{method:'PATCH',body:{expectedReminderVersion:1,expectedVersion:0,completed:true,bloodPressure:{systolic:120,diastolic:80,pulse:70,slot:'morning',measuredAt:'2026-11-08T01:00:00.000Z'}}});
  const expiry=await db.query('SELECT medicine_id FROM medicine_expiry_states WHERE medicine_id=$1',[seed.medicine]);
  if(!expiry.rowCount){
   await request('/medicines/'+seed.medicine,{method:'PATCH',body:{expirationDate:'2026-11-10'}});
   await request('/reminders/expiry/'+seed.medicine,{method:'PATCH',body:{expirationDate:'2026-11-10',expectedVersion:0,status:'handled'}});
  }
  await request('/user-dictionaries/categories',{method:'POST',expected:201,body:{values:['删除联调标签']}});
  pass('real-reminders-checkin-blood-pressure-expiry-and-tags');
  state.beforeTarget=await fingerprints(false);state.seeded=true;
  pass('live-business-fixture-coverage',{tables:Object.fromEntries(Object.entries(state.beforeTarget).map(([name,row])=>[name,row.count]))});
 }else if(input.mode==='deletion-code'){
  assert.equal(state.seeded,true,'Only the seeded disposable account may request deletion');
  const response=await request('/users/me/deletion-code',{method:'POST'});assert.equal(response.retryAfterSeconds,60);
  await request('/users/me/deletion-code',{method:'POST',expected:429});
  const tasks=await db.query('SELECT count(*) AS n FROM account_deletion_tasks WHERE user_id=$1',[userId]);assert.equal(Number(tasks.rows[0].n),0);
  pass('real-deletion-sms-sent-and-cooldown-enforced');
 }else if(input.mode==='delete'){
  assert.equal(state.seeded,true,'Account must have been verified disposable and seeded');
  assert.ok(/^\d{6}$/.test(input.code),'Six-digit OTP required');
  const existing=await request('/medicines');assert.ok(existing.every(row=>row.id===seed.medicine),'Unexpected daily medicine data; deletion refused');
  const body={operationId:seed.operationId,receiptSecret:seed.receiptSecret,code:input.code,confirmation:'DELETE_ALL_DATA'};
  const wrongCode=String((Number(input.code[0])+1)%10)+input.code.slice(1);
  await request('/users/me',{method:'DELETE',expected:400,body:{...body,code:wrongCode}});
  const notStarted=await db.query('SELECT count(*) AS n FROM account_deletion_tasks WHERE user_id=$1',[userId]);assert.equal(Number(notStarted.rows[0].n),0);
  const intact=await db.query("SELECT status FROM users WHERE id=$1",[userId]);assert.equal(intact.rows[0]?.status,'active');pass('real-wrong-otp-rejected-without-deleting');
  await request('/users/me',{method:'DELETE',expected:202,body});state.accepted=true;pass('real-deletion-accepted-202');
  const denied=await fetch(base+'/medicines',{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});assert.equal(denied.status,403);pass('old-session-business-access-denied');
  const late=await fetch(base+'/sync/attachments',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({id:seed.attachment,base64:'YQ=='}),signal:AbortSignal.timeout(20000)});assert.equal(late.status,403);pass('old-session-late-attachment-denied');
 }
 if(input.mode==='delete'||input.mode==='verify'){
  let receipt;
  for(let i=0;i<45;i++){
   receipt=await request('/account-deletions/'+seed.operationId,{credential:seed.receiptSecret});
   if(receipt.status==='completed')break;
   await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.equal(receipt.status,'completed','Worker has not completed; preserve recovery state');pass('real-deletion-task-completed');
  const remaining=await fingerprints(false);assert.ok(Object.values(remaining).every(row=>row.count===0));
  const other=await fingerprints(true);assert.deepEqual(other,state.beforeOther);pass('all-fourteen-business-and-related-tables-erased-other-accounts-identical');
  const tasks=await db.query('SELECT count(*) AS n FROM account_deletion_tasks WHERE user_id=$1',[userId]);assert.equal(Number(tasks.rows[0].n),0);
  const challenge=await db.query('SELECT count(*) AS n FROM account_deletion_challenges WHERE user_id=$1',[userId]);assert.equal(Number(challenge.rows[0].n),0);pass('temporary-account-task-and-challenge-erased');
  const admin=createClient(input.url,input.adminKey,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(u,i)=>fetch(u,{...i,signal:AbortSignal.timeout(15000)})}});
  const identity=await admin.auth.admin.getUserById(userId);assert.ok(identity.error?.status===404||identity.error?.code==='user_not_found');pass('real-supabase-auth-hard-delete-confirmed');
  const remoteStatus=await request('/users/me/deletion-status');assert.equal(remoteStatus.status,'deleted');pass('other-device-deletion-status-confirmed');
  await request('/account-deletions/'+seed.operationId,{credential:'f'.repeat(64),expected:404});pass('wrong-task-capability-rejected');state.completed=true;
 }
}catch(error){console.log(JSON.stringify({stage:'live-exercise',ok:false,message:error.message}));process.exitCode=1;}
finally{await db.end();console.log(JSON.stringify({privateState:state}));report.ok=!process.exitCode;report.finishedAt=new Date().toISOString();console.log(JSON.stringify({report}));}
`;
const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
const payload={mode,state,url:process.env.SUPABASE_URL,adminKey:key,code:process.argv[3]};
if(mode==='delete'&&!/^\d{6}$/.test(payload.code??''))throw new Error('Six-digit deletion OTP required');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const result=spawnSync('ssh',['-i',process.env.MEDICINE_SSH_KEY??homedir()+'/.ssh/id_ed25519_vultr','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no','-o','ConnectTimeout=15',process.env.MEDICINE_SSH_TARGET??'root@139.180.212.148','docker exec -i medicine-api node --input-type=module -e '+quote(remote)],{input:JSON.stringify(payload),encoding:'utf8',timeout:180000,maxBuffer:1024*1024});
let safe='';
for(const line of (result.stdout??'').split('\n').filter(Boolean)){
 let parsed;try{parsed=JSON.parse(line);}catch{throw new Error('Unexpected remote output; withheld.');}
 if(parsed.privateState)writeFileSync(statePath,JSON.stringify(parsed.privateState),{mode:0o600});
 else safe+=line+'\n';
}
process.stdout.write(safe);
writeFileSync('/private/tmp/account-deletion-exercise-'+mode+'.json',safe,{mode:0o600});
if(result.error)console.error(JSON.stringify({stage:'ssh',code:result.error.code}));
if(result.stderr)process.stderr.write(result.stderr.replaceAll(key,'[REDACTED]').slice(0,2000));
process.exitCode=result.status??1;
