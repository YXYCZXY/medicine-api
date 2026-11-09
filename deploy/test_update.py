"""Exercise deployment failures with fake Docker/SSH; never contacts a server."""
import hashlib
import gzip
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parent
MOCK = r'''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
name=Path(sys.argv[0]).name
args=sys.argv[1:]
root=Path(os.environ['MEDICINE_DEPLOY_ROOT'])
with (root/'events').open('a') as log: log.write(json.dumps([name,*args])+'\n')
failure=os.environ.get('TEST_FAILURE','')
if name=='sha256sum':
    os.execvp('shasum',['shasum','-a','256',*args])
if name=='flock': sys.exit(1 if failure=='lock' else 0)
if name in ('nginx','ssh','scp'):
    if name=='ssh' and 'backup-path.txt' in args[-1]: print('fake downloaded backup')
    sys.exit(0)
if name=='curl':
    running=(root/'running').read_text().strip()
    if failure=='public' and running=='new' and 'https://' in args[-1]: sys.exit(22)
    if failure=='health' and running=='new': sys.exit(22)
    print('401' if '/users/me' in args[-1] else '{"status":"ok"}')
    sys.exit(0)
if name=='docker':
    if args[0]=='run' and failure=='environment': sys.exit(1)
    if args[0]=='save': print('fake docker archive')
    if args[:2]==['image','inspect']:
        if '--format' in args: print('linux/amd64')
    elif args[0]=='exec':
        if 'psql' in args: print((root/'db.json').read_text())
        elif 'pg_dump' in args:
            if failure=='backup': sys.exit(1)
            print('fake backup archive')
        elif 'pg_restore' in args: sys.stdin.read()
    elif args[0]=='compose':
        env=Path(args[args.index('--env-file')+1])
        release=env.read_text().strip().split('=',1)[1]
        if 'stop' in args: (root/'running').write_text('stopped')
        elif 'run' in args:
            if failure=='migration': sys.exit(1)
            manifest=json.loads((root/'releases'/release/'migrations.json').read_text())
            (root/'db.json').write_text(json.dumps([dict(name=k,checksum=v,completed=True,rolled_back=False) for k,v in manifest.items()]))
        elif 'up' in args:
            (root/'running').write_text(release)
            if failure=='start' and release=='new': sys.exit(1)
    sys.exit(0)
raise SystemExit('Unexpected mock command: '+name)
'''


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='medicine update ')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base/'server'
        self.package = self.root/'releases/new'
        self.package.mkdir(parents=True)
        self.bin = self.base/'bin'
        self.bin.mkdir()
        for name in ('docker', 'curl', 'nginx', 'flock', 'sha256sum', 'ssh', 'scp'):
            file = self.bin/name
            file.write_text(MOCK)
            file.chmod(0o700)
        self.environment = dict(os.environ, PATH=str(self.bin)+os.pathsep+os.environ['PATH'],
                                MEDICINE_DEPLOY_ROOT=str(self.root),
                                MEDICINE_BACKUP_DIR=str(self.base/'backups'))
        self.old_checksum = 'a'*64
        self.old_compose = 'original compose\n'
        self.secret = 'DATABASE_URL=postgresql://hidden-secret@localhost/medicine\nCUSTOM_SETTING=keep-me\n'
        (self.root/'compose.yaml').write_text(self.old_compose)
        (self.root/'release.env').write_text('RELEASE=old\n')
        (self.root/'api.env').write_text(self.secret)
        (self.root/'running').write_text('old')
        self.rows = [dict(name='0_init', checksum=self.old_checksum, completed=True, rolled_back=False)]
        self.write_database()
        for name in ('update-server.sh', 'server-lib.sh', 'migration-check.py', 'configure-sms.py', 'rollback.sh', 'compose.yaml'):
            shutil.copyfile(SOURCE/name, self.package/name)
        (self.package/'release.env').write_text('RELEASE=new\n')
        (self.package/'images.tar.gz').write_text('fake image')
        self.manifest = {'0_init': self.old_checksum}
        self.seal_package()

    def write_database(self):
        (self.root/'db.json').write_text(json.dumps(self.rows))

    def seal_package(self):
        (self.package/'migrations.json').write_text(json.dumps(self.manifest))
        files = [file for file in self.package.iterdir() if file.is_file() and file.name!='SHA256SUMS']
        (self.package/'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(file.read_bytes()).hexdigest()}  {file.name}\n' for file in files))

    def update(self, failure=''):
        return subprocess.run(['bash', str(self.package/'update-server.sh'), 'new'],
                              env=dict(self.environment, TEST_FAILURE=failure), capture_output=True, text=True)

    def events(self):
        file = self.root/'events'
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []

    def assert_old_healthy(self):
        self.assertEqual((self.root/'release.env').read_text(), 'RELEASE=old\n')
        self.assertEqual((self.root/'compose.yaml').read_text(), self.old_compose)
        self.assertEqual((self.root/'api.env').read_text(), self.secret)
        self.assertEqual((self.root/'running').read_text(), 'old')

    def test_success_preserves_secrets_and_previous_release(self):
        result = self.update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root/'release.env').read_text(), 'RELEASE=new\n')
        self.assertEqual((self.root/'previous-release.env').read_text(), 'RELEASE=old\n')
        self.assertEqual((self.root/'api.env').read_text(), self.secret)
        self.assertTrue((self.package/'.deployed').exists())
        self.assertEqual((self.root/'release-states/old/api.env').stat().st_mode & 0o777, 0o600)
        self.assertNotIn('hidden-secret', result.stdout+result.stderr)

    def test_start_failure_restores_config_and_old_image(self):
        self.assertNotEqual(self.update('start').returncode, 0)
        self.assert_old_healthy()
        self.assertFalse((self.package/'.deployed').exists())

    def test_invalid_candidate_environment_is_rejected_before_stopping(self):
        self.assertNotEqual(self.update('environment').returncode, 0)
        self.assert_old_healthy()
        self.assertFalse(any('stop' in event for event in self.events()))

    def test_public_verification_failure_restores_old_image(self):
        self.assertNotEqual(self.update('public').returncode, 0)
        self.assert_old_healthy()

    def test_backup_failure_restores_old_service_before_migrating(self):
        self.assertNotEqual(self.update('backup').returncode, 0)
        self.assert_old_healthy()
        self.assertFalse(any('run' in event and 'migrate' in event for event in self.events()))

    def test_new_schema_failure_stays_stopped_without_database_restore(self):
        self.manifest['20261107_new'] = 'b'*64
        self.seal_package()
        result = self.update('migration')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root/'running').read_text(), 'stopped')
        self.assertIn('no database restore was performed', result.stderr)
        self.assertTrue(all('--list' in event for event in self.events() if 'pg_restore' in event))

    def test_schema_success_then_failed_start_does_not_start_old_code(self):
        self.manifest['20261107_new'] = 'b'*64
        self.seal_package()
        self.assertNotEqual(self.update('start').returncode, 0)
        self.assertEqual((self.root/'running').read_text(), 'stopped')
        self.assertEqual(len(json.loads((self.root/'db.json').read_text())), 2)

    def test_changed_applied_migration_is_rejected_before_stopping(self):
        self.manifest['0_init'] = 'b'*64
        self.seal_package()
        self.assertNotEqual(self.update().returncode, 0)
        self.assert_old_healthy()
        self.assertFalse(any('stop' in event for event in self.events()))

    def test_unfinished_migration_is_rejected(self):
        self.rows[0]['completed'] = False
        self.write_database()
        self.assertNotEqual(self.update().returncode, 0)
        self.assert_old_healthy()

    def test_corrupt_package_is_rejected(self):
        (self.package/'images.tar.gz').write_text('corrupt')
        self.assertNotEqual(self.update().returncode, 0)
        self.assert_old_healthy()

    def test_concurrent_deployment_is_rejected(self):
        self.assertNotEqual(self.update('lock').returncode, 0)
        self.assert_old_healthy()

    def test_rollback_restores_saved_config_and_can_toggle_back(self):
        self.assertEqual(self.update().returncode, 0)
        result = subprocess.run(['bash', str(self.root/'rollback.sh')], env=self.environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_old_healthy()
        self.assertEqual((self.root/'previous-release.env').read_text(), 'RELEASE=new\n')

    def test_rollback_rejects_a_different_database_schema(self):
        self.manifest['20261107_new'] = 'b'*64
        self.seal_package()
        self.assertEqual(self.update().returncode, 0)
        result = subprocess.run(['bash', str(self.root/'rollback.sh')], env=self.environment, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root/'running').read_text(), 'new')

    def test_upload_only_uses_existing_artifacts_without_running_a_build(self):
        project = self.base/'local project'
        (project/'deploy/artifacts').mkdir(parents=True)
        shutil.copyfile(SOURCE/'update.sh', project/'deploy/update.sh')
        shutil.copytree(self.package, project/'deploy/artifacts/new')
        key = self.base/'test key'
        key.write_text('not a real SSH key')
        result = subprocess.run(['bash', str(project/'deploy/update.sh'), '--upload-only', 'new'],
                                env=dict(self.environment, MEDICINE_SSH_KEY=str(key)), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len([event for event in self.events() if event[0]=='ssh']), 4)
        self.assertEqual(len([event for event in self.events() if event[0]=='scp']), 1)
        self.assertFalse((project/'deploy/.update-lock').exists())
        backup = self.base/'.deployment-backups/medicine/pre-new.dump'
        self.assertEqual(backup.read_text(), 'fake downloaded backup\n')
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)

    def test_build_packages_helpers_migration_hashes_and_refuses_overwrite(self):
        project = self.base/'build project'
        (project/'deploy').mkdir(parents=True)
        for file in SOURCE.iterdir():
            if file.is_file(): shutil.copyfile(file, project/'deploy'/file.name)
        sql = project/'prisma/migrations/0_init/migration.sql'
        sql.parent.mkdir(parents=True)
        sql.write_text('SELECT 1;\n')
        (project/'.env.example').write_text('SUPABASE_URL=https://auth.example.test\nSUPABASE_PUBLISHABLE_KEY=public-test-key\nDATABASE_URL=never-package-this-secret\n')
        command = ['bash', str(project/'deploy/build.sh'), 'build-test']
        result = subprocess.run(command, env=self.environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        artifact = project/'deploy/artifacts/build-test'
        self.assertEqual(gzip.decompress((artifact/'images.tar.gz').read_bytes()), b'fake docker archive\n')
        self.assertEqual(json.loads((artifact/'migrations.json').read_text()), {'0_init': hashlib.sha256(sql.read_bytes()).hexdigest()})
        self.assertNotIn('never-package-this-secret', (artifact/'public.env').read_text())
        for line in (artifact/'SHA256SUMS').read_text().splitlines():
            checksum, name = line.split(None, 1)
            self.assertEqual(checksum, hashlib.sha256((artifact/name.strip()).read_bytes()).hexdigest())
        self.assertTrue((artifact/'update-server.sh').exists())
        previous_events = len(self.events())
        self.assertNotEqual(subprocess.run(command, env=self.environment, capture_output=True).returncode, 0)
        self.assertEqual(previous_events, len(self.events()))


if __name__ == '__main__':
    unittest.main()
