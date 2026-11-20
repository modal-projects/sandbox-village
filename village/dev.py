"""Run the village on this machine.

    python -m village.dev              real Modal sandboxes + the shared-endpoint brain, served from localhost
    python -m village.dev --offline    temp directories + a scripted brain; no accounts needed

The real mode needs a Modal login. It finds the brains' endpoints by name with the Modal CLI
(`modal endpoint info sandbox-village-brain`, and so on) and authenticates with a proxy token if
MODAL_PROXY_TOKEN_ID / MODAL_PROXY_TOKEN_SECRET are set, otherwise with your Modal login.
Villager state is kept in a modal.Dict, so restarting this server picks the same villagers (and
their snapshots) back up instead of leaving sandboxes behind.

Every browser gets a village of its own (see villages.py). `--shared` gives everybody the same
one instead.

The content filter's word list is not in the repository (see safety.py). Give it one with
VILLAGE_BLOCKLIST="word,another" or VILLAGE_BLOCKLIST_FILE=path/to/words.txt; without either,
the villagers' instructions are the only filter, and the server says so when it starts.
"""

from __future__ import annotations

import argparse
import os

import uvicorn

from .server import create_app
from .town import Town


# A visitor's own village is paced more gently than a shared one: it is theirs alone, and every
# villager awake in it and every thought had in it is on the bill.
PRIVATE = {"scene_gap_s": (60.0, 100.0), "scenes_per_hour": 20, "talks_per_hour": 30}


def build(offline: bool, app_name: str, runtime: str | None, quiet: bool = False, shared: bool = False):
    from .villages import ScopedStore, Villages

    limits = {} if shared else {**PRIVATE, "talks_per_hour": int(os.environ.get("VILLAGE_TALKS_PER_HOUR", PRIVATE["talks_per_hour"]))}
    room = int(os.environ.get("VILLAGE_MAX_IN_USE", "50"))
    if offline:
        import tempfile

        from .fakes import LocalHomes, scripted_think
        from .homes import MemoryStore

        store, root = MemoryStore(), tempfile.mkdtemp(prefix="village-")

        def make(village: str):
            homes = LocalHomes(ScopedStore(store, village), root=root, village=village)
            town = Town(homes, lambda *turn: scripted_think(homes, *turn), autonomous=not quiet, **{**limits, "scene_gap_s": (18.0, 30.0)})
            return homes, town

        info = {"model": "scripted (no model)", "mode": "offline"}
        return create_app(villages=Villages(make, store, shared=shared, max_in_use=room), info=info)

    from . import brain, llm
    from .homes import ModalDictStore, ModalHomes

    llm.resolve_from_cli()  # find each brain's endpoint by name
    store = ModalDictStore(f"{app_name}-state")

    def make(village: str):
        homes = ModalHomes(ScopedStore(store, village), app_name=app_name, runtime=runtime, village=village)
        town = Town(homes, lambda *turn: brain.think(homes, *turn), autonomous=not quiet, idle_s=float(os.environ.get("VILLAGE_IDLE_S", "75")), **limits)
        return homes, town

    info = {"effort": llm.EFFORT, "mode": "local server, Modal sandboxes"}
    return create_app(villages=Villages(make, store, shared=shared, max_in_use=room), access_key=os.environ.get("VILLAGE_KEY") or None, info=info)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--offline", action="store_true", help="temp directories and a scripted brain instead of Modal and a model")
    parser.add_argument("--quiet", action="store_true", help="villagers only act when spoken to (no scenes of their own)")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--app-name", default="sandbox-village-dev", help="Modal app the sandboxes are created in")
    parser.add_argument("--runtime", choices=["gvisor", "vm"], default=os.environ.get("VILLAGE_RUNTIME") or None)
    parser.add_argument("--shared", action="store_true", help="one village for everybody instead of one per visitor")
    args = parser.parse_args()
    from . import safety

    print(f"content filter: {safety.size()} listed words" if safety.size() else "content filter: no word list, so the villagers' instructions are the only filter (see village/safety.py)")
    uvicorn.run(build(args.offline, args.app_name, args.runtime, args.quiet, args.shared), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
