#!/usr/bin/env bash
# Release gate. Rebuilds the container, runs every live verifier against it,
# then asks the operator to confirm the wall itself looks right -- and only
# then writes the stamp the pre-push hook reads.
#
# The stamp names the exact commit it was earned on. One more commit and it
# no longer matches, so "verified" can never mean "verified something else".
#
#   tools/verify_release.sh              verify HEAD and stamp it
#   NETVIZ_VERIFY_URL=... tools/verify_release.sh
#
# The hook only demands a stamp for a push that carries a version tag. An
# ordinary push is gated on the two test suites alone.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

URL="${NETVIZ_VERIFY_URL:-http://127.0.0.1:8099/}"
STAMP=".git/netviz-verified"

say() { printf '\n=== %s\n' "$*"; }

if [[ -n "$(git status --porcelain)" ]]; then
  echo "refusing: working tree is dirty -- commit first, then verify that commit" >&2
  exit 1
fi
head_sha="$(git rev-parse HEAD)"

say "test suites"
python3 -m pytest -q
node --test tests/js/*.test.mjs

say "rebuild and restart the collector"
docker compose build
docker compose up -d

say "waiting for the collector to answer"
for _ in $(seq 1 60); do
  if curl -sf --max-time 3 "${URL%/}/build.json" >/dev/null; then break; fi
  sleep 2
done
build="$(curl -sf --max-time 5 "${URL%/}/build.json")" || {
  echo "refusing: no answer from $URL after 120s" >&2
  exit 1
}

# A container serving a stale image is the failure this whole script exists to
# catch, so check the served version against the source before trusting a
# single verifier result.
want="$(python3 -c 'import netviz; print(netviz.__version__)')"
got="$(printf '%s' "$build" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("update",{}).get("current",""))')"
if [[ "$want" != "$got" ]]; then
  echo "refusing: source is $want, the container is serving '$got'" >&2
  exit 1
fi
echo "serving $got at $URL"

say "live verifiers against the rebuilt container"
for v in verify_rules_editor verify_menu verify_settings; do
  echo "--- $v"
  python3 "tools/$v.py" --url "$URL"
done

# verify_walk runs STANDALONE, on its own synthetic collector, and pointing it
# at the live deployment is a mistake this script made once. What it measures
# is camera arithmetic -- the walk's span and the shape of its rate ramp --
# which needs no real traffic. A live feed actively harms it: arcs.spawn
# rate-caps flows at traffic.flowsPerSecond, so on a busy wall the ripple case
# has its own arc silently discarded before it is ever drawn and reports "no
# ripple" for an arc that never existed. Measured: 3/4 against the live wall,
# 4/4 standalone, same commit.
say "verify_walk (standalone -- its own collector, no live feed)"
echo "--- verify_walk"
python3 tools/verify_walk.py

say "your turn"
cat <<EOF
Every automated check passed against $got at $URL.

Look at the display now. The verifiers prove the mechanisms; they cannot tell
you the wall reads right. Then answer:
EOF
read -r -p "Have you looked at the live display and is it correct? (yes/no) " answer
if [[ "$answer" != "yes" ]]; then
  echo "not stamped. Nothing was written; the push stays blocked." >&2
  exit 1
fi

printf '%s %s %s\n' "$head_sha" "$(date -Is)" "$got" > "$STAMP"
say "stamped $head_sha ($got) -- a version-tag push is now allowed"
