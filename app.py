"""Sandbox Village on Modal.

    web             the game: static files + JSON API + the village director. Holds no credentials
                    (unless VILLAGE_BRAIN=inline, below).
    think           the shared villager brain: one stateless agent loop for every villager. It calls
                    a small open model on Modal's Model APIs, and is the only place that
                    endpoint's credentials live.
    night_watchman  every two minutes, snapshots and stops villagers nobody is using.
    sandboxes       one per awake villager: their home. Asleep villagers are just an image ID.

Before the first deploy:
    modal endpoint create --shared --model nvidia/GLM-5.3-Flash-NVFP4 --name sandbox-village-brain
    modal endpoint create --shared --model deepseek-ai/DeepSeek-V4.1-Flash-1017 --name sandbox-village-brain-deepseek
    modal workspace proxy-tokens create --name sandbox-village
    modal secret create sandbox-village MODAL_PROXY_TOKEN_ID=wk-... MODAL_PROXY_TOKEN_SECRET=ws-...
    modal secret create sandbox-village-filter VILLAGE_BLOCKLIST="word,another word,..."

Deploy:   modal deploy app.py
Check:    modal run app.py             one real turn through web -> think -> endpoint -> sandbox, with no public URL

Settings are read from your shell when you deploy and baked into the app:
    VILLAGE_RUNTIME       "vm" or "gvisor" for the villagers' sandboxes (default: Modal chooses)
    VILLAGE_LLM_ENDPOINT  name of the default brain's endpoint (default sandbox-village-brain)
    VILLAGE_LLM_EFFORT    reasoning effort per reply (default low)
    VILLAGE_KEY           if set, the game only works when opened with ?key=<this value>
    VILLAGE_PROXY_AUTH    "1" puts Modal proxy auth in front of the web URL (requests then need
                          Modal-Key / Modal-Secret headers). Required in environments that block
                          unauthenticated URLs.
    VILLAGE_IDLE_S        seconds of quiet before a villager is put to bed (default 75)
    VILLAGE_SECRET        name of the Modal Secret holding the proxy token (default sandbox-village);
                          set it to "none" to let the brain try the function's own Modal identity
    VILLAGE_FILTER_SECRET name of the Modal Secret holding the content filter's word list, as
                          VILLAGE_BLOCKLIST (default sandbox-village-filter). The list is kept out
                          of the code on purpose. "none" runs without one: the villagers'
                          instructions are then the only filter (see village/safety.py)
    VILLAGE_DOMAIN        a custom domain to serve the game on as well, e.g. sandbox-village.modal.dev
                          (the domain has to be set up for the workspace first)
    VILLAGE_SHARED        "1" gives everybody the same village. The default is one per visitor.
    VILLAGE_MAX_IN_USE    how many villages may be in use at once, in all (default 50)
    VILLAGE_WARM          "1" keeps one container of `web` and one of `think` running all the time,
                          so nobody waits for either to start: the page opens at once and the
                          first conversation is as quick as any other. "all" does the same for
                          every web container when there are several. Unset, they stop when idle
                          (a cold page took 3.6 s instead of 0.25 s when measured, and the
                          first conversation waited 6 s longer than the next).
    VILLAGE_BRAIN         "inline" runs the villagers' turns inside the web containers instead of in
                          the separate `think` function, up to three at a time per container
                          (VILLAGE_INLINE_AT_ONCE); any more go to `think` as before. A reply then
                          starts about a second sooner (no hop between functions, and the web
                          container already has a line open to the sandbox). The price: the web
                          containers hold the endpoints' credentials.
    VILLAGE_SHARDS        how many web containers to share them between (default 1, at most 8).
                          One kept up with 50 simulated visitors and lagged at 80; four, with
                          VILLAGE_MAX_IN_USE=100, held 100.
    VILLAGE_TALKS_PER_HOUR  how often a visitor may ask a model something, per village (default 30)
"""

from __future__ import annotations

import os
from pathlib import Path

import modal

