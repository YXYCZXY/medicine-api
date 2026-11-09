// Configure only the Supabase admin key on the existing backend, over SSH stdin.
import 'dotenv/config';
import {spawnSync} from 'node:child_process';
import {homedir} from 'node:os';
const adminKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!adminKey||adminKey.trim()!==adminKey||/[\r\n\0]/.test(adminKey))throw new Error('Invalid local admin key configuration');
const remote=String.raw`
import datetime, fcntl, json, os, tempfile
from pathlib import Path
root=Path('/opt/medicine-api')
lock=(root/'.deploy.lock').open('a')
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
data=json.load(__import__('sys').stdin)
target=root/'api.env'
original=target.read_bytes()
values=dict(line.split('=',1) for line in original.decode().splitlines() if '=' in line and not line.startswith('#'))
if values.get('SUPABASE_URL')!=data['url']:raise SystemExit('Project mismatch; nothing changed.')
key=data['adminKey']
if not key or key!=key.strip() or any(c in key for c in '\r\n\0'):raise SystemExit('Invalid key; nothing changed.')
if values.get('SUPABASE_SERVICE_ROLE_KEY')==key:
 print(json.dumps({'configured':True,'changed':False,'restartPerformed':False}));raise SystemExit(0)
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
backup=root/('api.env.before-account-deletion-'+stamp)
fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'wb') as stream:stream.write(original);stream.flush();os.fsync(stream.fileno())
lines=[line for line in original.decode().splitlines() if line.partition('=')[0].strip()!='SUPABASE_SERVICE_ROLE_KEY']
candidate='\n'.join(lines)+'\nSUPABASE_SERVICE_ROLE_KEY='+key+'\n'
fd,name=tempfile.mkstemp(prefix='.account-env-',dir=root)
try:
 with os.fdopen(fd,'w') as stream:stream.write(candidate);stream.flush();os.fsync(stream.fileno())
 os.replace(name,target);target.chmod(0o600)
finally:Path(name).unlink(missing_ok=True)
print(json.dumps({'configured':True,'changed':True,'permissions':'600','backup':str(backup),'restartPerformed':False}))
`;
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const result=spawnSync('ssh',['-i',process.env.MEDICINE_SSH_KEY??homedir()+'/.ssh/id_ed25519_vultr','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no','-o','ConnectTimeout=15',process.env.MEDICINE_SSH_TARGET??'root@139.180.212.148','python3 -c '+quote(remote)],{input:JSON.stringify({url:process.env.SUPABASE_URL,adminKey}),encoding:'utf8',timeout:30000});
process.stdout.write((result.stdout??'').replaceAll(adminKey,'[REDACTED]'));
if(result.stderr)process.stderr.write(result.stderr.replaceAll(adminKey,'[REDACTED]').slice(0,1000));
if(result.error)console.error(JSON.stringify({stage:'configure-ssh',code:result.error.code}));
process.exitCode=result.status??1;
