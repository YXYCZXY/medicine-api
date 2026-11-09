#!/usr/bin/env bash
set -euo pipefail
umask 077
backup_dir=/var/backups/medicine
install -d -m 700 "$backup_dir"
exec 9>"$backup_dir/.lock"
flock -n 9 || exit 0
stamp=$(date -u +%Y%m%dT%H%M%SZ)
temporary="$backup_dir/.medicine-$stamp.dump.partial"
trap 'rm -f "$temporary"' EXIT
docker exec medicine-api-postgres pg_dump -U postgres -d medicine -Fc > "$temporary"
test -s "$temporary"
docker exec -i medicine-api-postgres pg_restore --list < "$temporary" > /dev/null
mv "$temporary" "$backup_dir/medicine-$stamp.dump"
find "$backup_dir" -maxdepth 1 -name 'medicine-*.dump' -type f -printf '%f\n' \
    | sort -r | tail -n +8 | while IFS= read -r file; do rm -- "$backup_dir/$file"; done
printf 'Database backup completed: medicine-%s.dump\n' "$stamp"
