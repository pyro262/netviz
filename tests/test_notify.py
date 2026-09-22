import json
import logging

import pytest

from netviz import notify


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """No webhook configuration leaks in from the host running the tests."""
    for var in ("NETVIZ_WEBHOOK_URL", "NETVIZ_WEBHOOK_FILE", "NETVIZ_WEBHOOK_KEY"):
        monkeypatch.delenv(var, raising=False)


def _file_with(tmp_path, text):
    path = tmp_path / "webhook.env"
    path.write_text(text)
    return str(path)


# --- configured(): the difference between "off" and "broken" ---------------

def test_unconfigured_is_not_configured():
    assert notify.configured() is False


def test_unconfigured_post_makes_no_request(monkeypatch):
    """An install that declined alerting must not pay a failed POST every
    time a feed goes stale."""
    def _boom(*_a, **_k):
        raise AssertionError("urlopen must not be called when unconfigured")

    monkeypatch.setattr(notify.urllib.request, "urlopen", _boom)
    assert notify.post("test message") is False


def test_url_var_alone_is_configured(monkeypatch):
    monkeypatch.setenv("NETVIZ_WEBHOOK_URL",
                       "https://discord.com/api/webhooks/123456789/faketoken")
    assert notify.configured() is True


def test_file_var_alone_is_configured(monkeypatch, tmp_path):
    monkeypatch.setenv("NETVIZ_WEBHOOK_FILE", _file_with(tmp_path, ""))
    assert notify.configured() is True


def test_configured_does_not_read_the_file(monkeypatch):
    """configured() reports intent, not validity -- a missing file is a real
    error that belongs to resolve_webhook(), not a reason to look declined."""
    monkeypatch.setenv("NETVIZ_WEBHOOK_FILE", "/nonexistent/webhook.env")
    assert notify.configured() is True


def test_whitespace_only_value_is_not_configured(monkeypatch):
    monkeypatch.setenv("NETVIZ_WEBHOOK_URL", "   ")
    assert notify.configured() is False


# --- resolve_webhook(): both URL shapes ------------------------------------

def test_plain_https_url_passes_through(monkeypatch):
    url = "https://discord.com/api/webhooks/123456789/faketoken"
    monkeypatch.setenv("NETVIZ_WEBHOOK_URL", url)
    assert notify.resolve_webhook() == url


def test_shoutrrr_form_converts_and_reverses_order(monkeypatch):
    monkeypatch.setenv("NETVIZ_WEBHOOK_URL", "discord://faketoken@123456789")
    assert notify.resolve_webhook() == (
        "https://discord.com/api/webhooks/123456789/faketoken")


def test_env_var_wins_over_file(monkeypatch, tmp_path):
    monkeypatch.setenv("NETVIZ_WEBHOOK_FILE", _file_with(
        tmp_path, "NETVIZ_WEBHOOK_URL=discord://filetoken@111\n"))
    monkeypatch.setenv("NETVIZ_WEBHOOK_URL", "discord://envtoken@222")
    assert notify.resolve_webhook() == (
        "https://discord.com/api/webhooks/222/envtoken")


def test_unconfigured_resolve_raises():
    with pytest.raises(RuntimeError):
        notify.resolve_webhook()


def test_unknown_scheme_raises(monkeypatch):
    monkeypatch.setenv("NETVIZ_WEBHOOK_URL", "http://example.invalid/hook")
    with pytest.raises(RuntimeError):
        notify.resolve_webhook()


def test_shoutrrr_empty_token_raises(monkeypatch):
    monkeypatch.setenv("NETVIZ_WEBHOOK_URL", "discord://@123456789")
    with pytest.raises(RuntimeError):
        notify.resolve_webhook()


def test_shoutrrr_empty_id_raises(monkeypatch):
    monkeypatch.setenv("NETVIZ_WEBHOOK_URL", "discord://faketoken@")
    with pytest.raises(RuntimeError):
        notify.resolve_webhook()


def test_error_message_never_contains_the_value(monkeypatch):
    monkeypatch.setenv("NETVIZ_WEBHOOK_URL", "ftp://supersecretvalue@host")
    with pytest.raises(RuntimeError) as excinfo:
        notify.resolve_webhook()
    assert "supersecretvalue" not in str(excinfo.value)


# --- the file form ---------------------------------------------------------

def test_file_default_key(monkeypatch, tmp_path):
    monkeypatch.setenv("NETVIZ_WEBHOOK_FILE", _file_with(
        tmp_path, "NETVIZ_WEBHOOK_URL=discord://faketoken@123456789\n"))
    assert notify.resolve_webhook() == (
        "https://discord.com/api/webhooks/123456789/faketoken")


