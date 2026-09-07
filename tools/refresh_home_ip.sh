#!/usr/bin/env bash
# Keep NETVIZ_HOME_IPS in .env pointing at this site's current WAN address.
#
# WHY THIS EXISTS
#   An inbound-blocking router logs the far end as the SOURCE and its own WAN
#   as the DESTINATION, and both foreignEnd() and foreign_country() prefer the
#   destination. A WAN address that is genuinely routable geolocates like any
#   other host, so every inbound block gets stamped with whatever country the
#   ISP allocated the address in. NETVIZ_HOME_IPS names the address so the
#   enricher maps it to home instead. See CLAUDE.md.
#
#   That address is usually a DHCP lease, so naming it once is not enough.
#   This script is the refresher: run it from cron, and it does nothing at all
#   unless the address actually changed.
#
# USAGE
#   tools/refresh_home_ip.sh [--dry-run] [--quiet] [--no-restart]
#
# CONFIGURATION (environment, all optional)
#   NETVIZ_ROUTER_SSH   user@host of the router. Set it and the address is read
#                       from the router itself, which is authoritative and does
#                       not depend on a third party. Unset, the script asks a
#                       public echo service instead.
#   NETVIZ_WAN_IFACE    interface to read on the router (default: guess from
#                       the default route).
#   NETVIZ_SSH_KEY      identity file for that ssh.
#   NETVIZ_ECHO_URL     the echo service used when there is no router login.
#   NETVIZ_DISCORD_LIB  path to a discord.sh providing notify_discord. Absent,
#                       the script simply does not notify.
#   NETVIZ_EXTRA_HOME_IPS
#                       extra entries to keep alongside the detected address --
#                       a static /29, an IPv6 prefix, a second WAN. Comma
#                       separated, written after the detected one.
#
# WHAT IT POSTS
#   Exceptions only: a failure to detect, and the address change itself (rare,
#   and it explains a discontinuity in the wall's block countries). A run that
#   finds nothing changed says nothing anywhere -- a job that reports every
#   success is a job you learn to ignore.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ENV_FILE=".env"
KEY="NETVIZ_HOME_IPS"

: "${NETVIZ_ROUTER_SSH:=}"
: "${NETVIZ_WAN_IFACE:=}"
: "${NETVIZ_SSH_KEY:=}"
: "${NETVIZ_ECHO_URL:=https://api.ipify.org}"
: "${NETVIZ_DISCORD_LIB:=}"
: "${NETVIZ_EXTRA_HOME_IPS:=}"

DRY=0; QUIET=0; RESTART=1
for arg in "$@"; do
    case "$arg" in
        --dry-run)    DRY=1 ;;
        --quiet)      QUIET=1 ;;
        --no-restart) RESTART=0 ;;
        --help|-h)
            sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

say() { [ "$QUIET" -eq 1 ] || printf '%s\n' "$*"; }

notify() {
    [ -n "$NETVIZ_DISCORD_LIB" ] && [ -r "$NETVIZ_DISCORD_LIB" ] || return 0
    # shellcheck source=/dev/null
    source "$NETVIZ_DISCORD_LIB"
    notify_discord "$1" || true
}

# --- detect ---------------------------------------------------------------
#
# Validated before it is used for anything. A detector that fails "open" --
# returning an empty string, an HTML error page, or the router's LAN address --
# would write a value that silently un-fixes the bug it exists to fix, and the
# only symptom would be block arcs quietly going back to reading as the ISP's
# country. So: it must parse as an address, and it must not be private.
is_public_ip() {
    python3 - "$1" <<'PY'
import ipaddress, sys
try:
    a = ipaddress.ip_address(sys.argv[1])
except ValueError:
    sys.exit(1)
sys.exit(0 if a.is_global else 1)
PY
}

