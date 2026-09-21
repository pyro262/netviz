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
#   By default this needs NO credentials of any kind. The address is read from
#   public echo services -- the same answer the internet gives anyone who asks
#   what your address is, which is exactly the number that ends up in an
#   inbound block's destination field. Several are tried in order so no single
#   third party is a dependency; the first one that answers with a routable
#   address wins.
#
#   There is deliberately no SSH path. Reading one number does not justify
#   asking for a shell login on the router, and plenty of installs have no
#   router credentials to give.
#
#   NETVIZ_ECHO_URLS    space-separated echo services, overriding the defaults.
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

# Four, so one service being down, rate-limiting or returning a courtesy page
# is not an outage. They are asked in order and the first routable answer wins.
: "${NETVIZ_ECHO_URLS:=https://api.ipify.org https://icanhazip.com https://checkip.amazonaws.com https://ifconfig.me/ip}"
: "${NETVIZ_DISCORD_LIB:=}"
: "${NETVIZ_EXTRA_HOME_IPS:=}"

DRY=0; QUIET=0; RESTART=1
for arg in "$@"; do
    case "$arg" in
        --dry-run)    DRY=1 ;;
        --quiet)      QUIET=1 ;;
        --no-restart) RESTART=0 ;;
        --help|-h)
            sed -n '2,52p' "$0" | sed 's/^# \{0,1\}//'
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

# Sets DETECTED and ECHO_SOURCE rather than printing, because the caller needs
# to know WHICH service answered and a `$(...)` capture would run this in a
# subshell where that second value could not get back out.
detect_from_echo() {
    local url answer
    DETECTED=""
    ECHO_SOURCE=""
    for url in $NETVIZ_ECHO_URLS; do
        answer="$(curl -sS -f --max-time 10 "$url" 2>/dev/null | tr -d '[:space:]')"
        if [ -n "$answer" ] && is_public_ip "$answer"; then
            DETECTED="$answer"
            ECHO_SOURCE="$url"
            return 0
        fi
        say "no usable answer from ${url}, trying the next one"
    done
    return 1
}

if detect_from_echo; then
    current="$DETECTED"
    source_name="$ECHO_SOURCE"
else
    current=""
    source_name="the echo services"
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
    # --no-build --no-deps, and the service named explicitly. A bare
    # `up -d` is a full recreate of everything in the file: it would also
    # deploy a locally built image or an edited compose file that somebody
    # had made but deliberately NOT deployed yet. This script is scheduled,
    # so that would happen unattended, in the middle of the night, on the
    # unrelated event of a DHCP lease moving -- and the only notification
    # sent says the WAN address changed. All this needs is for the
    # collector to re-read its environment.
    docker compose up -d --no-build --no-deps netviz-collector
fi

notify "netviz: WAN address changed to \`${wanted}\` (was \`${existing:-unset}\`, seen via ${source_name}). NETVIZ_HOME_IPS updated and the collector recreated -- inbound blocks will be attributed to their real source again."
