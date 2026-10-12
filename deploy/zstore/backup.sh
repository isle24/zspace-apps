#!/bin/bash
set -euo pipefail
umask 077
backup_root=${ZSTORE_BACKUP_ROOT:-/var/backups/zspace-store}
container=${ZSTORE_PG_CONTAINER:-zstore-postgres}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$backup_root"
chmod 700 "$backup_root"
target="$backup_root/$stamp"
mkdir "$target"
docker exec --user postgres "$container" pg_dump --format=custom --dbname=zstore > "$target/zstore.dump"
docker exec -i --user postgres "$container" pg_restore --list < "$target/zstore.dump" > "$target/contents.txt"
docker exec --user postgres "$container" psql -X -At --dbname=zstore -c 'SELECT version();' > "$target/postgres-version.txt"
printf '%s\n' 'Restore into a fresh empty database with pg_restore --exit-on-error --single-transaction --no-owner. This archive contains private account and signing data.' > "$target/README.txt"
if [ -f /var/lib/zspace-store/store/store.sqlite ]; then
  python3 - "$target/legacy-store.sqlite" <<'PY'
import sqlite3,sys
source=sqlite3.connect('file:/var/lib/zspace-store/store/store.sqlite?mode=ro',uri=True)
target=sqlite3.connect(sys.argv[1])
if hasattr(source,'backup'):
    source.backup(target)
else:
    source.execute('BEGIN')
    target.executescript('\n'.join(source.iterdump()))
target.close();source.close()
PY
fi
(cd "$target" && sha256sum zstore.dump contents.txt postgres-version.txt README.txt > SHA256SUMS; if [ -f legacy-store.sqlite ]; then sha256sum legacy-store.sqlite >> SHA256SUMS; fi)
test -s "$target/zstore.dump"
printf 'Backup verified: %s\n' "$target"