APP_NAME = os.environ.get("VILLAGE_APP", "sandbox-village")
# Every setting is baked into the image, so the code reads the same values in the cloud as it
# did on the machine that deployed it (the secret list below depends on one of them).
_SETTINGS = (
    "VILLAGE_APP", "VILLAGE_RUNTIME", "VILLAGE_LLM_ENDPOINT", "VILLAGE_LLM_URLS", "VILLAGE_LLM_EFFORT",
    "VILLAGE_KEY", "VILLAGE_IDLE_S", "VILLAGE_SECRET", "VILLAGE_FILTER_SECRET", "VILLAGE_PROXY_AUTH",
    "VILLAGE_SHARED", "VILLAGE_MAX_IN_USE", "VILLAGE_TALKS_PER_HOUR", "VILLAGE_DOMAIN", "VILLAGE_SHARDS", "VILLAGE_WARM", "VILLAGE_BRAIN", "VILLAGE_INLINE_AT_ONCE",
)  # fmt: skip
_PROXY_AUTH = os.environ.get("VILLAGE_PROXY_AUTH") == "1"
_DOMAINS = [os.environ["VILLAGE_DOMAIN"]] if os.environ.get("VILLAGE_DOMAIN") else []
_HERE = Path(__file__).parent

if modal.is_local():
    # Look each brain's endpoint URL up once, on the machine that deploys, and bake them into the app.
    from village import llm

    llm.resolve_from_cli()

app = modal.App(APP_NAME)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("fastapi[standard]==0.162.5", "openai==3.49.0")
    .env({name: os.environ[name] for name in _SETTINGS if os.environ.get(name)})
    .add_local_python_source("village")
    .add_local_dir(_HERE / "village" / "static", "/root/village/static")
    .add_local_dir(_HERE / "village" / "gpu_glossary", "/root/village/gpu_glossary")
)

_secret_name = os.environ.get("VILLAGE_SECRET", "sandbox-village")
brain_secrets = [] if _secret_name == "none" else [modal.Secret.from_name(_secret_name, required_keys=["MODAL_PROXY_TOKEN_ID", "MODAL_PROXY_TOKEN_SECRET"])]
# The content filter's word list, for every function that hears a visitor or speaks for a villager.
_filter_name = os.environ.get("VILLAGE_FILTER_SECRET", "sandbox-village-filter")
filter_secrets = [] if _filter_name == "none" else [modal.Secret.from_name(_filter_name, required_keys=["VILLAGE_BLOCKLIST"])]

_SHARED = os.environ.get("VILLAGE_SHARED") == "1"
_WARM = os.environ.get("VILLAGE_WARM", "")  # "", "1" or "all"
_WARM = "" if _WARM == "0" else _WARM
_INLINE = os.environ.get("VILLAGE_BRAIN") == "inline"
SHARDS = 1 if _SHARED else max(1, min(8, int(os.environ.get("VILLAGE_SHARDS", "1"))))
_homes: dict = {}
_store = None


def store():
    global _store
    if _store is None:
        from village.homes import ModalDictStore

        _store = ModalDictStore(f"{APP_NAME}-state")
    return _store


def homes(village: str = ""):
    """The homes of one village (see village/villages.py). Sandboxes are created in whichever
    app this code is running in, so `modal run` and `modal deploy` each get their own."""
    if village not in _homes:
        from village.homes import ModalHomes
        from village.villages import ScopedStore

        if len(_homes) > 200:  # a long-lived container has seen many villages: let the oldest go
            _homes.pop(next(iter(_homes)))
        _homes[village] = ModalHomes(ScopedStore(store(), village), app_name=None, runtime=os.environ.get("VILLAGE_RUNTIME") or None, village=village, library=f"{APP_NAME}-library")
    return _homes[village]


@app.function(image=image, secrets=brain_secrets + filter_secrets, timeout=300, min_containers=1 if _WARM else 0)
@modal.concurrent(max_inputs=16)
def think(village: str, vid: str, message: str, speaker: str, kind: str, news: str, seen: str = ""):
    """The shared villager brain. Yields the events of one turn, for one villager of one village."""
    from village import brain

    if vid == WARM_UP:
        _get_ready(village)
        return

    yield from brain.think(homes(village), vid, message, speaker, kind, news, seen)