def test_file_custom_key(monkeypatch, tmp_path):
    """A host that already keeps a webhook for another tool points at that
    file and names its key, rather than copying the secret."""
    monkeypatch.setenv("NETVIZ_WEBHOOK_FILE", _file_with(
        tmp_path,
        "SOME_OTHER_SETTING=1\n"
        "OTHER_TOOL_NOTIFICATION_URL=discord://faketoken@123456789\n"))
    monkeypatch.setenv("NETVIZ_WEBHOOK_KEY", "OTHER_TOOL_NOTIFICATION_URL")
    assert notify.resolve_webhook() == (
        "https://discord.com/api/webhooks/123456789/faketoken")


def test_file_missing_key_raises(monkeypatch, tmp_path):
    monkeypatch.setenv("NETVIZ_WEBHOOK_FILE",
                       _file_with(tmp_path, "UNRELATED=1\n"))
    with pytest.raises(RuntimeError):
        notify.resolve_webhook()


def test_file_strips_matching_double_quotes(monkeypatch, tmp_path):
    monkeypatch.setenv("NETVIZ_WEBHOOK_FILE", _file_with(
        tmp_path, 'NETVIZ_WEBHOOK_URL="discord://faketoken@123456789"\n'))
    assert notify.resolve_webhook() == (
        "https://discord.com/api/webhooks/123456789/faketoken")


def test_file_strips_matching_single_quotes(monkeypatch, tmp_path):
    monkeypatch.setenv("NETVIZ_WEBHOOK_FILE", _file_with(
        tmp_path, "NETVIZ_WEBHOOK_URL='discord://faketoken@123456789'\n"))
    assert notify.resolve_webhook() == (
        "https://discord.com/api/webhooks/123456789/faketoken")


def test_file_ignores_commented_out_line(monkeypatch, tmp_path):
    monkeypatch.setenv("NETVIZ_WEBHOOK_FILE", _file_with(
        tmp_path,
        "# NETVIZ_WEBHOOK_URL=discord://oldtoken@999\n"
        "NETVIZ_WEBHOOK_URL=discord://faketoken@123456789\n"))
    assert notify.resolve_webhook() == (
        "https://discord.com/api/webhooks/123456789/faketoken")


def test_file_tolerates_crlf_line_ending(monkeypatch, tmp_path):
    monkeypatch.setenv("NETVIZ_WEBHOOK_FILE", _file_with(
        tmp_path, "NETVIZ_WEBHOOK_URL=discord://faketoken@123456789\r\n"))
    assert notify.resolve_webhook() == (
        "https://discord.com/api/webhooks/123456789/faketoken")


def test_file_duplicate_key_takes_last_occurrence(monkeypatch, tmp_path):
    monkeypatch.setenv("NETVIZ_WEBHOOK_FILE", _file_with(
        tmp_path,
        "NETVIZ_WEBHOOK_URL=discord://oldtoken@999\n"
        "NETVIZ_WEBHOOK_URL=discord://faketoken@123456789\n"))
    assert notify.resolve_webhook() == (
        "https://discord.com/api/webhooks/123456789/faketoken")


def test_file_is_read_at_call_time(monkeypatch, tmp_path):
    """The secret never enters the environment, so a rotated file is picked
    up without a restart."""
    path = tmp_path / "webhook.env"
    path.write_text("NETVIZ_WEBHOOK_URL=discord://first@111\n")
    monkeypatch.setenv("NETVIZ_WEBHOOK_FILE", str(path))
    assert notify.resolve_webhook().endswith("/111/first")
    path.write_text("NETVIZ_WEBHOOK_URL=discord://second@222\n")
    assert notify.resolve_webhook().endswith("/222/second")


# --- payload and posting ---------------------------------------------------

def test_build_payload_truncates_at_2000_chars():
    body = json.loads(notify._build_payload("x" * 3000))
    assert len(body["content"]) == 2000


def test_build_payload_does_not_truncate_short_message():
    body = json.loads(notify._build_payload("short"))
    assert body["content"] == "short"


def test_post_sends_a_user_agent(monkeypatch):
    """Cloudflare answers 403 `error code: 1010` to urllib's default
    User-Agent, so a missing header is a silently dead webhook."""
    monkeypatch.setenv("NETVIZ_WEBHOOK_URL", "discord://faketoken@123456789")
    seen = {}

    class _Resp:
        status = 204

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

    def _capture(req, **_kwargs):
        seen["ua"] = req.get_header("User-agent")
        return _Resp()

    monkeypatch.setattr(notify.urllib.request, "urlopen", _capture)

    assert notify.post("test message") is True
    assert seen["ua"]
    assert "Python-urllib" not in seen["ua"]


def test_user_agent_names_no_install():
    """The header ships to a third party from every clone of this project,
    so it carries the product and its version and nothing else."""
    assert notify.USER_AGENT.startswith("netviz-collector/")
    assert "http" not in notify.USER_AGENT


def test_post_failure_logs_warning_without_leaking_token(monkeypatch, caplog):
    monkeypatch.setenv("NETVIZ_WEBHOOK_URL", "discord://faketoken@123456789")

    def _raise(*_args, **_kwargs):
        # Simulate a urllib failure whose str() embeds the full request URL,
        # exactly the leak this must avoid propagating into the log.
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
