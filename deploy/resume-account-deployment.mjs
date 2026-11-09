// Resume this undeployed release using rsync over the uncompressed OCI archive.
// Existing server layers are reused; the final complete package is SHA-256 checked.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream,openSync,closeSync,readFileSync,writeFileSync,renameSync,readdirSync,mkdirSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve,dirname} from 'node:path';
const release='20261108-account-management-b-01';
const previous='20261108T062701Z-5f8aa2c-458542';
const target='root@139.180.212.148';
const key=homedir()+'/.ssh/id_ed25519_vultr';
const sshOptions=['-i',key,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no','-o','ConnectTimeout=15','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3'];
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const artifacts=resolve('deploy/artifacts',release);
const raw='/private/tmp/account-upload-delta/current.tar';
if(!existsSync(raw)||!existsSync(artifacts+'/SHA256SUMS'))throw new Error('Prepared archive is required.');
function run(program,args,options={}){
 const result=spawnSync(program,args,{stdio:'inherit',timeout:240000,...options});
 if(result.error||result.status!==0)throw new Error(program+' failed with '+String(result.status??result.error?.code));
 return result;
}
function ssh(command,options={}){return run('ssh',[...sshOptions,target,command],options);}
async function digest(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
// Stop only this release's unfinished scp. The original update script exits before
// stopping services because it is still in its upload stage.
const processes=spawnSync('ps',['-axo','pid=,command='],{encoding:'utf8'});
if(processes.status!==0)throw new Error('Cannot inspect the active upload safely.');
let stopped=0;
for(const line of processes.stdout.split('\n')){
 const parsed=/^\s*(\d+)\s+(.*)$/.exec(line);
 if(parsed&&parsed[2].startsWith('scp ')&&parsed[2].includes('/releases/'+release+'/')){
  process.kill(Number(parsed[1]),'SIGTERM');stopped++;
 }
}
console.log(JSON.stringify({stage:'unfinished-upload-stopped',count:stopped}));
// GNU gzip from the exact same cached image on both hosts makes compression
// byte-for-byte deterministic. Source files and image manifests do not change.
const input=openSync(raw,'r'),output=openSync(artifacts+'/images.tar.gz.repacked','w',0o600);
try{run('docker',['run','--rm','-i','--network','none','--read-only','--entrypoint','gzip','medicine-api:'+previous,'-c'],{stdio:[input,output,'inherit']});}
finally{closeSync(input);closeSync(output);}
renameSync(artifacts+'/images.tar.gz.repacked',artifacts+'/images.tar.gz');
const imageHash=await digest(artifacts+'/images.tar.gz');
const checks=readFileSync(artifacts+'/SHA256SUMS','utf8').split('\n').map(line=>line.endsWith('  images.tar.gz')?imageHash+'  images.tar.gz':line).join('\n');
writeFileSync(artifacts+'/SHA256SUMS',checks);
run('shasum',['-a','256','--check','SHA256SUMS'],{cwd:artifacts});
const remote='/opt/medicine-api/releases/'+release;
const old='/opt/medicine-api/releases/'+previous;
ssh('set -eu; test -f '+quote(remote+'/.upload-in-progress')+'; test ! -e '+quote(remote+'/.deployed')+'; test "$(cat /opt/medicine-api/release.env)" = '+quote('RELEASE='+previous)+'; gzip -dc '+quote(old+'/images.tar.gz')+' > '+quote(remote+'/images.tar'));
run('rsync',['-ac','--no-whole-file','--stats','-e','ssh '+sshOptions.map(quote).join(' '),raw,target+':'+remote+'/images.tar']);
ssh('set -eu; docker run --rm -i --network none --read-only --entrypoint gzip '+quote('medicine-api:'+previous)+' -c < '+quote(remote+'/images.tar')+' > '+quote(remote+'/images.tar.gz')+'; printf "%s  %s\\n" '+quote(imageHash)+' '+quote(remote+'/images.tar.gz')+' | sha256sum --check -');
const small=readdirSync(artifacts).filter(name=>name!=='images.tar.gz').map(name=>artifacts+'/'+name);
run('scp',[...sshOptions,...small,target+':'+remote+'/']);
ssh('cd '+quote(remote)+' && sha256sum --check SHA256SUMS');
console.log(JSON.stringify({stage:'complete-release-package-verified',release,imageHash}));
ssh('bash '+quote(remote+'/update-server.sh')+' '+quote(release));
const backupRead=ssh('cat '+quote(remote+'/backup-path.txt'),{encoding:'utf8',stdio:['ignore','pipe','inherit']});
const backup=backupRead.stdout.trim();
if(!backup.startsWith('/var/backups/medicine-deploy/pre-'+release+'-')||!backup.endsWith('.dump'))throw new Error('Unexpected backup path');
const destination=resolve('../.deployment-backups/medicine/pre-'+release+'.dump');
mkdirSync(dirname(destination),{recursive:true,mode:0o700});
const fd=openSync(destination+'.partial','w',0o600);
try{ssh('cat '+quote(backup),{stdio:['ignore',fd,'inherit']});}finally{closeSync(fd);}
renameSync(destination+'.partial',destination);
console.log(JSON.stringify({stage:'deployment-complete',release,api:'https://api.uk-io.com',backup:destination}));
