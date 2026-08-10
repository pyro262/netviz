#!/usr/bin/env bash
# Fetch DB-IP City Lite into data/ -- the no-account GeoIP database.
#
#   ./tools/fetch_dbip.sh          # download, verify, install, restart
#   ./tools/fetch_dbip.sh --stage  # download and verify only, no install
#
# This is the fallback the collector uses when no GeoLite2-City.mmdb is
# present, so a fresh clone geolocates traffic without anyone signing up for
# anything. No credentials, no account, no rate limit: DB-IP publishes the Lite
# build as a plain monthly file.
#
# MaxMind's GeoLite2 is still the better answer where someone is willing to
# make an account (see tools/refresh_geoip.sh and the README) -- it knows that
# anycast addresses have no single location and says so, where DB-IP hands back
# a confident registrant-country guess. But a wall with no database draws no
# arcs at all, and that is a much worse first run.
#
# DB-IP Lite is CC BY 4.0: attribution is a licence condition, not a courtesy.
# The README carries it; keep it there.
#
# Same discipline as refresh_geoip.sh: the new file is verified BEFORE it
# replaces anything, so a truncated download cannot take enrichment down.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$REPO/data/dbip-city-lite.mmdb"
IMAGE="netviz-netviz-collector:latest"

stage_only=0
[ "${1:-}" = "--stage" ] && stage_only=1

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# DB-IP publishes one file per calendar month. Early on the 1st the new month
# may not exist yet, so fall back to the previous one rather than failing on a
# date boundary.
months=("$(date -u +%Y-%m)" "$(date -u -d '15 days ago' +%Y-%m)")

url=""
for month in "${months[@]}"; do
    candidate="https://download.db-ip.com/free/dbip-city-lite-${month}.mmdb.gz"
    echo "trying $month"
    code=$(curl -sIL --max-time 60 -o /dev/null -w '%{http_code}' "$candidate" || echo 000)
    if [ "$code" = "200" ]; then
        url="$candidate"
        break
    fi
    echo "  HTTP $code"
done
[ -n "$url" ] || { echo "no DB-IP City Lite build found for ${months[*]}" >&2; exit 1; }

echo "downloading $url"
code=$(curl -sSL --max-time 900 -o "$WORK/db.mmdb.gz" -w '%{http_code}' "$url")
[ "$code" = "200" ] || { echo "download failed: HTTP $code" >&2; exit 1; }

gunzip -c "$WORK/db.mmdb.gz" > "$WORK/new.mmdb"
echo "extracted $(stat -c%s "$WORK/new.mmdb") bytes"

cat > "$WORK/verify.py" <<'PY'
import sys
import geoip2.database

with geoip2.database.Reader(sys.argv[1]) as r:
    md = r.metadata()
    print(f"  {md.database_type} ip_version={md.ip_version} nodes={md.node_count}")
    if md.database_type != "DBIP-City-Lite":
        sys.exit(f"unexpected database_type {md.database_type}")
    if md.ip_version != 6:
        sys.exit("database is not IPv6-capable")
    # A structurally valid but empty file passes the metadata check on its own.
    for ip in ("8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"):
        c = r.city(ip)
        if c.location.latitude is None:
            sys.exit(f"no coordinates for {ip}")
        print(f"  {ip:22} {c.country.iso_code} "
              f"{c.location.latitude},{c.location.longitude}")
PY

# The container image owns the geoip2 dependency, so it is the preferred
# verifier. But this script is the one a fresh clone runs BEFORE the first
# `docker compose up --build`, when no image exists yet -- so fall back to a
# host python3 that happens to have geoip2, and refuse rather than install
# something unverified if neither is available.
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "verifying inside $IMAGE"
    docker run --rm --entrypoint python3 \
        -v "$WORK/new.mmdb:/new.mmdb:ro" -v "$WORK/verify.py:/verify.py:ro" \
        "$IMAGE" /verify.py /new.mmdb
elif python3 -c 'import geoip2.database' >/dev/null 2>&1; then
    echo "verifying with host python3 (no $IMAGE built yet)"
    python3 "$WORK/verify.py" "$WORK/new.mmdb"
else
    echo "cannot verify: no $IMAGE image and no geoip2 on this host." >&2
    echo "Build the image first (docker compose build) and re-run." >&2
    exit 1
fi

mkdir -p "$REPO/data"

if [ "$stage_only" -eq 1 ]; then
    install -m 0644 "$WORK/new.mmdb" "${TARGET}.new"
    echo "staged at data/$(basename "${TARGET}.new") (not installed)"
    exit 0
fi

if [ -f "$TARGET" ]; then
    cp -a "$TARGET" "${TARGET}.prev"
    echo "previous database kept at $(basename "${TARGET}.prev")"
fi
install -m 0644 "$WORK/new.mmdb" "$TARGET"
echo "installed $TARGET"

# The mmdb is opened once at startup and held open, so a new file only takes
# effect on restart. A collector that is not running yet is the normal case on
# a first run, so a failure here is not an error.
if docker compose -f "$REPO/docker-compose.yml" --project-directory "$REPO" \
        ps --status running --quiet netviz-collector 2>/dev/null | grep -q .; then
    docker compose -f "$REPO/docker-compose.yml" --project-directory "$REPO" \
        restart netviz-collector
    echo "restarted netviz-collector -- watch: docker logs -f netviz-collector | grep enrich"
else
    echo "netviz-collector not running; it will pick this up when you start it"
fi
