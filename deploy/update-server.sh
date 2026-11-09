#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "$0")" && pwd)
source "$script_dir/server-lib.sh"
release=${1:?Pass a release tag}
valid_release "$release" || exit 1
migration_checker="$script_dir/migration-check.py"
lock_deployment
current=$(read_release "$root/release.env")
test "$release" != "$current" || { echo 'This release is already active.' >&2; exit 1; }
package="$root/releases/$release"
cd "$package"
test ! -e .deployed || { echo 'This release has already been deployed; use rollback instead.' >&2; exit 1; }
sha256sum --check SHA256SUMS
test "$(read_release release.env)" = "$release"
test -f "$root/api.env"
nginx -t
database_state "$package/database-before.json"
pending=$(python3 "$migration_checker" check migrations.json database-before.json)
echo "Current release: $current; candidate: $release; pending migrations: $pending"

# Load while the old service is still running, before the maintenance window.
available=$(df -Pk "$root" | awk 'NR==2 {print $4}')
archive_kb=$(du -k images.tar.gz | awk '{print $1}')
test "$available" -gt "$((archive_kb * 2 + 524288))" || { echo 'Not enough free disk space to load this release.' >&2; exit 1; }
docker load -i images.tar.gz
for image in "medicine-api:$release" "medicine-api-migrate:$release"; do
    test "$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')" = linux/amd64
done
# Validate candidate configuration before stopping the currently healthy API.
docker run --rm --network none --env-file "$root/api.env" --entrypoint node "medicine-api:$release" \
    --input-type=module -e 'import {validateEnv} from "./dist/config/env.validation.js"; validateEnv(process.env); console.log("Candidate environment valid (values redacted).");'
snapshot="$root/release-states/$current"
snapshot_current "$snapshot"
install -d -m 700 "$backup_dir"
backup="$backup_dir/pre-$release-$(date -u +%Y%m%dT%H%M%SZ).dump"
stopped=0
migration_attempted=0
committed=0
failed() {
    local status=$?
    trap - EXIT
    if test "$status" -ne 0 && test "$stopped" = 1 && test "$committed" = 0; then
        echo "Update failed. Database backup: $backup" >&2
        if test "$migration_attempted" = 0; then
            echo "Restoring previous release: $current" >&2
            if restore_files "$snapshot" && start_current; then
                echo 'Previous release restored and healthy.' >&2
            else
                echo "Automatic recovery failed. Inspect $root and container logs." >&2
            fi
        else
            (cd "$root" && docker compose --env-file candidate.env stop api) || true
            echo 'A schema migration was attempted. API is stopped; no database restore was performed.' >&2
            echo "Inspect migration history and backup before recovering. Previous config: $snapshot" >&2
        fi
    fi
    exit "$status"
}
trap failed EXIT

# Pause writes so the pre-migration backup is a consistent recovery point.
stopped=1
(cd "$root" && docker compose --env-file release.env stop api)
docker exec medicine-api-postgres pg_dump -U postgres -d medicine -Fc > "$backup"
test -s "$backup"
docker exec -i medicine-api-postgres pg_restore --list < "$backup" > /dev/null
install -m 600 compose.yaml "$root/compose.yaml"
install -m 600 release.env "$root/candidate.env"
cd "$root"
if test "$pending" -gt 0; then migration_attempted=1; fi
docker compose --env-file candidate.env --profile tools run --rm -T migrate
database_state "$package/database-after.json"
python3 "$migration_checker" check --same "$package/migrations.json" "$package/database-after.json" > /dev/null
docker compose --env-file candidate.env up -d --wait --wait-timeout 120 api
local_health
curl -fsS --retry 2 --connect-timeout 5 --max-time 20 https://api.uk-io.com/health \
  | python3 -c 'import json,sys; assert json.load(sys.stdin)=={"status":"ok"}, "Unexpected public health response"'
test "$(curl -sS --connect-timeout 5 --max-time 20 -o /dev/null -w '%{http_code}' https://api.uk-io.com/users/me)" = 401
install -m 600 "$snapshot/release.env" previous-release.env
install -m 600 candidate.env release.env
install -m 700 "$package/rollback.sh" rollback.sh
install -m 600 "$package/server-lib.sh" server-lib.sh
install -m 600 "$package/migration-check.py" migration-check.py
install -m 600 "$package/configure-sms.py" configure-sms.py
printf '%s\n' "$backup" > "$package/backup-path.txt"
touch "$package/.deployed"
committed=1
printf 'Update complete: %s -> %s\nHealth: https://api.uk-io.com/health\nBackup: %s\n' "$current" "$release" "$backup"
