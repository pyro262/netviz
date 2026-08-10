#!/usr/bin/env bash
#
# Copy the router's own geo-IP tables to the collector.
#
# The router blocks with iptables -m geoip, which resolves against xt_geoip.
# The globe geolocates with MaxMind. The two disagree about real addresses, so
# a block arc could land in a country that is not on the block list at all --
# looking like a bug in the display when the router was right by its own data.
# With these tables present the collector answers "which country did the thing
# that made this decision think this was", which is the only question the
# alarm layer is actually asking.
#
# Only the watched countries are copied. The full set is 500 files and 23 MB;
# the watched set answers every question a block event can raise, because a
# block only happens when the router matched one of them.
#
# Usage:
#   NETVIZ_WATCHED_COUNTRIES=RU,CN,KP tools/fetch_xt_geoip.sh [user@host]
#
# Needs key-based SSH to the router. Nothing here writes to the router.
set -euo pipefail

ROUTER="${1:-${NETVIZ_ROUTER_SSH:-root@ROUTER}}"
REMOTE_DIR="${NETVIZ_XT_GEOIP_REMOTE:-/usr/share/xt_geoip/LE}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# A router is rarely the host an ordinary ssh config points at, so the key is
# nameable here instead of being assumed.
SSH_KEY="${NETVIZ_ROUTER_SSH_KEY:-}"
ssh_opts=()
[[ -n "$SSH_KEY" ]] && ssh_opts+=(-i "$SSH_KEY")
DEST="${NETVIZ_XT_GEOIP_DIR:-$HERE/data/xt_geoip}"

COUNTRIES="${NETVIZ_WATCHED_COUNTRIES:-}"
if [[ -z "$COUNTRIES" ]]; then
    echo "NETVIZ_WATCHED_COUNTRIES is empty -- nothing to fetch." >&2
    echo "Set it to the country list the router blocks on, e.g. RU,CN,KP." >&2
    exit 2
fi

# Staged in a temp directory and moved into place only once every file has
# arrived and decoded, so an interrupted copy cannot leave the collector with
# half a country's ranges -- which would read as "this address is not in that
# country" and silently undo the whole point of the exercise.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "router:  $ROUTER:$REMOTE_DIR"
echo "dest:    $DEST"

IFS=',' read -r -a codes <<< "$COUNTRIES"
names=()
for raw in "${codes[@]}"; do
    cc="$(echo "$raw" | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]')"
    [[ -z "$cc" ]] && continue
    names+=("$cc.iv4" "$cc.iv6")
done

if [[ ${#names[@]} -eq 0 ]]; then
    echo "no usable country codes in NETVIZ_WATCHED_COUNTRIES" >&2
    exit 2
fi

echo "fetching ${#names[@]} files..."
# One tar stream over one SSH connection rather than one scp per file: 42
# sequential handshakes to a router cost more than the 2 MB of payload. scp
# with a multi-file remote argument is not the shortcut it looks like -- the
# remote side receives the whole list as a single path and fails.
# SC2029: the expansion is meant to happen here. The router is a busybox shell
# and the country list is ours, not user input arriving over the wire.
# shellcheck disable=SC2029
ssh "${ssh_opts[@]+"${ssh_opts[@]}"}" "$ROUTER" \
    "tar cf - -C '$REMOTE_DIR' $(printf '%q ' "${names[@]}")" \
    | tar xf - -C "$STAGE"

# Verify before installing, the same discipline as refresh_geoip.sh: a file
# that does not decode is worse than a file that is missing, because a missing
# country falls back to MaxMind while a corrupt one answers wrongly.
if ! python3 - "$STAGE" <<'PY'
import sys
from pathlib import Path

stage = Path(sys.argv[1])
bad = []
total = 0
for path in sorted(stage.iterdir()):
    size = path.stat().st_size
    record = 8 if path.suffix == ".iv4" else 32
    if size == 0 or size % record:
        bad.append(f"{path.name}: {size} bytes is not a whole number of "
                   f"{record}-byte records")
        continue
    total += size // record
if bad:
    print("\n".join(bad), file=sys.stderr)
    sys.exit(1)
print(f"verified {len(list(stage.iterdir()))} files, {total} ranges")
PY
then
    echo "verification failed -- nothing installed" >&2
    exit 1
fi

mkdir -p "$DEST"
mv -f "$STAGE"/*.iv4 "$STAGE"/*.iv6 "$DEST/"
echo "installed to $DEST"
echo "restart the collector to pick them up."
