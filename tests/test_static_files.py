import json
from pathlib import Path

import pytest
from websockets.datastructures import Headers

from netviz.static_files import make_process_request


class _FakeRequest:
    def __init__(self, path: str, headers: dict | None = None, method: str = "GET") -> None:
        self.path = path
        self.headers = Headers(headers or {})
        self.method = method


class _FakeConnection:
    """Stands in for websockets' ServerConnection. respond() is the only part
    static_files uses, and it returns a real Response in the library too."""

    def __init__(self) -> None:
        self.responded = None

    def respond(self, status, text):
        self.responded = (int(status), text)
        return self.responded


@pytest.fixture
def root(tmp_path: Path) -> Path:
    (tmp_path / "index.html").write_text("<h1>globe</h1>")
    (tmp_path / "js").mkdir()
    (tmp_path / "js" / "main.js").write_text("export const x = 1;")
    (tmp_path / "secret.env").write_text("TOKEN=nope")
    return tmp_path


def test_root_path_serves_index_html(root):
    handler = make_process_request(root)

    resp = handler(_FakeConnection(), _FakeRequest("/"))

    assert resp.status_code == 200
    assert resp.body == b"<h1>globe</h1>"
    assert resp.headers["Content-Type"] == "text/html; charset=utf-8"
    assert resp.headers["Cache-Control"] == "no-cache"


def test_javascript_gets_a_module_content_type(root):
    handler = make_process_request(root)

    resp = handler(_FakeConnection(), _FakeRequest("/js/main.js"))

    assert resp.status_code == 200
    assert resp.headers["Content-Type"] == "text/javascript; charset=utf-8"


def test_query_string_is_ignored(root):
    handler = make_process_request(root)

    resp = handler(_FakeConnection(), _FakeRequest("/index.html?quality=low"))

    assert resp.status_code == 200


def test_websocket_upgrade_falls_through_to_the_handshake(root):
    handler = make_process_request(root)

    resp = handler(_FakeConnection(), _FakeRequest("/", {"Upgrade": "websocket"}))

    assert resp is None


def test_missing_file_is_404(root):
    handler = make_process_request(root)
    conn = _FakeConnection()

    handler(conn, _FakeRequest("/nope.html"))

    assert conn.responded[0] == 404


def test_traversal_outside_root_is_403(root):
    handler = make_process_request(root)
    conn = _FakeConnection()

    handler(conn, _FakeRequest("/../../etc/passwd"))

    assert conn.responded[0] == 403


def test_encoded_traversal_is_403(root):
    handler = make_process_request(root)
    conn = _FakeConnection()

    handler(conn, _FakeRequest("/%2e%2e/%2e%2e/etc/passwd"))

    assert conn.responded[0] == 403


def test_non_whitelisted_extension_is_404_even_when_present(root):
    handler = make_process_request(root)
    conn = _FakeConnection()

    handler(conn, _FakeRequest("/secret.env"))

    assert conn.responded[0] == 404


def test_non_get_method_is_405(root):
    handler = make_process_request(root)
    conn = _FakeConnection()

    handler(conn, _FakeRequest("/", method="POST"))

    assert conn.responded[0] == 405


# --- build stamp: lets a kiosk notice a new deploy and reload itself ---------

def test_build_stamp_endpoint_returns_the_current_stamp(root):
    from netviz.static_files import build_stamp

    handler = make_process_request(root)

    resp = handler(_FakeConnection(), _FakeRequest("/build.json"))

    assert resp.status_code == 200
    assert resp.headers["Content-Type"] == "application/json; charset=utf-8"
    assert json.loads(resp.body)["stamp"] == build_stamp(root)


def test_build_stamp_changes_when_a_served_file_changes(root):
    from netviz.static_files import build_stamp

    before = build_stamp(root)
    (root / "js" / "main.js").write_text("export const x = 2;")

    assert build_stamp(root) != before


def test_build_stamp_is_stable_when_nothing_changes(root):
    from netviz.static_files import build_stamp

    assert build_stamp(root) == build_stamp(root)


def test_build_stamp_ignores_files_that_are_never_served(root):
    """A restart alone must not bounce every kiosk -- only a real asset change
    should. Files outside the served extension set are not part of the stamp."""
    from netviz.static_files import build_stamp

    before = build_stamp(root)
    (root / "secret.env").write_text("TOKEN=changed")

    assert build_stamp(root) == before


