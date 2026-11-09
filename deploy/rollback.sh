#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "$0")" && pwd)
source "$script_dir/server-lib.sh"
migration_checker="$script_dir/migration-check.py"
lock_deployment
current=$(read_release "$root/release.env")
target=${1:-}
if test -z "$target"; then target=$(read_release "$root/previous-release.env"); fi
valid_release "$target" || exit 1
test "$target" != "$current" || { echo 'Target release is already active.' >&2; exit 1; }
state="$root/release-states/$target"
for file in compose.yaml release.env api.env migrations.json; do
    test -f "$state/$file" || { echo "Saved release state is unavailable: $state/$file" >&2; exit 1; }
done
test "$(read_release "$state/release.env")" = "$target"
docker image inspect "medicine-api:$target" >/dev/null
database_state "$root/rollback-database-state.json"
python3 "$migration_checker" check --same "$state/migrations.json" "$root/rollback-database-state.json" > /dev/null
saved="$root/release-states/$current"
snapshot_current "$saved"
install -d -m 700 "$backup_dir"
backup="$backup_dir/pre-rollback-$target-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker exec medicine-api-postgres pg_dump -U postgres -d medicine -Fc > "$backup"
test -s "$backup"
docker exec -i medicine-api-postgres pg_restore --list < "$backup" > /dev/null
stopped=0
completed=0
failed() {
    local status=$?
    trap - EXIT
    if test "$status" -ne 0 && test "$stopped" = 1 && test "$completed" = 0; then
        echo "Rollback failed; restoring $current" >&2
        if restore_files "$saved" && start_current; then
            echo 'Original release restored and healthy.' >&2
        else
            echo "Automatic recovery failed. Inspect saved config: $saved" >&2
        fi
    fi
    exit "$status"
}
trap failed EXIT
stopped=1
(cd "$root" && docker compose --env-file release.env stop api)
restore_files "$state"
start_current
install -m 600 "$saved/release.env" "$root/previous-release.env"
completed=1
printf 'Rollback complete: %s -> %s\nDatabase backup: %s\n' "$current" "$target" "$backup"