WARM_UP = "_warm_up"  # not a villager: see `think`
INLINE_AT_ONCE = int(os.environ.get("VILLAGE_INLINE_AT_ONCE", "3"))  # turns a web container runs itself before handing the rest to `think`
_turns = [0]
_turns_lock = __import__("threading").Lock()


def _get_ready(village: str) -> None:
    """A visitor has just arrived. Do now what their first conversation would otherwise wait
    for: load the model client, sign in to both endpoints, find the village's homes and shelf."""
    import openai  # noqa: F401

    from village import llm

    for key in llm.BRAINS:
        try:
            llm.client(key)
            llm.auth_headers(key)
        except Exception as exc:
            print("getting ready:", key, type(exc).__name__, exc)
    homes(village).library()


def _villages(shard: int = 0):
    import math

    from village.dev import PRIVATE
    from village.town import Town
    from village.villages import Villages

    limits = {} if _SHARED else {**PRIVATE, "talks_per_hour": int(os.environ.get("VILLAGE_TALKS_PER_HOUR", PRIVATE["talks_per_hour"]))}

    def make(village: str):
        def remote_think(*turn):
            yield from think.remote_gen(village, *turn)

        def think_here(*turn):
            """In this container while it is quiet; in the `think` function once a few turns are
            already running here, so a busy container is not slowed by its own conversations."""
            from village import brain

            with _turns_lock:
                here = _turns[0] < INLINE_AT_ONCE
                _turns[0] += here
            if not here:
                yield from remote_think(*turn)
                return
            try:
                yield from brain.think(homes(village), *turn)
            finally:
                with _turns_lock:
                    _turns[0] -= 1

        return homes(village), Town(homes(village), think_here if _INLINE else remote_think, idle_s=float(os.environ.get("VILLAGE_IDLE_S", "75")), **limits)

    each = math.ceil(int(os.environ.get("VILLAGE_MAX_IN_USE", "50")) / SHARDS)  # every container takes its share
    def get_ready(village: str) -> None:
        if _INLINE:
            return _get_ready(village)
        for _ in think.remote_gen(village, WARM_UP, "", "", "", ""):
            pass

    return Villages(make, store(), shared=_SHARED, max_in_use=each, shard=shard, shards=SHARDS, on_arrival=get_ready)


_urls: list[str] = []


def _shard_urls() -> list[str]:
    """The address of each web container, looked up once."""
    if not _urls and SHARDS > 1:
        _urls.extend(modal.Function.from_name(APP_NAME, "web" if n == 0 else f"web{n}").get_web_url().rstrip("/") for n in range(SHARDS))
    return _urls


def _game(shard: int = 0):
    """The FastAPI app, with every villager's turns routed to the shared brain function."""
    from village import llm
    from village.server import create_app

    from village import safety

    print(f"content filter: {safety.size()} listed words" if safety.size() else "content filter: no word list, so the villagers' instructions are the only filter")
    info = {"effort": llm.EFFORT, "mode": "Modal"}
    return create_app(villages=_villages(shard), access_key=os.environ.get("VILLAGE_KEY") or None, info=info, shard_urls=_shard_urls)


# A village's director and its record of events live in one container's memory, so every web
# function is held to a single container. To serve more visitors than one container can (about
# 50: see the README), there are several such functions, `web`, `web1`, `web2` and so on, each
# with its own share of the villages. `web` is the one the page is opened on.
# They are not to be preempted: when one is taken back, the villages in it lose their directors
# and a few seconds of requests fail.
_WEB = {"image": image, "timeout": 600, "max_containers": 1, "cpu": 1.0, "memory": 1024, "nonpreemptible": True, "secrets": (brain_secrets if _INLINE else []) + filter_secrets}


