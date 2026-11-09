// Runs inside the existing API container. Never resets fixture/recovery state.
export const reloginRemote = String.raw`
import {readFileSync} from 'node:fs';
import {createClient} from '@supabase/supabase-js';
import pg from 'pg';
const input=JSON.parse(readFileSync(0,'utf8'));
if(input.url!==process.env.SUPABASE_URL)throw new Error('PROJECT_MISMATCH');
const state=input.state;
if(!state?.userId||!/^\+?\d{6,15}$/.test(state.phone??''))throw new Error('EXISTING_TEST_STATE_REQUIRED');
if(state.accepted||state.completed)throw new Error('DELETION_ALREADY_SUBMITTED_USE_VERIFY');
const db=new pg.Client({connectionString:process.env.DATABASE_URL});
await db.connect();
try{
 const rows=await db.query("SELECT id FROM users WHERE id=$1 AND replace(phone,'+','')=replace($2,'+','') AND status='active'",[state.userId,state.phone]);
 if(rows.rowCount!==1)throw new Error('TEST_ACCOUNT_NOT_ACTIVE_OR_IDENTITY_CHANGED');
 const options={auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(u,i)=>fetch(u,{...i,signal:AbortSignal.timeout(15000)})}};
 const admin=createClient(input.url,input.adminKey,options);
 const found=await admin.auth.admin.getUserById(state.userId);
 if(found.error||found.data.user.id!==state.userId||found.data.user.phone?.replace(/^\+/,'')!==state.phone.replace(/^\+/,''))throw new Error('IDENTITY_CHANGED_DO_NOT_DELETE');
 const pub=createClient(input.url,process.env.SUPABASE_PUBLISHABLE_KEY,options);
 const sent=await pub.auth.signInWithOtp({phone:state.phone,options:{shouldCreateUser:false,channel:'sms'}});
 console.log(JSON.stringify({stage:'relogin-code',ok:!sent.error,code:sent.error?.code,phoneSuffix:state.phone.slice(-4),progressPreserved:true}));
 if(sent.error)process.exitCode=1;
 else console.log(JSON.stringify({privateState:{...state,loginCodeRequestedAt:new Date().toISOString()}}));
}catch(error){console.log(JSON.stringify({stage:'relogin-code',ok:false,reason:error.message}));process.exitCode=1;}
finally{await db.end();}
`;
