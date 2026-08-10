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

        assert set(served) == {"highlight"}
        assert "super-secret" not in repr(served)