def test_health_json_reports_feed_status(root):
    from netviz.health import Health

    health = Health({"netflow": 60.0})
    health.saw("netflow", 1000.0)
    handler = make_process_request(root, health=health, clock=lambda: 1010.0)

    resp = handler(_FakeConnection(), _FakeRequest("/health.json"))

    assert resp.status_code == 200
    assert resp.headers["Content-Type"] == "application/json; charset=utf-8"
    assert resp.headers["Cache-Control"] == "no-store"
    body = json.loads(resp.body)
    assert body["feeds"]["netflow"]["ok"] is True
    assert body["feeds"]["netflow"]["age"] == pytest.approx(10.0)
    assert body["now"] == pytest.approx(1010.0)


def test_health_json_marks_a_stale_feed(root):
    from netviz.health import Health

    health = Health({"netflow": 60.0})
    health.saw("netflow", 1000.0)
    handler = make_process_request(root, health=health, clock=lambda: 1100.0)

    body = json.loads(handler(_FakeConnection(), _FakeRequest("/health.json")).body)

    assert body["feeds"]["netflow"]["ok"] is False


def test_health_json_404s_when_no_health_object_is_wired(root):
    """The kiosk treats a 404 as 'this build has no health endpoint' rather
    than as a dead feed, so it must not be a 200 with empty feeds."""
    handler = make_process_request(root)

    conn = _FakeConnection()
    handler(conn, _FakeRequest("/health.json"))

    assert conn.responded[0] == 404


def test_health_json_is_not_shadowed_by_a_file_on_disk(root):
    from netviz.health import Health

    (root / "health.json").write_text('{"feeds": "from disk"}')
    handler = make_process_request(root, health=Health({}), clock=lambda: 5.0)

    body = json.loads(handler(_FakeConnection(), _FakeRequest("/health.json")).body)

    assert body == {"feeds": {}, "now": 5.0}


def test_stats_json_serves_the_rail_snapshot(root):
    from netviz.events import Event
    from netviz.stats import Stats

    stats = Stats(clock=lambda: 5000.0)
    stats.note(Event(ts=4999.0, kind="block", src_ip="10.0.0.1", dst_ip="1.2.3.4",
                     bytes=40, proto=6, src_country="--", dst_country="CN"),
               now=5000.0)
    handler = make_process_request(root, stats=stats, clock=lambda: 5000.0)

    body = json.loads(handler(_FakeConnection(), _FakeRequest("/stats.json")).body)

    assert body["blocks"]["total"] == 1
    assert body["blocks"]["top"] == [{"cc": "CN", "n": 1}]
    assert body["feeds"] is None          # no Health wired into this handler


def test_stats_json_carries_the_health_block_too(root):
    """One request per rail tick, not two: the rail needs the feed states as
    well, and polling /health.json separately would double the traffic for the
    same answer."""
    from netviz.health import Health
    from netviz.stats import Stats

    health = Health({"netflow": 60.0})
    health.saw("netflow", 1000.0)
    handler = make_process_request(root, health=health, stats=Stats(),
                                   clock=lambda: 1010.0)

    body = json.loads(handler(_FakeConnection(), _FakeRequest("/stats.json")).body)

    assert body["feeds"]["netflow"]["ok"] is True


def test_stats_json_404s_when_no_stats_object_is_wired(root):
    handler = make_process_request(root)

    conn = _FakeConnection()
    handler(conn, _FakeRequest("/stats.json"))

    assert conn.responded[0] == 404


def test_stats_json_is_not_shadowed_by_a_file_on_disk(root):
    from netviz.stats import Stats

    (root / "stats.json").write_text('{"blocks": "from disk"}')
    handler = make_process_request(root, stats=Stats(), clock=lambda: 5000.0)

    body = json.loads(handler(_FakeConnection(), _FakeRequest("/stats.json")).body)

    assert body["blocks"]["total"] == 0


def test_head_on_stats_json_has_no_body(root):
    from netviz.stats import Stats

    handler = make_process_request(root, stats=Stats(), clock=lambda: 5000.0)

    resp = handler(_FakeConnection(), _FakeRequest("/stats.json", method="HEAD"))

    assert resp.body == b""
    assert int(resp.headers["Content-Length"]) > 0


def test_config_json_serves_the_display_config(root):
    handler = make_process_request(root, display_config={
        "highlight": {"networks": [{"prefix": "10.10.10.", "label": "lab",
                                    "color": "#a855f7", "gain": 0.7}]}})

    body = json.loads(handler(_FakeConnection(), _FakeRequest("/config.json")).body)

    assert body["highlight"]["networks"][0]["prefix"] == "10.10.10."


