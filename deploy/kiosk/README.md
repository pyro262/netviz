# Kiosk autostart

Boots a Linux box straight into the netviz globe, fullscreen, with no login and
no keyboard — and puts it back there after a power cut.

This is for the *display* machine. It can be the same box as the collector or a
different one; the only thing it needs is to reach the collector's `:8099`.

**You probably do not need any of this.** Opening a browser at the collector's
URL is already a complete deployment: the collector restarts itself after a
power cut via its own container restart policy, and the page reloads itself
when a new build is deployed. Set this up only for a screen that has to come
back on its own with nobody in the room.

```
netviz-kiosk.sh        the launcher: crash-flag repair, wait, browser
netviz-kiosk.service   the systemd unit that owns tty1 and restarts forever
```

## What it actually solves

A wall display is defined by what happens when nobody is in the room. Four
things break an unattended kiosk, and each has a specific answer here:

| Failure | Answer |
|---|---|
| Power cut leaves Chromium's "Restore pages?" bubble over the globe | `netviz-kiosk.sh` rewrites `exit_type` / `exited_cleanly` in the profile before launch, *and* passes `--disable-session-crashed-bubble` |
| Display boots faster than the collector and caches "site can't be reached" | The launcher polls `/build.json` and does not start the browser until the collector answers |
| Browser crashes, is OOM-killed, or exits cleanly | `Restart=always`, `RestartSec=5` |
| A login prompt appears behind or beside the browser | The unit takes `tty1` with `Conflicts=getty@tty1.service` and `PAMName=login` |

New deploys need nothing here: the page polls `/build.json` itself and reloads
when the served assets change.

## Install

On the display machine, as root:

```bash
# 1. an unprivileged account for the browser
useradd --system --create-home --home-dir /var/lib/netviz-kiosk \
        --shell /usr/sbin/nologin kiosk
usermod -aG video,input,render kiosk

# 2. a compositor and a browser
apt install -y cage chromium          # Debian/Ubuntu

# 3. the launcher and the unit
install -m 0755 netviz-kiosk.sh /usr/local/bin/netviz-kiosk
install -m 0644 netviz-kiosk.service /etc/systemd/system/

# 4. point it at your collector, then start it
systemctl edit netviz-kiosk           # see below
systemctl daemon-reload
systemctl enable --now netviz-kiosk
```

`systemctl edit netviz-kiosk` for anything site-specific, so a package upgrade
never overwrites it:

```ini
[Service]
Environment=NETVIZ_URL=http://collector.example.lan:8099/
```

The rail is per-display and not a build-wide setting, but it is no longer a URL
parameter — right-click the running kiosk (or press `s`) and turn on **Stats
rail** from the menu once. The choice is remembered in that kiosk browser
profile's `localStorage` across reloads and restarts; see the main README.

## Check it

```bash
systemctl status netviz-kiosk
journalctl -u netviz-kiosk -f
```

The journal should show `collector is up after Ns; starting /usr/bin/chromium`.
If it sits on `waiting for collector at …`, that is the launcher doing its job:
the URL is wrong or the collector is not up yet.

**Then actually test the thing it is for.** Pull the plug — do not `reboot`, a
clean shutdown does not reproduce the bug this is built around — and watch it
come back to the globe on its own.

## Variations

- **Same box as the collector, already running a desktop.** If a GNOME/KDE
  session is already logged in, skip cage: the launcher detects `WAYLAND_DISPLAY`
  or `DISPLAY` and runs the browser directly. In that case enable GNOME
  autologin instead of using tty1, and drop the `Conflicts=getty@tty1.service`,
  `TTYPath` and `PAMName` lines from the unit.
- **X11 rather than Wayland.** Replace `cage` with `xinit`/`openbox` and add
  `xset s off -dpms` before the browser; the rest is unchanged.
- **Raspberry Pi.** Works as written. Note that netviz currently has no quality
  tiers — every display gets bloom, a shader atmosphere, tube-geometry arcs and
  ~9,000 stars — so a Pi is untested territory.
- **Screen blanking.** cage does not blank on idle, so nothing is needed. Under
  a desktop session, turn off the screensaver and power management for the
  kiosk user or the wall goes black overnight.

## Testing status

Verified on the collector host: `shellcheck` clean, the unit parses under
`systemd-analyze verify`, the crash-flag rewrite turns a real `"Crashed"` /
`"exited_cleanly":false` profile into `"Normal"` / `true`, the launcher waits
indefinitely against a dead collector and starts immediately against a live
one, and the assembled browser command line is correct.

**Not verified: an actual boot on an actual display.** No display machine was
available. The unit's seat/DRM handling — `PAMName=login`, the tty1 conflict,
the `video`/`input`/`render` groups — is the part most likely to need a tweak
for a specific box, and it is exactly the part that cannot be tested without
one. Expect to iterate once against `journalctl -u netviz-kiosk`.
