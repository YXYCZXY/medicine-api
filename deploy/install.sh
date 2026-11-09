#!/usr/bin/env bash
set -euo pipefail
umask 077
release=${1:?Pass a release tag}
[[ "$release" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]+$ ]] || exit 1
root=/opt/medicine-api
cd "$root/releases/$release"
sha256sum --check SHA256SUMS
test -f /opt/medicine-db/.env
test -f /etc/nginx/cloudflare-ssl/ssl.pem
test -f /etc/nginx/cloudflare-ssl/ssl.key
if ss -lnt | awk '{print $4}' | grep -qE '(^|:)3100$'; then
  docker inspect medicine-api >/dev/null 2>&1 || { echo 'Port 3100 is occupied by another service' >&2; exit 1; }
fi

backup_dir=/var/backups/medicine-deploy
install -d -m 700 "$backup_dir"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
tar -C / -czf "$backup_dir/nginx-$stamp.tar.gz" etc/nginx
docker exec medicine-api-postgres pg_dump -U postgres -d medicine -Fc > "$backup_dir/pre-$release-$stamp.dump"
docker exec -i medicine-api-postgres pg_restore --list < "$backup_dir/pre-$release-$stamp.dump" >/dev/null
docker load -i images.tar.gz

export MEDICINE_RELEASE_DIR="$PWD"
python3 - <<'PY'
from pathlib import Path
from urllib.parse import urlsplit
import os

def values(path):
    result={}
    for line in Path(path).read_text().splitlines():
        key, sep, value = line.partition('=')
        if sep and not key.lstrip().startswith('#'):
            result[key.strip()]=value.strip().strip('"').strip("'")
    return result

database=values('/opt/medicine-db/.env').get('DATABASE_URL', '')
parsed=urlsplit(database)
if parsed.scheme not in ('postgresql','postgres') or parsed.hostname not in ('127.0.0.1','localhost') or parsed.path!='/medicine':
    raise SystemExit('Unexpected database configuration; refusing deployment')
public=values(Path(os.environ['MEDICINE_RELEASE_DIR'])/'public.env')
settings={
    'DATABASE_URL':database,
    'SUPABASE_URL':public['SUPABASE_URL'],
    'SUPABASE_PUBLISHABLE_KEY':public['SUPABASE_PUBLISHABLE_KEY'],
    'CORS_ORIGINS':'https://uk-io.com,https://api.uk-io.com',
}
if any('\n' in v or '\r' in v for v in settings.values()):
    raise SystemExit('Invalid environment configuration')
target=Path('/opt/medicine-api/api.env')
if target.exists():
    previous=target.with_name('api.env.previous')
    previous.write_bytes(target.read_bytes())
    previous.chmod(0o600)
target.write_text(''.join(f'{k}={v}\n' for k,v in settings.items()))
target.chmod(0o600)
print('Runtime environment prepared (values redacted).')
PY

if test -f "$root/release.env"; then
    cp "$root/release.env" "$root/previous-release.env"
fi
install -m 600 compose.yaml "$root/compose.yaml"
install -m 600 release.env "$root/candidate.env"
install -m 700 backup.sh "$root/backup.sh"
install -m 700 rollback.sh "$root/rollback.sh"
install -m 600 server-lib.sh "$root/server-lib.sh"
install -m 600 migration-check.py "$root/migration-check.py"
install -m 600 configure-sms.py "$root/configure-sms.py"
cd "$root"
docker compose --env-file candidate.env --profile tools run --rm -T migrate
docker compose --env-file candidate.env up -d --wait --wait-timeout 120 api
curl -fsS --max-time 8 http://127.0.0.1:3100/health
printf '\n'

install -m 644 "$root/releases/$release/nginx.conf" /etc/nginx/sites-available/medicine-api.conf
ln -sfn /etc/nginx/sites-available/medicine-api.conf /etc/nginx/sites-enabled/medicine-api.conf
nginx -t
systemctl reload nginx
install -m 600 candidate.env release.env
install -m 644 "$root/releases/$release/medicine-api-backup.service" /etc/systemd/system/medicine-api-backup.service
install -m 644 "$root/releases/$release/medicine-api-backup.timer" /etc/systemd/system/medicine-api-backup.timer
systemctl daemon-reload
systemctl enable --now medicine-api-backup.timer
systemctl start medicine-api-backup.service
printf 'Deployment complete: %s\n' "$release"
