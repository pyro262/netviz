"""The release check. No network in any test -- the opener is injected."""
import json
import io
import urllib.error

import pytest

from netviz.release import (ReleaseCache, fetch_latest, is_newer, parse_version)


class TestParseVersion:
    def test_plain(self):
        assert parse_version("1.2.3") == (1, 2, 3)

    def test_v_prefix(self):
        assert parse_version("v0.3.0") == (0, 3, 0)
        assert parse_version("V0.3.0") == (0, 3, 0)

    def test_whitespace(self):
        assert parse_version("  v1.0.0\n") == (1, 0, 0)

    def test_prerelease_suffix_is_dropped(self):
        assert parse_version("1.2.3-rc1") == (1, 2, 3)
        assert parse_version("1.2.3+build9") == (1, 2, 3)

    def test_short_forms(self):
        assert parse_version("2") == (2,)
        assert parse_version("2.1") == (2, 1)

    def test_extra_components_are_ignored(self):
        assert parse_version("1.2.3.4") == (1, 2, 3)

    @pytest.mark.parametrize("bad", ["", "latest", "v", None, 3, [], "release"])
    def test_unparseable_is_none(self, bad):
        assert parse_version(bad) is None


class TestIsNewer:
    def test_strictly_newer(self):
        assert is_newer("0.3.1", "0.3.0")
        assert is_newer("1.0.0", "0.9.9")

    def test_equal_is_not_newer(self):
        assert not is_newer("0.3.0", "0.3.0")
        assert not is_newer("v0.3.0", "0.3.0")

    def test_missing_components_compare_as_zero(self):
        """(0, 3) and (0, 3, 0) are the same release, not different lengths."""
        assert not is_newer("0.3", "0.3.0")
        assert not is_newer("0.3.0", "0.3")
        assert is_newer("0.4", "0.3.9")

    def test_a_collector_ahead_of_the_release_is_not_told_to_upgrade(self):
        """A working copy in front of the published tag is somebody's dev box."""
        assert not is_newer("0.3.0", "0.4.0")

    def test_numeric_not_lexical(self):
        assert is_newer("0.10.0", "0.9.0")
        assert not is_newer("0.9.0", "0.10.0")

    @pytest.mark.parametrize("latest,current", [
        ("garbage", "0.3.0"), ("0.3.1", "garbage"), ("", ""),
    ])
    def test_unparseable_never_claims_an_update(self, latest, current):
        assert not is_newer(latest, current)


class _Resp:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode()

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class TestFetchLatest:
    def test_reads_the_tag(self):
        got = fetch_latest("o/r", opener=lambda req, timeout=None: _Resp(
            {"tag_name": "v1.2.3"}))
        assert got == "v1.2.3"

    def test_network_failure_is_none_not_an_exception(self):
        def boom(req, timeout=None):
            raise urllib.error.URLError("no route to host")
        assert fetch_latest("o/r", opener=boom) is None

    def test_malformed_json_is_none(self):
        class Bad:
            def read(self): return b"<html>rate limited</html>"
            def __enter__(self): return self
            def __exit__(self, *a): return False
        assert fetch_latest("o/r", opener=lambda req, timeout=None: Bad()) is None

    def test_a_payload_without_a_tag_is_none(self):
        assert fetch_latest("o/r", opener=lambda req, timeout=None: _Resp(
            {"message": "Not Found"})) is None

    def test_the_request_names_the_repo_and_identifies_itself(self):
        seen = {}

        def opener(req, timeout=None):
            seen["url"] = req.full_url
            seen["ua"] = req.get_header("User-agent")
            return _Resp({"tag_name": "v1.0.0"})

        fetch_latest("owner/repo", opener=opener)
        assert seen["url"] == "https://api.github.com/repos/owner/repo/releases/latest"
        assert seen["ua"] == "netviz"


class TestReleaseCache:
    def test_says_nothing_before_the_first_poll(self):
        """A kiosk that cannot reach GitHub must look exactly like one that is
        up to date."""
        c = ReleaseCache("o/r", "0.3.0")
        assert c.available() is False
        assert c.state()["latest"] is None

    def test_reports_an_update_after_a_successful_poll(self):
        c = ReleaseCache("o/r", "0.3.0", clock=lambda: 100.0)
        assert c.refresh(opener=lambda req, timeout=None: _Resp({"tag_name": "v0.4.0"}))
        assert c.available() is True
        assert c.state() == {"current": "0.3.0", "latest": "v0.4.0",
                             "available": True, "checked": 100.0}

    def test_up_to_date_reports_no_update(self):
        c = ReleaseCache("o/r", "0.3.0", clock=lambda: 100.0)
        c.refresh(opener=lambda req, timeout=None: _Resp({"tag_name": "v0.3.0"}))
        assert c.available() is False
        assert c.state()["latest"] == "v0.3.0"

    def test_a_failed_poll_keeps_the_last_good_answer(self):
        """Losing the network does not mean the update stopped existing."""
        c = ReleaseCache("o/r", "0.3.0", clock=lambda: 100.0)
        c.refresh(opener=lambda req, timeout=None: _Resp({"tag_name": "v0.4.0"}))

        def boom(req, timeout=None):
            raise OSError("connection reset")
        assert c.refresh(opener=boom) is False
        assert c.available() is True

    def test_refresh_reports_success(self):
        c = ReleaseCache("o/r", "0.3.0")
        assert c.refresh(opener=lambda req, timeout=None: _Resp({"tag_name": "v1"})) is True
