"""The Event contract. Every unit in the collector speaks this shape."""
from dataclasses import dataclass, field
from typing import Literal, Optional

Kind = Literal["flow", "block"]


@dataclass
class Event:
    ts: float                      # unix seconds, float
    kind: Kind
    src_ip: str
    dst_ip: str
    bytes: int
    proto: int                     # IANA protocol number: 6 tcp, 17 udp
    policy_id: Optional[str] = None
    src_lat: Optional[float] = None
    src_lon: Optional[float] = None
    src_country: Optional[str] = None
    dst_lat: Optional[float] = None
    dst_lon: Optional[float] = None
    dst_country: Optional[str] = None
    # Transport ports, when the source carries them. Only the renderer uses
    # these, to separate DNS chatter from data traffic: nameserver flows are a
    # third of all events but a twentieth of the bytes, and every one of them
    # geolocates to MaxMind's country centroid rather than a real place.
    src_port: Optional[int] = None
    dst_port: Optional[int] = None

    def to_wire(self) -> dict:
        """Compact JSON shape sent over the WebSocket. Keys are short because
        this goes out at up to thousands of events per minute."""
        w = {
            "t": int(self.ts * 1000),
            "k": self.kind,
            "s": self.src_ip,
            "d": self.dst_ip,
            "b": self.bytes,
            "pr": self.proto,
        }
        if self.policy_id is not None:
            w["p"] = self.policy_id
        if self.src_lat is not None:
            w["sll"] = [self.src_lat, self.src_lon]
            w["sc"] = self.src_country
        if self.dst_lat is not None:
            w["dll"] = [self.dst_lat, self.dst_lon]
            w["dc"] = self.dst_country
        # Omitted rather than zeroed: 0 is a real port number, so a default of
        # 0 would be indistinguishable from "this source has no ports".
        if self.src_port is not None:
            w["sp"] = self.src_port
        if self.dst_port is not None:
            w["dp"] = self.dst_port
        return w

    @classmethod
    def from_wire(cls, w: dict) -> "Event":
        sll = w.get("sll") or (None, None)
        dll = w.get("dll") or (None, None)
        return cls(
            ts=w["t"] / 1000.0,
            kind=w["k"],
            src_ip=w["s"],
            dst_ip=w["d"],
            bytes=w["b"],
            proto=w["pr"],
            policy_id=w.get("p"),
            src_lat=sll[0], src_lon=sll[1], src_country=w.get("sc"),
            dst_lat=dll[0], dst_lon=dll[1], dst_country=w.get("dc"),
            src_port=w.get("sp"), dst_port=w.get("dp"),
        )
