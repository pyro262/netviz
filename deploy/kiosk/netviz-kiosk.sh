#!/usr/bin/env bash
# Launch the netviz kiosk browser. Driven by netviz-kiosk.service; not meant to
# be run by hand except for testing.
#
# Three jobs, in order:
#   1. undo Chromium's crash bookkeeping, so a power cut does not come back to
#      a "Restore pages?" bubble sitting on top of the globe forever
#   2. wait for the collector to answer, so the first load is the real page and
#      not a Chromium error screen that nothing will ever refresh
#   3. exec the browser under a compositor
#
# Configuration comes from the environment (the unit file sets it):
#   NETVIZ_URL     page to display        default http://localhost:8099/?rail=1
#   NETVIZ_PROFILE Chromium profile dir   default /var/lib/netviz-kiosk/chromium
#   NETVIZ_BROWSER browser binary         default: first of chromium,
#                                         chromium-browser, google-chrome found
set -euo pipefail

URL="${NETVIZ_URL:-http://localhost:8099/?rail=1}"
PROFILE="${NETVIZ_PROFILE:-/var/lib/netviz-kiosk/chromium}"

find_browser() {
    if [ -n "${NETVIZ_BROWSER:-}" ]; then
        command -v "$NETVIZ_BROWSER" && return 0
    fi
    for candidate in chromium chromium-browser google-chrome google-chrome-stable; do
        if command -v "$candidate" >/dev/null 2>&1; then
            command -v "$candidate"
            return 0
        fi
    done
    return 1
}

BROWSER="$(find_browser)" || {
    echo "no chromium/chrome binary found; set NETVIZ_BROWSER" >&2
    exit 1
}

mkdir -p "$PROFILE"

# ---------------------------------------------------------------- crash flags
#
# Chromium records how the last session ended in its Preferences file. Cut the
# power and that stays "Crashed", so the next boot opens with a restore bubble
# over the display and a wall that needs a keyboard to clear -- the exact
# failure this whole unit exists to prevent. --disable-session-crashed-bubble
# suppresses the popup but not the "Chrome didn't shut down correctly" infobar
# in every version, so rewrite the flags as well and rely on neither alone.
#
# jq is not assumed; these are two fixed-shape keys and sed is enough. If the
# file does not exist yet (first boot) there is nothing to fix.
PREFS="$PROFILE/Default/Preferences"
if [ -f "$PREFS" ]; then
    sed -i 's/"exit_type":"[^"]*"/"exit_type":"Normal"/g; s/"exited_cleanly":false/"exited_cleanly":true/g' \
        "$PREFS" || echo "warning: could not rewrite $PREFS" >&2
fi

# ------------------------------------------------------------ wait for the page
#
# On a shared power cut the collector and the display come back together, and
# the display usually wins: it boots faster and does not have to start Docker.
# Chromium caches the failure -- a kiosk with no reload logic sits on "site
# can't be reached" until someone notices -- so wait here instead.
#
# No timeout: the unit is Restart=always, so failing out just restarts this
# same wait with more overhead. Logged once a minute so the journal shows what
# it is doing without a line every two seconds.
probe_url="${URL%%\?*}"
probe_url="${probe_url%/}/build.json"
waited=0
until curl -sf --max-time 5 -o /dev/null "$probe_url"; do
    if [ $((waited % 60)) -eq 0 ]; then
        echo "waiting for collector at $probe_url (${waited}s)"
    fi
    sleep 2
    waited=$((waited + 2))
done
echo "collector is up after ${waited}s; starting $BROWSER"

# --------------------------------------------------------------------- launch
#
# Flag notes, because several of these look removable and are not:
#   --noerrdialogs, --disable-infobars   nothing may cover the globe
#   --disable-session-crashed-bubble     belt to the sed above's braces
#   --no-first-run, --disable-component-update, --check-for-update-interval
#                                        a wall must never show a first-run
#                                        tab or restart itself for an update
#   --password-store=basic               without it Chromium blocks on a
#                                        keyring prompt that has no keyboard
#   --disable-pinch, --overscroll-history-navigation=0
#                                        a wall display with a touch panel
#                                        must not be zoomable or swipeable
# The page itself reloads when the collector deploys new assets (build.json),
# so nothing here needs to poll or restart the browser to pick up a new build.
CHROME_FLAGS=(
    --kiosk
    --noerrdialogs
    --disable-infobars
    --disable-session-crashed-bubble
    "--disable-features=TranslateUI,Translate"
    --no-first-run
    --no-default-browser-check
    --disable-component-update
    --check-for-update-interval=31536000
    --password-store=basic
    --disable-pinch
    --overscroll-history-navigation=0
    --user-data-dir="$PROFILE"
)

if [ -n "${WAYLAND_DISPLAY:-}" ] || [ -n "${NETVIZ_FORCE_WAYLAND:-}" ]; then
    CHROME_FLAGS+=(--ozone-platform=wayland)
fi

# cage is a kiosk compositor: one fullscreen window, no desktop, no shell, no
# way to get out of it. Preferred over a full desktop session because there is
# nothing to log into and nothing to accidentally leave on screen. Falls back
# to running the browser directly when something else (a desktop session, or a
# cage started elsewhere) already provides a display.
if [ -z "${WAYLAND_DISPLAY:-}" ] && [ -z "${DISPLAY:-}" ] && command -v cage >/dev/null 2>&1; then
    exec cage -- "$BROWSER" "${CHROME_FLAGS[@]}" "$URL"
fi

exec "$BROWSER" "${CHROME_FLAGS[@]}" "$URL"
