#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
release=${1:-$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)-worktree}
[[ "$release" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]+$ ]] || { echo 'Invalid release tag' >&2; exit 1; }
artifacts="$PWD/deploy/artifacts/$release"
if test -e "$artifacts"; then
    echo "Release directory already exists: $artifacts. Use a new release tag." >&2
    exit 1
fi
mkdir -p "$artifacts"
docker buildx build --platform linux/amd64 --target runtime --load \
    --label "org.opencontainers.image.version=$release" -t "medicine-api:$release" .
docker buildx build --platform linux/amd64 --target migrate --load \
    --label "org.opencontainers.image.version=$release" -t "medicine-api-migrate:$release" .
docker save "medicine-api:$release" "medicine-api-migrate:$release" | gzip > "$artifacts/images.tar.gz"
cp deploy/compose.yaml deploy/nginx.conf deploy/backup.sh deploy/install.sh deploy/rollback.sh deploy/update-server.sh deploy/server-lib.sh deploy/migration-check.py deploy/configure-sms.py deploy/medicine-api-backup.service deploy/medicine-api-backup.timer "$artifacts/"
python3 - "$artifacts/public.env" <<'PY'
from pathlib import Path
import sys
allowed={'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY'}
lines=[line for line in Path('.env.example').read_text().splitlines() if line.partition('=')[0] in allowed]
if len(lines)!=2:
    raise SystemExit('Missing public authentication settings')
Path(sys.argv[1]).write_text('\n'.join(lines)+'\n')
PY
python3 - "$artifacts/migrations.json" <<'PY'
from pathlib import Path
import hashlib,json,sys
manifest={p.parent.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(Path('prisma/migrations').glob('*/migration.sql'))}
Path(sys.argv[1]).write_text(json.dumps(manifest,indent=2)+'\n')
PY
printf 'RELEASE=%s\n' "$release" > "$artifacts/release.env"
docker image inspect "medicine-api:$release" "medicine-api-migrate:$release" \
    --format '{{.RepoTags}} {{.Id}} {{.Os}}/{{.Architecture}}' > "$artifacts/images.txt"
(
  cd "$artifacts"
  shasum -a 256 images.tar.gz compose.yaml nginx.conf backup.sh install.sh rollback.sh update-server.sh server-lib.sh migration-check.py configure-sms.py migrations.json medicine-api-backup.service medicine-api-backup.timer release.env images.txt public.env > SHA256SUMS
)
printf 'Release artifacts: %s\n' "$artifacts"