def test_config_json_is_an_empty_object_when_nothing_is_configured(root):
    """Not a 404. The page has to tell "no networks highlighted" from "this
    build has no endpoint", and an unconfigured install is the normal case."""
    handler = make_process_request(root)

    resp = handler(_FakeConnection(), _FakeRequest("/config.json"))

    assert json.loads(resp.body) == {}


def test_config_json_is_not_shadowed_by_a_file_on_disk(root):
    (root / "config.json").write_text('{"highlight": "from disk"}')
    handler = make_process_request(root, display_config={"highlight": {"networks": []}})

    body = json.loads(handler(_FakeConnection(), _FakeRequest("/config.json")).body)

    assert body == {"highlight": {"networks": []}}


def test_build_stamp_changes_when_the_display_config_does(root):
    """A wall display has nobody standing at it to press F5. The page reads
    /config.json once at boot, so a colour changed in .env has to move the
    build stamp or every open kiosk keeps the old palette indefinitely."""
    from netviz.static_files import build_stamp

    before = build_stamp(root, '{"highlight": "cyan"}')
    after = build_stamp(root, '{"highlight": "violet"}')

    assert before != after


def test_build_stamp_is_stable_when_nothing_changes(root):
    """The other half of it: a bare restart must not bounce every display."""
    from netviz.static_files import build_stamp

    assert build_stamp(root, '{"a": 1}') == build_stamp(root, '{"a": 1}')
    assert build_stamp(root) == build_stamp(root)


def test_build_json_reflects_a_config_change(root):
    from netviz.stats import Stats

    one = make_process_request(root, stats=Stats(),
                               display_config={"highlight": {"networks": [
                                   {"prefix": "10.10.10.", "color": "#22d3ee"}]}})
    two = make_process_request(root, stats=Stats(),
                               display_config={"highlight": {"networks": [
                                   {"prefix": "10.10.10.", "color": "#a855f7"}]}})

    a = json.loads(one(_FakeConnection(), _FakeRequest("/build.json")).body)["stamp"]
    b = json.loads(two(_FakeConnection(), _FakeRequest("/build.json")).body)["stamp"]

    assert a != b


class TestRevalidation:
    """A kiosk reload must re-check every asset but should not have to
    re-download the ones that did not change. `no-store` forbade keeping them
    at all, which made every reload pay for 650 KB of three.js before it could
    paint -- and a reload is exactly when nothing is being drawn."""

    def test_a_static_file_carries_an_etag(self, root):
        handler = make_process_request(root)

        resp = handler(_FakeConnection(), _FakeRequest("/js/main.js"))

        assert resp.status_code == 200
        assert resp.headers["ETag"].startswith('"')
        assert resp.headers["Cache-Control"] == "no-cache"

    def test_an_unchanged_file_comes_back_304_with_no_body(self, root):
        handler = make_process_request(root)
        first = handler(_FakeConnection(), _FakeRequest("/js/main.js"))

        second = handler(_FakeConnection(), _FakeRequest(
            "/js/main.js", {"If-None-Match": first.headers["ETag"]}))

        assert second.status_code == 304
        assert second.body == b""
        assert second.headers["ETag"] == first.headers["ETag"]

    def test_a_changed_file_is_sent_in_full(self, root):
        """The whole safety argument for dropping no-store: revalidation still
        happens on every request, so a deploy can never serve stale JS."""
        handler = make_process_request(root)
        stale = handler(_FakeConnection(), _FakeRequest("/js/main.js")).headers["ETag"]

        (root / "js" / "main.js").write_text("export const x = 2;  // redeployed")

        resp = handler(_FakeConnection(), _FakeRequest(
            "/js/main.js", {"If-None-Match": stale}))

        assert resp.status_code == 200
        assert b"redeployed" in resp.body
        assert resp.headers["ETag"] != stale

    def test_a_matching_etag_for_a_different_file_is_not_honoured(self, root):
        handler = make_process_request(root)
        js = handler(_FakeConnection(), _FakeRequest("/js/main.js")).headers["ETag"]

        resp = handler(_FakeConnection(), _FakeRequest(
            "/index.html", {"If-None-Match": js}))

        assert resp.status_code == 200
        assert resp.body == b"<h1>globe</h1>"

    def test_the_json_endpoints_stay_no_store(self, root):
        """These are live state, not assets. A cached /build.json would defeat
        the reload it exists to trigger."""
        handler = make_process_request(root)

        resp = handler(_FakeConnection(), _FakeRequest("/build.json"))

        assert resp.headers["Cache-Control"] == "no-store"
        assert "ETag" not in resp.headers
