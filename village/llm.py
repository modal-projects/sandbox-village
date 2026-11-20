"""The villagers' brains: small open models on Modal's Model APIs (the product was called
Shared Endpoints until November 2026; the CLI and the docs still say "endpoint").

There are a few brains, each one endpoint serving one cheap model, and each villager is
wired to one of them (see `brain=` in world.py). Every thought a villager has is a request to
their brain's OpenAI-compatible URL. This module holds the list of brains, where they live, and
the two ways to authenticate to them.

Settings (environment variables):
    VILLAGE_LLM_URLS      JSON object {brain key: endpoint base URL}. If it is not set, the
                          URLs are looked up by endpoint name with the Modal CLI.
    VILLAGE_LLM_EFFORT    reasoning effort the models spend per reply (default low)
    MODAL_PROXY_TOKEN_ID / MODAL_PROXY_TOKEN_SECRET
                          a Modal proxy token; the dependable way to authenticate
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from dataclasses import dataclass

EFFORT = os.environ.get("VILLAGE_LLM_EFFORT", "low")


@dataclass(frozen=True)
class Brain:
    key: str
    endpoint: str  # name of the endpoint (`modal endpoint info <name>`)
    model: str  # model name to send with each request
    label: str  # what the game calls it
    color: str  # colour of its beacon and of the streams of thought


BRAINS: dict[str, Brain] = {
    "glm": Brain("glm", os.environ.get("VILLAGE_LLM_ENDPOINT", "sandbox-village-brain"), "nvidia/GLM-5.3-Flash-NVFP4", "GLM 5.3 Flash", "#7fee64"),
    "deepseek": Brain("deepseek", "sandbox-village-brain-deepseek", "deepseek-ai/DeepSeek-V4.1-Flash-1017", "DeepSeek V4.1 Flash", "#6fc3ff"),
}
DEFAULT = "glm"

_lock = threading.Lock()
_logins: dict[str, tuple[str, float]] = {}  # endpoint URL -> (token, good until)
_clients: dict[str, object] = {}


def urls() -> dict[str, str]:
    try:
        found = json.loads(os.environ.get("VILLAGE_LLM_URLS") or "{}")
    except json.JSONDecodeError:
        found = {}
    return {key: str(url).rstrip("/") for key, url in found.items() if key in BRAINS and url}


def get(key: str | None) -> Brain:
    """The brain a villager asked for, or the default one if that endpoint is not set up.
    With no endpoints at all (offline, with the scripted brain) everyone keeps their own."""
    live = urls()
    return BRAINS[key] if key in BRAINS and (key in live or not live) else BRAINS[DEFAULT]


def url(key: str | None) -> str:
    return urls().get(get(key).key, "")


def resolve_from_cli() -> dict[str, str]:
    """Ask the Modal CLI where each brain's endpoint lives, and remember the answers for this
    process (and, through VILLAGE_LLM_URLS, for anything it deploys). A brain whose endpoint
    does not exist is left out; its villagers think with the default brain instead."""
    found = urls()
    said = ""  # what the Modal CLI answered when it could not find the default brain
    for brain in BRAINS.values():
        if brain.key in found:
            continue
        done = subprocess.run(["modal", "endpoint", "info", brain.endpoint, "--json"], capture_output=True, text=True, timeout=60)
        if done.returncode == 0:
            found[brain.key] = json.loads(done.stdout)["service_url"].rstrip("/")
        elif brain.key == DEFAULT:
            said = (done.stderr or done.stdout).strip()
    if DEFAULT not in found:
        brain = BRAINS[DEFAULT]
        where = f"profile {os.environ.get('MODAL_PROFILE') or '(your active one)'}, environment {os.environ.get('MODAL_ENVIRONMENT') or '(its default)'}"
        raise RuntimeError(
            f"The Modal CLI could not look up the endpoint {brain.endpoint!r} using {where}.\n"
            f"It said: {said or '(nothing)'}\n"
            "If the endpoint exists in another workspace or environment, point at it with MODAL_PROFILE and MODAL_ENVIRONMENT "
            "(see `modal profile list`). If it does not exist anywhere yet, create it with:\n"
            f"  modal endpoint create --shared --model {brain.model} --name {brain.endpoint}"
        )
    os.environ["VILLAGE_LLM_URLS"] = json.dumps(found)
    return found


def describe() -> list[dict]:
    """What the game shows about each brain."""
    live = urls()
    auth = "nothing: offline, no model is called" if not live else "proxy token" if _proxy_token() else "Modal login (development)"
    return [
        {"key": b.key, "endpoint": b.endpoint, "model": b.model, "label": b.label, "color": b.color, "effort": EFFORT, "available": b.key in live or not live, "auth": auth}
        for b in BRAINS.values()
    ]


def _proxy_token() -> str | None:
    token_id = os.environ.get("MODAL_PROXY_TOKEN_ID")
    secret = os.environ.get("MODAL_PROXY_TOKEN_SECRET")
    return f"{token_id}.{secret}" if token_id and secret else None


def _login_token(endpoint_url: str) -> str:
    """A short-lived token for the Modal identity this code runs as: the same thing `modal curl`
    sends. It adds a round trip every couple of minutes and rides on an experimental CLI
    feature, so a proxy token is the dependable route for deployments."""
    with _lock:
        token, good_until = _logins.get(endpoint_url, ("", 0.0))
        if token and good_until > time.time():
            return token
        from modal._utils.async_utils import synchronizer
        from modal.client import _Client
        from modal_proto import api_pb2

        @synchronizer.create_blocking
        async def fetch(target: str) -> str:
            client = await _Client.from_env()
            response = await client._stub.CurlGetAuthToken(api_pb2.CurlAuthTokenRequest(url=target))
            return response.token

        token = fetch(endpoint_url)
        _logins[endpoint_url] = (token, time.time() + 90)
        return token


def auth_headers(key: str | None) -> dict[str, str]:
    token = _proxy_token()
    if token:
        return {"Authorization": f"Bearer {token}"}
    return {"Modal-Authorization": f"Bearer {_login_token(url(key))}"}


def client(key: str | None):
    """An OpenAI-compatible client pointed at one brain's endpoint. Auth goes in per-request
    headers (see `auth_headers`), so the API key here is a placeholder."""
    from openai import OpenAI

    brain = get(key)
    base = url(key)
    if not base:
        raise RuntimeError("VILLAGE_LLM_URLS is not set: the brains have no endpoints to call.")
    if brain.key not in _clients:
        _clients[brain.key] = OpenAI(base_url=base + "/v1", api_key="auth-is-in-the-headers", max_retries=1, timeout=90)
    return _clients[brain.key]
