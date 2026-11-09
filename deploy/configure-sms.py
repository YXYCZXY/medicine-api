#!/usr/bin/env python3
"""Run interactively on the server; values never appear in shell history or output."""
import datetime
import getpass
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path('/opt/medicine-api')
NAMES = (
    'SEND_SMS_HOOK_SECRET', 'ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET',
    'ALIYUN_SMS_SIGN_NAME', 'ALIYUN_SMS_TEMPLATE_CODE',
)


def main():
    if os.geteuid() != 0 or not sys.stdin.isatty():
        raise SystemExit('Run as root in an interactive SSH terminal.')
    # Share the deployment lock; do not race a release or rollback.
    import fcntl
    lock = (ROOT / '.deploy.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    release = (ROOT / 'release.env').read_text().strip()
    if not re.fullmatch(r'RELEASE=[A-Za-z0-9][A-Za-z0-9_.-]+', release):
        raise SystemExit('Unexpected release.env; no configuration changed.')
    image = 'medicine-api:' + release.split('=', 1)[1]
    values = {}
    print('Enter existing Supabase Hook Secret and Aliyun values. Input is hidden.')
    for name in NAMES:
        value = getpass.getpass(name + ': ')
        if not value or value != value.strip() or any(c in value for c in '\r\n\0'):
            raise SystemExit('Invalid input; no configuration changed.')
        values[name] = value
    target = ROOT / 'api.env'
    original = target.read_bytes()
    keep = [line for line in original.decode().splitlines()
            if line.partition('=')[0].strip() not in {*NAMES, 'SMS_HOOK_ENABLED'}]
    candidate = '\n'.join(keep) + '\nSMS_HOOK_ENABLED=true\n'
    candidate += ''.join(f'{name}={values[name]}\n' for name in NAMES)
    fd, temporary = tempfile.mkstemp(prefix='.sms-env-', dir=ROOT)
    temporary = Path(temporary)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(candidate)
            stream.flush()
            os.fsync(stream.fileno())
        # Validation runs with networking disabled and cannot send SMS.
        subprocess.run([
            'docker', 'run', '--rm', '--network', 'none', '--env-file', str(temporary),
            '--entrypoint', 'node', image, '--input-type=module', '-e',
            'import {validateEnv} from "./dist/config/env.validation.js"; validateEnv(process.env);',
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        backup = ROOT / ('api.env.before-sms-' + stamp)
        backup_fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(backup_fd, 'wb') as stream:
            stream.write(original)
        os.replace(temporary, target)
        target.chmod(0o600)
        command = ['docker', 'compose', '--env-file', 'release.env', 'up', '-d',
                   '--force-recreate', '--wait', '--wait-timeout', '120', 'api']
        try:
            subprocess.run(command, cwd=ROOT, check=True)
        except subprocess.CalledProcessError:
            # Restore configuration, then recreate the prior healthy configuration.
            restore_fd, restore_name = tempfile.mkstemp(prefix='.sms-restore-', dir=ROOT)
            with os.fdopen(restore_fd, 'wb') as stream:
                stream.write(original)
            os.replace(restore_name, target)
            subprocess.run(command, cwd=ROOT, check=True)
            raise SystemExit('SMS activation failed; previous configuration restored.')
        print('SMS configuration validated and activated. Values hidden.')
        print('Previous environment: ' + str(backup))
        print('Hook endpoint: https://api.uk-io.com/hooks/supabase/send-sms')
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        main()
    except (EOFError, KeyboardInterrupt):
        raise SystemExit('\nCancelled; do not paste secrets into chat.')
    except subprocess.CalledProcessError:
        raise SystemExit('Validation or activation failed. Secret values are not printed.')
