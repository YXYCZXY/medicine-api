import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, customFetch, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { randomUUID } from 'node:crypto';
import { SupabaseJwtVerifier, SupabaseIdentityService, createProjectJwks } from './supabase-auth.js';

const config = new ConfigService({ SUPABASE_URL:'https://auth.example.test', SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test' });
async function setup() {
  const first=await generateKeyPair('ES256'),second=await generateKeyPair('ES256');
  const a={...await exportJWK(first.publicKey),kid:'a',alg:'ES256',use:'sig'};
  const b={...await exportJWK(second.publicKey),kid:'b',alg:'ES256',use:'sig'};
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({keys:[a]}),{status:200}));
  const jwks=createRemoteJWKSet(new URL('https://auth.example.test/auth/v1/.well-known/jwks.json'),{cooldownDuration:0,[customFetch]:fetcher});
  const verifier=new SupabaseJwtVerifier(config,jwks);
  const sign=(key:typeof first.privateKey,kid:string,claims:JWTPayload={})=>new SignJWT({
    role:'authenticated',is_anonymous:false,phone:'8613800000001',session_id:randomUUID(),amr:['password'],...claims,
  }).setProtectedHeader({alg:'ES256',kid}).setSubject(randomUUID()).setIssuer('https://auth.example.test/auth/v1').setAudience('authenticated').setIssuedAt().setExpirationTime('15m').sign(key);
  return {first,second,a,b,fetcher,jwks,verifier,sign};
}
describe('JWKS transport and rotation',()=>{
  it.each([['otp'],[{method:'otp'}],[{method:'otp'},{method:'token_refresh'}],['password']].map(amr=>({amr})))('accepts supported methods $amr',async ({amr})=>{
    const t=await setup();
    await expect(t.verifier.verify(await t.sign(t.first.privateKey,'a',{amr}))).resolves.toHaveProperty('userId');
  });
  it.each([[],['token_refresh'],[{method:'recovery'}],['oauth'],[null,42,{method:123}],null].map(amr=>({amr})))('rejects unsupported methods $amr',async ({amr})=>{
    const t=await setup();
    await expect(t.verifier.verify(await t.sign(t.first.privateKey,'a',{amr}))).rejects.toMatchObject({status:403,response:{code:'AUTH_METHOD_UNSUPPORTED'}});
  });
  it('caches known keys and refreshes on a new kid without accepting an unknown key',async()=>{
    const t=await setup();
    await t.verifier.verify(await t.sign(t.first.privateKey,'a'));
    await t.verifier.verify(await t.sign(t.first.privateKey,'a'));
    expect(t.fetcher).toHaveBeenCalledTimes(1);
    t.fetcher.mockImplementation(async () => new Response(JSON.stringify({keys:[t.a,t.b]})));
    await t.verifier.verify(await t.sign(t.second.privateKey,'b'));
    expect(t.fetcher).toHaveBeenCalledTimes(2);
    await expect(t.verifier.verify(await t.sign(t.second.privateKey,'unknown'))).rejects.toMatchObject({status:401});
  });
  it.each(['http','json','network'])('maps JWKS %s failures to 503, not logout',async mode=>{
    const t=await setup();
    if(mode==='http')t.fetcher.mockResolvedValue(new Response('unavailable',{status:503}));
    if(mode==='json')t.fetcher.mockResolvedValue(new Response('bad json'));
    if(mode==='network')t.fetcher.mockRejectedValue(new TypeError('network'));
    await expect(t.verifier.verify(await t.sign(t.first.privateKey,'a'))).rejects.toMatchObject({status:503});
  });
  it('derives only the configured project endpoint',()=>{
    expect(createProjectJwks(config)).toBeTypeOf('function');
  });
});
describe('trusted phone bootstrap',()=>{
  const originalFetch=global.fetch;
  afterEach(()=>{global.fetch=originalFetch;});
  const identity={userId:'00000000-0000-4000-8000-000000000001',sessionId:randomUUID(),phone:'+8613800000001'};
  it.each([null,'bad-date'])('rejects absent/invalid phone confirmation %s',async confirmed=>{
    global.fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id:identity.userId,phone:'8613800000001',phone_confirmed_at:confirmed,user_metadata:{nickname:'A'},
    })));
    await expect(new SupabaseIdentityService(config).getVerifiedUser('token',identity)).rejects.toMatchObject({status:403});
  });
  it('uses Auth phone and confirmation, trims only display metadata',async()=>{
    global.fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id:identity.userId,phone:'8613800000001',phone_confirmed_at:'2026-11-01T00:00:00Z',user_metadata:{nickname:' A ',phone:'+8613900000000'},
    })));
    expect(await new SupabaseIdentityService(config).getVerifiedUser('token',identity)).toMatchObject({phone:identity.phone,nickname:'A'});
  });
  it('Auth server outage is temporary and cannot initialize a business identity',async()=>{
    global.fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({message:'unavailable'}),{status:503}));
    await expect(new SupabaseIdentityService(config).getVerifiedUser('token',identity)).rejects.toMatchObject({status:503});
  },15000);
});
