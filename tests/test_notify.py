import importlib
import json
import logging

import pytest


def _reload_notify(monkeypatch, env_path):
    monkeypatch.setenv("WATCHTOWER_ENV", str(env_path))
    from netviz import notify
    importlib.reload(notify)
    return notify


def test_resolve_webhook_converts_shoutrrr_and_reverses_order(tmp_path, monkeypatch):
    env_file = tmp_path / "watchtower.env"
    env_file.write_text("WATCHTOWER_NOTIFICATION_URL=discord://faketoken@123456789\n")
    notify = _reload_notify(monkeypatch, env_file)

    url = notify.resolve_webhook()

    # id/token order reverses: shoutrrr is token@id, REST path is id/token
    assert url == "https://discord.com/api/webhooks/123456789/faketoken"


def test_resolve_webhook_missing_var_raises(tmp_path, monkeypatch):
    env_file = tmp_path / "watchtower.env"
    env_file.write_text("SOME_OTHER_VAR=whatever\n")
    notify = _reload_notify(monkeypatch, env_file)

    with pytest.raises(RuntimeError):
        notify.resolve_webhook()


def test_resolve_webhook_empty_value_raises(tmp_path, monkeypatch):
    env_file = tmp_path / "watchtower.env"
    env_file.write_text("WATCHTOWER_NOTIFICATION_URL=\n")
    notify = _reload_notify(monkeypatch, env_file)

    with pytest.raises(RuntimeError):
        notify.resolve_webhook()


def test_build_payload_truncates_at_2000_chars(tmp_path, monkeypatch):
    env_file = tmp_path / "watchtower.env"
    env_file.write_text("WATCHTOWER_NOTIFICATION_URL=discord://faketoken@123456789\n")
    notify = _reload_notify(monkeypatch, env_file)

    long_message = "x" * 3000
    body = notify._build_payload(long_message)
    payload = json.loads(body)

    assert len(payload["content"]) == 2000
    assert payload["content"] == "x" * 2000


def test_build_payload_does_not_truncate_short_message(tmp_path, monkeypatch):
    env_file = tmp_path / "watchtower.env"
    env_file.write_text("WATCHTOWER_NOTIFICATION_URL=discord://faketoken@123456789\n")
    notify = _reload_notify(monkeypatch, env_file)

    body = notify._build_payload("short message")
    payload = json.loads(body)

    assert payload["content"] == "short message"


# --- Finding 1: hardened parsing ------------------------------------------------

def test_resolve_webhook_strips_matching_double_quotes(tmp_path, monkeypatch):
    env_file = tmp_path / "watchtower.env"
    env_file.write_text('WATCHTOWER_NOTIFICATION_URL="discord://faketoken@123456789"\n')
    notify = _reload_notify(monkeypatch, env_file)

    assert notify.resolve_webhook() == "https://discord.com/api/webhooks/123456789/faketoken"


def test_resolve_webhook_strips_matching_single_quotes(tmp_path, monkeypatch):
    env_file = tmp_path / "watchtower.env"
    env_file.write_text("WATCHTOWER_NOTIFICATION_URL='discord://faketoken@123456789'\n")
    notify = _reload_notify(monkeypatch, env_file)

    assert notify.resolve_webhook() == "https://discord.com/api/webhooks/123456789/faketoken"


def test_resolve_webhook_ignores_commented_out_line(tmp_path, monkeypatch):
    env_file = tmp_path / "watchtower.env"
    env_file.write_text(
        "#WATCHTOWER_NOTIFICATION_URL=discord://commentedtoken@000000000\n"
        "WATCHTOWER_NOTIFICATION_URL=discord://faketoken@123456789\n"
    )
    notify = _reload_notify(monkeypatch, env_file)

    assert notify.resolve_webhook() == "https://discord.com/api/webhooks/123456789/faketoken"


def test_resolve_webhook_tolerates_crlf_line_ending(tmp_path, monkeypatch):
    env_file = tmp_path / "watchtower.env"
    env_file.write_bytes(b"WATCHTOWER_NOTIFICATION_URL=discord://faketoken@123456789\r\n")
    notify = _reload_notify(monkeypatch, env_file)

    assert notify.resolve_webhook() == "https://discord.com/api/webhooks/123456789/faketoken"


def test_resolve_webhook_duplicate_key_takes_last_occurrence(tmp_path, monkeypatch):
    env_file = tmp_path / "watchtower.env"
    env_file.write_text(
        "WATCHTOWER_NOTIFICATION_URL=discord://oldtoken@111111111\n"
        "WATCHTOWER_NOTIFICATION_URL=discord://faketoken@123456789\n"
    )
    notify = _reload_notify(monkeypatch, env_file)

    assert notify.resolve_webhook() == "https://discord.com/api/webhooks/123456789/faketoken"


def test_resolve_webhook_wrong_scheme_raises(tmp_path, monkeypatch):
    env_file = tmp_path / "watchtower.env"
    env_file.write_text("WATCHTOWER_NOTIFICATION_URL=slack://faketoken@123456789\n")
    notify = _reload_notify(monkeypatch, env_file)

    with pytest.raises(RuntimeError):
        notify.resolve_webhook()


def test_resolve_webhook_empty_token_raises(tmp_path, monkeypatch):
    env_file = tmp_path / "watchtower.env"
    env_file.write_text("WATCHTOWER_NOTIFICATION_URL=discord://@123456789\n")
    notify = _reload_notify(monkeypatch, env_file)

    with pytest.raises(RuntimeError):
        notify.resolve_webhook()


def test_resolve_webhook_empty_id_raises(tmp_path, monkeypatch):
    env_file = tmp_path / "watchtower.env"
    env_file.write_text("WATCHTOWER_NOTIFICATION_URL=discord://faketoken@\n")
    notify = _reload_notify(monkeypatch, env_file)

    with pytest.raises(RuntimeError):
        notify.resolve_webhook()


def test_resolve_webhook_error_message_never_contains_the_value(tmp_path, monkeypatch):
    env_file = tmp_path / "watchtower.env"
    env_file.write_text("WATCHTOWER_NOTIFICATION_URL=discord://faketoken@\n")
    notify = _reload_notify(monkeypatch, env_file)

    with pytest.raises(RuntimeError) as excinfo:
        notify.resolve_webhook()

    assert "faketoken" not in str(excinfo.value)


# --- Finding 2: failed post logs a warning without leaking the secret ----------

def test_post_failure_logs_warning_without_leaking_token(tmp_path, monkeypatch, caplog):
    env_file = tmp_path / "watchtower.env"
    env_file.write_text("WATCHTOWER_NOTIFICATION_URL=discord://faketoken@123456789\n")
    notify = _reload_notify(monkeypatch, env_file)

    def _raise(*_args, **_kwargs):
        # Simulate a urllib failure whose str() embeds the full request URL,
        # exactly the leak this fix must avoid propagating into the log.
        raise OSError(
            "unreachable: https://discord.com/api/webhooks/123456789/faketoken"
        )

    monkeypatch.setattr(notify.urllib.request, "urlopen", _raise)

    with caplog.at_level(logging.WARNING, logger="netviz.notify"):
        result = notify.post("test message")

    assert result is False
    assert "faketoken" not in caplog.text
    assert "123456789" not in caplog.text
    assert "OSError" in caplog.text
