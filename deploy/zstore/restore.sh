#!/bin/bash
set -euo pipefail
umask 077
if [ "$#" -ne 2 ]; then printf 'Usage: restore.sh BACKUP_DIRECTORY NEW_EMPTY_DATABASE\n' >&2; exit 2; fi
backup=$(realpath "$1")
database=$2
[[ $database =~ ^zstore_restore_[a-z0-9_]+$ ]] || { printf 'Use a new database named zstore_restore_...; live zstore is protected.\n' >&2; exit 2; }
container=${ZSTORE_PG_CONTAINER:-zstore-postgres}
(cd "$backup" && sha256sum -c SHA256SUMS)
exists=$(docker exec --user postgres "$container" psql -X -At --dbname=postgres -v name="$database" -c "SELECT datname FROM pg_database WHERE datname='$database';")
[ -z "$exists" ] || { printf 'Target already exists; refusing to overwrite.\n' >&2; exit 2; }
docker exec --user postgres "$container" createdb --template=template0 --owner=zstore "$database"
docker exec -i --user postgres "$container" pg_restore --exit-on-error --single-transaction --no-owner --role=zstore --dbname="$database" < "$backup/zstore.dump"
docker exec --user postgres "$container" psql -X --dbname="$database" -v ON_ERROR_STOP=1 -c 'ANALYZE;' >/dev/null
docker exec --user postgres "$container" psql -X -At --dbname="$database" -c 'SELECT count(*) AS accounts FROM cloud_accounts; SELECT count(*) AS applications FROM cloud_apps; SELECT count(*) AS administrator FROM cloud_admin; SELECT count(*) AS signing_records FROM cloud_private;'
printf 'Restored and checked: %s. Change the service database only after review.\n' "$database"
