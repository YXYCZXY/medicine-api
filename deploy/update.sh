#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
usage() {
    cat <<'HELP'
Usage: bash deploy/update.sh [--release VERSION | --upload-only VERSION | --rollback [VERSION]]
  No arguments: check, build a unique version, upload, back up, migrate and update.
  --upload-only VERSION: upload a previously completed local release without rebuilding.
  --rollback [VERSION]: restore a previous compatible release and its saved config.
Environment: MEDICINE_SSH_TARGET, MEDICINE_SSH_KEY (optional overrides).
HELP
}
mode=update
release=''
case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  --release|--upload-only) test "$#" = 2 || { usage; exit 1; }; mode=${1#--}; release=$2 ;;
  --rollback) test "$#" -le 2 || { usage; exit 1; }; mode=rollback; release=${2:-} ;;
  '') ;;
  *) usage; exit 1 ;;
esac
if test -n "$release"; then
    [[ "$release" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]+$ ]] || { echo 'Invalid release tag' >&2; exit 1; }
fi
target=${MEDICINE_SSH_TARGET:-root@139.180.212.148}
key=${MEDICINE_SSH_KEY:-$HOME/.ssh/id_ed25519_vultr}
[[ "$target" =~ ^[a-zA-Z0-9_.@:-]+$ ]] || { echo 'Invalid SSH target' >&2; exit 1; }
test -r "$key" || { echo "SSH key not found: $key" >&2; exit 1; }
ssh_options=(-i "$key" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
for binary in ssh scp python3; do command -v "$binary" >/dev/null; done
lock=deploy/.update-lock
mkdir "$lock" 2>/dev/null || { echo 'Another update may be running. Check deploy/.update-lock before retrying.' >&2; exit 1; }
printf '%s\n' "$$" > "$lock/pid"
trap 'rm -f "$lock/pid"; rmdir "$lock"' EXIT
if test "$mode" = rollback; then
    ssh "${ssh_options[@]}" "$target" "bash /opt/medicine-api/rollback.sh $release"
    exit 0
fi
for binary in docker yarn shasum; do command -v "$binary" >/dev/null; done
docker info >/dev/null
ssh "${ssh_options[@]}" "$target" 'test -f /opt/medicine-api/release.env && test -f /opt/medicine-api/api.env && docker inspect medicine-api >/dev/null'
if test "$mode" != upload-only; then
    if test -z "$release"; then
        release="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)-$(python3 -c 'import secrets; print(secrets.token_hex(3))')"
    fi
    echo "[1/4] Local checks and build: $release"
    yarn install --frozen-lockfile --non-interactive
    yarn prisma:generate
    yarn lint
    yarn test
    env -u REMINDERS_TEST_DATABASE_URL -u SYNC_TEST_DATABASE_URL -u DICTIONARY_TEST_DATABASE_URL yarn test:e2e
    bash deploy/build.sh "$release"
fi
artifacts="$PWD/deploy/artifacts/$release"
if ! test -f "$artifacts/update-server.sh" || ! test -f "$artifacts/migrations.json" || ! test -f "$artifacts/SHA256SUMS"; then
    echo "Release package is incomplete or uses the old format: $artifacts. Build a new version." >&2
    exit 1
fi
(cd "$artifacts" && shasum -a 256 --check SHA256SUMS)
echo "[2/4] Uploading release: $release"
ssh "${ssh_options[@]}" "$target" "set -eu; p=/opt/medicine-api/releases/$release; if test -e \"\$p\"; then test -f \"\$p/.upload-in-progress\" && test ! -e \"\$p/.deployed\"; else install -d -m 700 \"\$p\"; touch \"\$p/.upload-in-progress\"; fi"
scp "${ssh_options[@]}" "$artifacts/"* "$target:/opt/medicine-api/releases/$release/"
echo '[3/4] Backing up, applying migrations and starting candidate'
ssh "${ssh_options[@]}" "$target" "bash /opt/medicine-api/releases/$release/update-server.sh $release"
echo '[4/4] Downloading the pre-update database backup'
backup_local_dir="$(dirname "$PWD")/.deployment-backups/medicine"
mkdir -p "$backup_local_dir"
chmod 700 "$backup_local_dir"
backup_local_file="$backup_local_dir/pre-$release.dump"
if ! ssh "${ssh_options[@]}" "$target" "set -eu; backup=\$(cat /opt/medicine-api/releases/$release/backup-path.txt); case \"\$backup\" in /var/backups/medicine-deploy/pre-$release-*.dump) cat \"\$backup\" ;; *) exit 1 ;; esac" > "$backup_local_file.partial"; then
    echo "Server update succeeded ($release), but backup download failed. Retry copying the server backup; do not redeploy this version." >&2
    exit 1
fi
test -s "$backup_local_file.partial" || { echo "Server update succeeded ($release), but the downloaded backup is empty." >&2; exit 1; }
chmod 600 "$backup_local_file.partial"
mv "$backup_local_file.partial" "$backup_local_file"
echo "Update succeeded: $release"
echo 'API: https://api.uk-io.com'
echo "Local database backup: $backup_local_file"