@app.function(**_WEB, min_containers=1 if _WARM else 0)
@modal.concurrent(max_inputs=200)
@modal.asgi_app(requires_proxy_auth=_PROXY_AUTH, custom_domains=_DOMAINS)
def web():
    return _game(0)


def web1():
    return _game(1)


def web2():
    return _game(2)


def web3():
    return _game(3)


def web4():
    return _game(4)


def web5():
    return _game(5)


def web6():
    return _game(6)


def web7():
    return _game(7)


for _n, _serve in enumerate((web1, web2, web3, web4, web5, web6, web7), start=1):
    if _n < SHARDS:  # only as many as were asked for exist on Modal
        globals()[_serve.__name__] = app.function(**_WEB, min_containers=1 if _WARM == "all" else 0)(modal.concurrent(max_inputs=200)(modal.asgi_app(requires_proxy_auth=_PROXY_AUTH)(_serve)))


CHECK_VILLAGE = "checkvillage"  # the village `modal run app.py` plays in


@app.function(image=image, secrets=(brain_secrets if _INLINE else []) + filter_secrets, timeout=600)
def check(vid: str, message: str) -> list[str]:
    """Smoke test that never leaves Modal: drives the web API in-process, so one run covers
    waking a sandbox, a real turn through the shared brain, reading the home, and sleeping."""
    import json

    from fastapi.testclient import TestClient

    from village.villages import shard_of

    key = os.environ.get("VILLAGE_KEY")
    client = TestClient(_game(shard_of(CHECK_VILLAGE, SHARDS)), headers={"x-village": CHECK_VILLAGE, **({"x-village-key": key} if key else {})})
    from village import safety

    report = [f"content filter: {safety.size()} listed words" if safety.size() else "content filter: no word list (the villagers' instructions only)"]
    woke = client.post(f"/api/villagers/{vid}/wake").json()
    report.append(f"wake: {woke['status']} in {woke['wake_ms']} ms from {woke['woke_from']} ({woke['sandbox_id']})")
    said = ""
    with client.stream("POST", f"/api/villagers/{vid}/talk", json={"message": message, "player": "Checker"}) as response:
        for line in response.iter_lines():
            if not line.startswith("data: "):
                continue
            event = json.loads(line[6:])
            if event["type"] == "say_delta":
                said += event["text"]
            elif event["type"] == "tool_call":
                report.append(f"  tool {event['name']}: {event['summary']}")
            elif event["type"] == "error":
                report.append(f"  error: {event['message']}")
            elif event["type"] == "done":
                report.append(f"  done: {event['ms']} ms, {event['steps']} steps, model {event['model']}, usage {event['usage']}")
    report.append(f"said: {said.strip()}")
    files = client.get(f"/api/villagers/{vid}/files").json()["files"]
    report.append(f"files: {len(files)}: " + ", ".join(entry["path"] for entry in files[:14]))
    for brain in client.get("/api/brains").json():
        report.append(f"brain {brain['key']}: {brain['requests']} requests to {brain['endpoint']} ({brain['model']}), auth: {brain['auth']}, serves {', '.join(brain['villagers'])}")
    slept_state = homes("" if _SHARED else CHECK_VILLAGE).sleep(vid)
    report.append(f"sleep: {slept_state['status']}, snapshot {slept_state['snapshot_id']} in {slept_state['snapshot_ms']} ms")
    return report


@app.function(image=image, schedule=modal.Period(minutes=2), timeout=300)
def night_watchman():
    """Snapshot and stop villagers nobody has interacted with lately, in every village, and delete
    villages nobody has come back to in a week. The web server does the first while it is
    running; this catches whatever is left when everyone has gone home."""
    idle_s = float(os.environ.get("VILLAGE_IDLE_S", "75")) + 60
    did = [f"{vid} to bed" for vid in homes().sleep_idle(idle_s)] if _SHARED else _villages().watch(idle_s)
    if did:
        print("night watchman:", ", ".join(did))


@app.local_entrypoint()
def main(villager: str = "dot", message: str = "Hello! How are you, and what is on your shelves?"):
    for line in check.remote(villager, message):
        print(line)
