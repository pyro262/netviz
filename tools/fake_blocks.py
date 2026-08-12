#!/usr/bin/env python3
"""Fire synthetic geo-block syslog lines at a running collector.

For eyeballing the block-arc styling on the wall: real blocks land a couple of
times an hour, which is useless for tuning a color. These take the genuine
path -- netfilter-shaped syslog over UDP -> syslog_parse -> GeoIP -> fanout --
so what you see is exactly what a real block draws, not a renderer-side mock.

Nothing here runs in production and the collector needs no flag; it is just a
client of the syslog port that is already open.

    python3 tools/fake_blocks.py                 # 6 arcs, ~3s apart, to :514
    python3 tools/fake_blocks.py -n 12 -i 1.5
    python3 tools/fake_blocks.py --host 127.0.0.1 --port 5514

Source addresses are real allocations inside the 21 geo-blocked countries, so
GeoIP places them where the firewall would actually have blocked them.
"""
import argparse
import random
import socket
import time

# One per country, chosen from allocations MaxMind places in that country.
SOURCES = [
    ("CN", "1.180.0.1"), ("RU", "95.213.0.1"), ("IR", "2.144.0.1"),
    ("KP", "175.45.176.1"), ("VN", "14.160.0.1"), ("IN", "103.21.58.1"),
    ("ID", "36.66.0.1"), ("PK", "39.32.0.1"), ("BD", "103.4.144.1"),
    ("NG", "41.58.0.1"), ("ZA", "41.0.0.1"), ("UA", "31.43.0.1"),
    ("BY", "37.17.176.1"), ("KZ", "2.72.0.1"), ("RO", "5.2.128.1"),
    ("SA", "5.42.192.1"), ("QA", "37.211.0.1"), ("IL", "2.53.0.1"),
    ("SY", "5.0.0.1"), ("CU", "152.206.0.1"), ("HK", "202.64.0.1"),
]

POLICIES = [
    "Block Secure Zone to Geo Outbound",
    "Block Geo Inbound to Secure Zone",
    "Block Geo Inbound to Hotspot",
]


def line(src: str, policy: str, rng: random.Random) -> str:
    """A netfilter LOG-target line shaped like the UDM's.

    syslog_parse keys on the SRC=/DST=/PROTO= pairs and takes the policy name
    from DESCR="..." -- the bracket index is shared across 13 policies and
    cannot identify a rule, so it is only a fallback.
    """
    return (
        f'<4>kernel: [{rng.randint(100000, 999999)}.{rng.randint(0, 999999):06d}] '
        f'[CUSTOM1_WAN-D-10000] DESCR="{policy}" '
        f'IN=eth8 OUT= MAC=00:00:00:00:00:00 '
        f'SRC={src} DST=192.168.0.1 LEN={rng.randint(40, 1500)} TOS=0x00 '
        f'PREC=0x00 TTL={rng.randint(40, 64)} ID={rng.randint(1, 65535)} '
        f'PROTO={rng.choice(["TCP", "UDP"])} '
        f'SPT={rng.randint(1024, 65535)} DPT={rng.choice([22, 80, 443, 3389])} '
        f'WINDOW=1024 RES=0x00 SYN URGP=0'
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("-n", "--count", type=int, default=6)
    ap.add_argument("-i", "--interval", type=float, default=3.0,
                    help="seconds between arcs; block arcs live 18s")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=514)
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    picks = rng.sample(SOURCES, min(args.count, len(SOURCES)))
    while len(picks) < args.count:
        picks.append(rng.choice(SOURCES))

    for i, (cc, src) in enumerate(picks, 1):
        policy = rng.choice(POLICIES)
        sock.sendto(line(src, policy, rng).encode(), (args.host, args.port))
        print(f"{i}/{args.count}  {cc:2}  {src:<15}  {policy}")
        if i < args.count:
            time.sleep(args.interval)
    sock.close()


if __name__ == "__main__":
    main()