detect_from_router() {
    local ssh_args=(-o BatchMode=yes -o ConnectTimeout=10
                    -o StrictHostKeyChecking=accept-new)
    if [ -n "$NETVIZ_SSH_KEY" ]; then
        ssh_args+=(-i "$NETVIZ_SSH_KEY")
    fi
    local iface="$NETVIZ_WAN_IFACE"
    if [ -z "$iface" ]; then
        iface="$(ssh "${ssh_args[@]}" "$NETVIZ_ROUTER_SSH" \
                 "ip -4 route get 1.1.1.1 2>/dev/null" 2>/dev/null \
                 | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1)"
    fi
    [ -n "$iface" ] || return 1
    # shellcheck disable=SC2029  # $iface is deliberately expanded here, not there
    ssh "${ssh_args[@]}" "$NETVIZ_ROUTER_SSH" \
        "ip -4 -o addr show dev ${iface} scope global 2>/dev/null" 2>/dev/null \
        | sed -n 's/.*inet \([0-9.]*\)\/.*/\1/p' | head -1
}

detect_from_echo() {
    curl -sS -f --max-time 15 "$NETVIZ_ECHO_URL" 2>/dev/null | tr -d '[:space:]'
}

if [ -n "$NETVIZ_ROUTER_SSH" ]; then
    current="$(detect_from_router || true)"
    source_name="router ${NETVIZ_ROUTER_SSH}"
    if [ -z "$current" ]; then
        say "router lookup failed, falling back to ${NETVIZ_ECHO_URL}"
        current="$(detect_from_echo || true)"
        source_name="$NETVIZ_ECHO_URL"
    fi
else
    current="$(detect_from_echo || true)"
    source_name="$NETVIZ_ECHO_URL"
fi

if [ -z "$current" ] || ! is_public_ip "$current"; then
    msg="netviz: could not determine the WAN address (${source_name} gave '${current:-nothing}'). NETVIZ_HOME_IPS left unchanged; inbound blocks may be misattributed if the address has changed."
    echo "$msg" >&2
    notify "$msg"
    exit 1
fi

wanted="$current"
if [ -n "$NETVIZ_EXTRA_HOME_IPS" ]; then
    wanted="${current},${NETVIZ_EXTRA_HOME_IPS}"
fi

# --- compare --------------------------------------------------------------
existing=""
if [ -r "$ENV_FILE" ]; then
    existing="$(sed -n "s/^${KEY}=//p" "$ENV_FILE" | head -1)"
fi

if [ "$existing" = "$wanted" ]; then
    say "unchanged: ${KEY}=${wanted}"
    exit 0
fi

say "changed: '${existing:-<unset>}' -> '${wanted}' (from ${source_name})"
if [ "$DRY" -eq 1 ]; then
    say "--dry-run: nothing written"
    exit 0
fi

# --- write ----------------------------------------------------------------
#
# Rewritten through a temp file and moved into place, with the original file's
# mode carried over: .env is 0600 and a refresher must not be the thing that
# widens it. An in-place sed would also truncate the real file if the disk
# filled halfway through, which is a bad way to lose every other setting.
tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
if [ -f "$ENV_FILE" ]; then
    cp -p "$ENV_FILE" "$tmp"
    if grep -qE "^${KEY}=" "$ENV_FILE"; then
        # The value can contain / and , so use | as the delimiter, and write it
        # through a shell variable rather than interpolating into the pattern.
        awk -v key="$KEY" -v val="$wanted" \
            'BEGIN{FS=OFS="="} $1==key {print key "=" val; next} {print}' \
            "$ENV_FILE" > "$tmp"
    else
        printf '%s=%s\n' "$KEY" "$wanted" >> "$tmp"
    fi
else
    printf '%s=%s\n' "$KEY" "$wanted" > "$tmp"
    chmod 600 "$tmp"
fi
mv "$tmp" "$ENV_FILE"
trap - EXIT

say "wrote ${KEY}=${wanted} to ${ENV_FILE}"

# --- restart --------------------------------------------------------------
#
# The value is read from the environment once, at process start, so the
# container has to be recreated for it to matter. This is cheap here: IPFIX
# templates and the pending-write buffer both persist to /state.
if [ "$RESTART" -eq 1 ]; then
    say "recreating the collector so it reads the new value"
    docker compose up -d
fi

notify "netviz: WAN address changed to \`${wanted}\` (was \`${existing:-unset}\`, seen via ${source_name}). NETVIZ_HOME_IPS updated and the collector recreated -- inbound blocks will be attributed to their real source again."
