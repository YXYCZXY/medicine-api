import test from 'node:test';
import assert from 'node:assert/strict';
import { reloginRemote } from './account-deletion-relogin.mjs';

async function run({stateOverrides={}, active=true, identity=true, smsError=null}={}) {
  const state={userId:'test-user',phone:'+861234565090',requestedAt:'2026-11-08T00:00:00Z',seed:{operationId:'keep-operation'},beforeOther:{users:'keep-hash'},seeded:false,...stateOverrides};
  const logs=[], sent=[], queries=[];
  let closed=false;
  const input={url:'https://test.invalid',adminKey:'test-secret',state};
  class Client {
    async connect() {}
    async query(sql,params) { queries.push({sql,params}); return {rowCount:active?1:0,rows:active?[{id:state.userId}]:[]}; }
    async end() { closed=true; }
  }
  const createClient=()=>({auth:{admin:{getUserById:async()=>({data:{user:{id:identity?state.userId:'different-user',phone:'861234565090'}}})},signInWithOtp:async args=>{sent.push(args);return {error:smsError};}}});
  const source=reloginRemote.replace(/^import .*;$/gm,'');
  const process={env:{SUPABASE_URL:input.url},exitCode:0};
  const execute=new Function('readFileSync','createClient','pg','process','console',`return (async()=>{${source}\n})();`);
  await execute(()=>JSON.stringify(input),createClient,{Client},process,{log:line=>logs.push(JSON.parse(line))});
  return {state,logs,sent,queries,closed,process};
}

test('relogin preserves fixture dates, operation IDs and other-account evidence',async()=>{
  const result=await run();
  assert.equal(result.process.exitCode,0);
  assert.deepEqual(result.sent,[{phone:result.state.phone,options:{shouldCreateUser:false,channel:'sms'}}]);
  const saved=result.logs.find(row=>row.privateState).privateState;
  const {loginCodeRequestedAt,...original}=saved;
  assert.ok(loginCodeRequestedAt);
  assert.deepEqual(original,result.state);
  assert.deepEqual(result.queries[0].params,[result.state.userId,result.state.phone]);
  assert.equal(result.closed,true);
});
for(const scenario of [{active:false},{identity:false},{smsError:{code:'over_sms_send_rate_limit'}}]) {
  test('failed identity or SMS never overwrites recovery state '+JSON.stringify(scenario),async()=>{
    const result=await run(scenario);
    assert.equal(result.process.exitCode,1);
    assert.equal(result.logs.some(row=>row.privateState),false);
    if(!scenario.smsError)assert.equal(result.sent.length,0);
    assert.equal(result.closed,true);
  });
}
for(const flag of ['accepted','completed']) {
  test('refuses relogin after deletion '+flag,async()=>{
    await assert.rejects(run({stateOverrides:{[flag]:true}}),/DELETION_ALREADY_SUBMITTED_USE_VERIFY/);
  });
}
