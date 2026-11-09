// Explicit live smoke test. Pending credentials stay in an owner-readable temp file.
// Run after creating a test signup; never put a real password or token in output.
import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
const statePath = '/private/tmp/qfj-phone-test.json';
const pending = JSON.parse(await readFile(statePath, 'utf8'));
const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession:false, autoRefreshToken:false, detectSessionInUrl:false },
  global: { fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(15000)}) },
});
function check(error, stage) {
  if (error) { console.log(JSON.stringify({stage,code:error.code,message:error.message}));process.exit(1); }
}
const [mode, code] = process.argv.slice(2);
if(mode === 'check') {
  const settingsResponse = await fetch(process.env.SUPABASE_URL + '/auth/v1/settings', { headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY } });
  const settings = await settingsResponse.json();
  const first = await client.auth.signInWithPassword({ phone:pending.phone, password:pending.password });check(first.error,'password-login');
  const secondClient=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const second=await secondClient.auth.signInWithPassword({phone:pending.phone,password:pending.password});check(second.error,'second-device-login');
  const ttl=first.data.session.expires_in;
  await client.auth.signOut({scope:'local'});
  const otherRefresh=await secondClient.auth.refreshSession();check(otherRefresh.error,'other-device-refresh');
  const response=await fetch((process.env.AUTH_SMOKE_API_URL??'http://127.0.0.1:3000')+'/users/me',{headers:{authorization:`Bearer ${otherRefresh.data.session.access_token}`}});
  console.log(JSON.stringify({stage:'project-settings-and-multidevice',expiresIn:ttl,emailEnabled:settings.external?.email,phoneEnabled:settings.external?.phone,phoneAutoConfirm:settings.phone_autoconfirm,otherDeviceSurvivedLocalLogout:!!otherRefresh.data.session,businessStatus:response.status}));
  await secondClient.auth.signOut({scope:'local'});
  if(ttl!==900 || settings.external?.email!==false || response.status!==200)process.exitCode=1;
} else if(mode === 'resend') {
  const {error} = await client.auth.resend({type:'sms',phone:pending.phone});check(error,'resend');
  pending.requestedAt = new Date().toISOString();await writeFile(statePath,JSON.stringify(pending),{mode:0o600});
  console.log(JSON.stringify({stage:'resend',ok:true,requestedAt:pending.requestedAt}));
} else if(mode === 'verify') {
  if(!/^\d{6}$/.test(code ?? ''))throw new Error('Six-digit OTP required');
  const verified=await client.auth.verifyOtp({phone:pending.phone,token:code,type:'sms'});check(verified.error,'verify');
  pending.verified=true;await writeFile(statePath,JSON.stringify(pending),{mode:0o600});
  const base=process.env.AUTH_SMOKE_API_URL ?? 'http://127.0.0.1:3000';
  const otpResponse=await fetch(base+'/users/me',{headers:{authorization:`Bearer ${verified.data.session.access_token}`}});
  console.log(JSON.stringify({stage:'otp-business-access',status:otpResponse.status,code:(await otpResponse.json()).code}));
  const revocation=await client.auth.signOut({scope:'local'});check(revocation.error,'revoke-otp');
  const signedIn=await client.auth.signInWithPassword({phone:pending.phone,password:pending.password});check(signedIn.error,'password-login');
  const headers={authorization:`Bearer ${signedIn.data.session.access_token}`};
  for(const path of ['/users/me','/user-dictionaries','/sync/snapshot?deviceId='+randomUUID()]) {
    const response=await fetch(base+path,{headers});const body=await response.json();
    console.log(JSON.stringify({stage:path.split('?')[0],status:response.status,code:body.code,
      userMatches:path==='/users/me'?body.id===signedIn.data.user.id:undefined,
      dictionaryReady:path==='/user-dictionaries'?Array.isArray(body.categories)&&Array.isArray(body.efficacies)&&Array.isArray(body.symptoms):undefined,protocolVersion:body.protocolVersion}));
    if(!response.ok)process.exitCode=1;
  }
  const refreshed=await client.auth.refreshSession();check(refreshed.error,'refresh');
  console.log(JSON.stringify({stage:'refresh',ok:!!refreshed.data.session,expiresIn:refreshed.data.session?.expires_in}));
  await client.auth.signOut({scope:'local'});
} else throw new Error('Use check, resend or verify <OTP>');
