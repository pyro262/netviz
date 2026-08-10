import pytest

import importlib

import netviz.config as config_module


def _reload(monkeypatch, **env):
    for key in list(config_module.os.environ):
        if key.startswith("NETVIZ_HIGHLIGHT"):
            monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    return importlib.reload(config_module)


class TestHighlightNetworks:
    def test_three_slots_with_default_colours_and_no_prefixes(self, monkeypatch):
        mod = _reload(monkeypatch)
        nets = mod.Config().highlight_networks

        assert len(nets) == 3
        assert [n["prefix"] for n in nets] == ["", "", ""]
        assert [n["color"] for n in nets] == list(mod.HIGHLIGHT_DEFAULT_COLORS)

    def test_prefixes_come_from_the_environment(self, monkeypatch):
        mod = _reload(monkeypatch, NETVIZ_HIGHLIGHT1_PREFIX="10.10.10.",
                      NETVIZ_HIGHLIGHT1_LABEL="lab",
                      NETVIZ_HIGHLIGHT1_COLOR="#ff0000",
                      NETVIZ_HIGHLIGHT1_GAIN="0.4")
        first = mod.Config().highlight_networks[0]

        assert first == {"prefix": "10.10.10.", "label": "lab",
                         "color": "#ff0000", "gain": 0.4}

    def test_whitespace_around_a_prefix_is_stripped(self, monkeypatch):
        """A .env written by hand picks up trailing spaces, and a prefix with
        one matches nothing at all -- silently, since every address fails."""
        mod = _reload(monkeypatch, NETVIZ_HIGHLIGHT2_PREFIX="  10.10.20.  ")

        assert mod.Config().highlight_networks[1]["prefix"] == "10.10.20."

    def test_an_empty_slot_keeps_its_position(self, monkeypatch):
        """Slot 2 must stay slot 2 whether or not slot 1 is set, or turning one
        network off would recolour another."""
        mod = _reload(monkeypatch, NETVIZ_HIGHLIGHT2_PREFIX="10.10.20.")
        nets = mod.Config().highlight_networks

        assert nets[0]["prefix"] == ""
        assert nets[1]["prefix"] == "10.10.20."

    def test_display_config_carries_only_the_highlight_block(self, monkeypatch):
        """It is a hand-built whitelist, not a dump: Config also holds the
        Influx token, and a page handed the whole object once would carry every
        secret added to it later."""
        mod = _reload(monkeypatch, NETVIZ_HIGHLIGHT1_PREFIX="10.10.10.")
        monkeypatch.setenv("INFLUX_TOKEN", "super-secret")
        mod = importlib.reload(config_module)

        served = mod.Config().display_config()

        assert set(served) == {"highlight", "home", "resolvers"}
        assert "super-secret" not in repr(served)


class TestHomePosition:
    def test_display_config_carries_the_home_position(self, monkeypatch):
        """The page cannot derive home: the camera infers it from where arcs
        converge, which is no use to the star day/night ramp before any traffic
        has arrived."""
        monkeypatch.setenv("NETVIZ_HOME_LAT", "51.5074")
        monkeypatch.setenv("NETVIZ_HOME_LON", "-0.1278")
        mod = importlib.reload(config_module)

        home = mod.Config().display_config()["home"]

        assert home == {"lat": pytest.approx(51.5074), "lon": pytest.approx(-0.1278)}

    def test_home_is_present_even_at_the_defaults(self, monkeypatch):
        monkeypatch.delenv("NETVIZ_HOME_LAT", raising=False)
        monkeypatch.delenv("NETVIZ_HOME_LON", raising=False)
        mod = importlib.reload(config_module)

        assert set(mod.Config().display_config()["home"]) == {"lat", "lon"}


class TestExtraResolvers:
    def test_empty_by_default(self, monkeypatch):
        monkeypatch.delenv("NETVIZ_EXTRA_RESOLVERS", raising=False)
        mod = importlib.reload(config_module)
        assert mod.Config().display_config()["resolvers"]["extra"] == []

    def test_parsed_and_stripped(self, monkeypatch):
        """A .env written by hand has spaces after the commas, and a resolver
        entry with a leading space matches nothing -- silently."""
        monkeypatch.setenv("NETVIZ_EXTRA_RESOLVERS", " 203.0.113.53, 198.51.100. ")
        mod = importlib.reload(config_module)
        assert mod.Config().display_config()["resolvers"]["extra"] == [
            "203.0.113.53", "198.51.100."]

    def test_empty_entries_are_dropped(self, monkeypatch):
        monkeypatch.setenv("NETVIZ_EXTRA_RESOLVERS", "1.2.3.4,,")
        mod = importlib.reload(config_module)
        assert mod.Config().display_config()["resolvers"]["extra"] == ["1.2.3.4"]


class TestUpdateCheck:
    """The release check defaults ON.

    It was opt-in in 0.2.1, which was the wrong call for released software:
    the people most likely to be running a stale build are exactly the ones
    who never read the configuration reference, so an opt-in update notice
    reaches everybody except its audience.
    """

    def test_defaults_to_watching_upstream(self, monkeypatch):
        monkeypatch.delenv("NETVIZ_UPDATE_REPO", raising=False)
        mod = _reload(monkeypatch)
        assert mod.Config().update_repo == "pyro262/netviz"

    def test_an_empty_value_disables_it(self, monkeypatch):
        """Empty must mean off, not "fall back to the default" -- it is the
        documented way to stop the collector making any outbound request."""
        mod = _reload(monkeypatch, NETVIZ_UPDATE_REPO="")
        assert mod.Config().update_repo == ""
        assert not mod.Config().update_repo      # falsy, so run() skips the check

    def test_whitespace_only_also_disables_it(self, monkeypatch):
        mod = _reload(monkeypatch, NETVIZ_UPDATE_REPO="   ")
        assert mod.Config().update_repo == ""

    def test_a_fork_can_be_watched_instead(self, monkeypatch):
        mod = _reload(monkeypatch, NETVIZ_UPDATE_REPO="someone/their-fork")
        assert mod.Config().update_repo == "someone/their-fork"
