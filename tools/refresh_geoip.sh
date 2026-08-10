#!/usr/bin/env bash
# Refresh data/GeoLite2-City.mmdb from MaxMind. Monthly-ish; MaxMind rebuilds
# GeoLite2 twice a week and rate-limits repeated downloads of the same build.
#
#   ./tools/refresh_geoip.sh          # download, verify, install, restart
#   ./tools/refresh_geoip.sh --stage  # download and verify only, no install
#
# Credentials come from netviz/.env (MAXMIND_ACCOUNT_ID, MAXMIND_LICENSE_KEY),
# mode 0600 and gitignored. They are never passed on the command line -- curl
# reads them from a temp netrc, so they stay out of the process list.
#
# The new file is verified in the container image (which owns the geoip2
# dependency) BEFORE it replaces the live one; a bad download must never take
# the collector's enrichment down.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO/.env"
TARGET="$REPO/data/GeoLite2-City.mmdb"
IMAGE="netviz-netviz-collector:latest"
EDITION="GeoLite2-City"
URL="https://download.maxmind.com/geoip/databases/${EDITION}/download?suffix=tar.gz"

stage_only=0
[ "${1:-}" = "--stage" ] && stage_only=1

[ -r "$ENV_FILE" ] || { echo "no readable $ENV_FILE" >&2; exit 1; }
# shellcheck disable=SC1090   # path is computed, not a literal
ACCOUNT_ID=$(grep -E '^MAXMIND_ACCOUNT_ID=' "$ENV_FILE" | cut -d= -f2-)
LICENSE_KEY=$(grep -E '^MAXMIND_LICENSE_KEY=' "$ENV_FILE" | cut -d= -f2-)
[ -n "$ACCOUNT_ID" ] && [ -n "$LICENSE_KEY" ] || {
    echo "MAXMIND_ACCOUNT_ID / MAXMIND_LICENSE_KEY missing from $ENV_FILE" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
umask 077

# curl reads credentials from this file rather than argv or an env var.
printf 'machine download.maxmind.com login %s password %s\n' \
       "$ACCOUNT_ID" "$LICENSE_KEY" > "$WORK/netrc"

echo "downloading $EDITION"
code=$(curl -sSL --netrc-file "$WORK/netrc" --max-time 600 \
            -o "$WORK/db.tar.gz" -w '%{http_code}' "$URL")
[ "$code" = "200" ] || {
    echo "download failed: HTTP $code" >&2
    head -c 200 "$WORK/db.tar.gz" >&2; echo >&2
    exit 1; }

tar xzf "$WORK/db.tar.gz" -C "$WORK"
NEW=$(find "$WORK" -name "${EDITION}.mmdb" -print -quit)
[ -n "$NEW" ] || { echo "no ${EDITION}.mmdb inside the archive" >&2; exit 1; }
echo "extracted $(basename "$(dirname "$NEW")") ($(stat -c%s "$NEW") bytes)"

cat > "$WORK/verify.py" <<'PY'
import sys
import geoip2.database

with geoip2.database.Reader("/new.mmdb") as r:
    md = r.metadata()
    print(f"  {md.database_type} ip_version={md.ip_version} nodes={md.node_count}")
    if md.database_type != "GeoLite2-City":
        sys.exit(f"unexpected database_type {md.database_type}")
    if md.ip_version != 6:
        sys.exit("database is not IPv6-capable")
    # A structurally valid but empty file would still pass the metadata check.
    for ip in ("8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"):
        c = r.city(ip)
        if c.location.latitude is None:
            sys.exit(f"no coordinates for {ip}")
        print(f"  {ip:22} {c.country.iso_code} "
              f"{c.location.latitude},{c.location.longitude}")
PY

echo "verifying inside $IMAGE"
docker run --rm --entrypoint python3 \
    -v "$NEW:/new.mmdb:ro" -v "$WORK/verify.py:/verify.py:ro" \
    "$IMAGE" /verify.py

if [ "$stage_only" -eq 1 ]; then
    cp "$NEW" "$REPO/data/${EDITION}.mmdb.new"
    chmod 644 "$REPO/data/${EDITION}.mmdb.new"
    echo "staged at data/${EDITION}.mmdb.new (not installed)"
    exit 0
fi

if [ -f "$TARGET" ]; then
    cp -a "$TARGET" "${TARGET}.prev"
    echo "previous database kept at $(basename "${TARGET}.prev")"
fi
install -m 0644 "$NEW" "$TARGET"
echo "installed $TARGET"

# The mmdb is opened once at startup and held open, so a new file only takes
# effect on restart.
docker compose -f "$REPO/docker-compose.yml" --project-directory "$REPO" restart netviz-collector
echo "restarted netviz-collector -- watch: docker logs -f netviz-collector | grep enrich"
