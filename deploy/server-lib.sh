#!/usr/bin/env bash
# Sourced by the server update and rollback commands.
set -euo pipefail
umask 077
root=${MEDICINE_DEPLOY_ROOT:-/opt/medicine-api}
backup_dir=${MEDICINE_BACKUP_DIR:-/var/backups/medicine-deploy}

valid_release() { [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]+$ ]]; }
read_release() {
    local value
    value=$(sed -n 's/^RELEASE=//p' "$1")
    valid_release "$value" || { echo 'Invalid release.env' >&2; return 1; }
    printf '%s\n' "$value"
}
lock_deployment() {
    test -d "$root"
    exec 9>"$root/.deploy.lock"
    flock -n 9 || { echo 'Another medicine deployment is running.' >&2; exit 1; }
}
database_state() {
    docker exec medicine-api-postgres psql -X -v ON_ERROR_STOP=1 -U postgres -d medicine -Atc \
      "SELECT COALESCE(json_agg(json_build_object('name', migration_name, 'checksum', checksum, 'completed', finished_at IS NOT NULL, 'rolled_back', rolled_back_at IS NOT NULL)), '[]'::json) FROM _prisma_migrations" > "$1"
}
local_health() {
    curl -fsS --connect-timeout 5 --max-time 15 http://127.0.0.1:3100/health \
      | python3 -c 'import json,sys; assert json.load(sys.stdin)=={"status":"ok"}, "Unexpected health response"'
}
snapshot_current() {
    local state=$1
    install -d -m 700 "$state"
    for file in compose.yaml release.env api.env; do
        install -m 600 "$root/$file" "$state/$file"
    done
    database_state "$state/database-state.json"
    python3 "$migration_checker" snapshot "$state/migrations.json" "$state/database-state.json"
}
restore_files() {
    local state=$1
    for file in compose.yaml api.env release.env; do
        install -m 600 "$state/$file" "$root/$file" || return "$?"
    done
}
start_current() {
    (cd "$root" && docker compose --env-file release.env up -d --wait --wait-timeout 120 api) || return "$?"
    local_health
}
