"""The game's web server: static files for the browser game plus a small JSON API.

`create_app` takes the things that differ between a laptop and Modal: how a village's homes
are made, and its `think(villager_id, message, speaker, kind, news)` generator. Locally `think`
runs in-process; on Modal it is a remote call to the shared brain function (see ../app.py).
Each visitor has a village of their own (see villages.py), named in the X-Village header.
"""

from __future__ import annotations

import contextlib
import hmac
import json
import re
import time
from collections.abc import Callable, Iterator
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import arcade, world
from .brain import COMMON_TOOLS
from .homes import HomeError, HomeGone, HomeRubble, Homes
from .town import Town
from .villages import NoSuchVillage, Village, VillageFull, Villages, WrongShard

STATIC_DIR = Path(__file__).parent / "static"
SLEEP_GRACE_S = 12  # a villager someone touched this recently won't be sent to bed by hand
# How old the villagers' states may be when a browser asks for news. Anything this server does
# itself (waking, putting to bed, a conversation starting) shows at once whatever this says; only
# what another container wrote (the brain noting a new file, say) can be this late. At 1 s every
# browser's every request read all nine entries from the Dict, the first thing to give out under
# load.
NEWS_AGE_S = 4.0
WORKER_THREADS = 80  # requests handled at once (the default is 40)


class TalkBody(BaseModel):
    message: str = Field(min_length=1, max_length=600)
    player: str = Field(default="Visitor", max_length=24)
    look: dict[str, int] | None = None  # the character chosen on the title screen


class ArcadeBody(BaseModel):
    move: str = Field(default="look", max_length=16)


class RebuildBody(BaseModel):
    snapshot: str | None = "latest"  # "latest", a snapshot ID from the history, or null for a fresh home


def public_state(homes: Homes, vid: str, st: dict) -> dict:
    villager = world.get(vid)
    return {
        "status": st["status"],
        "runtime": homes.runtime_of(vid),
        # the file they show the world: what was last read from the sandbox, or day one's copy
        "exhibit": st["exhibit"] if st.get("exhibit") is not None else villager.exhibit_on_day_one(),
        "sandbox_id": st["sandbox_id"],
        "snapshot_id": st["snapshot_id"],
        "snapshots": st["snapshots"],
        "files": st["files"],
        "wake_ms": st["wake_ms"],
        "woke_from": st["woke_from"],
        "snapshot_ms": st["snapshot_ms"],
        "wakes": st["wakes"],
        "busy": st["busy_until"] > time.time(),
        "mail": len(st["mail"]),
    }


class _Static(StaticFiles):
    """The game's files, checked for a newer copy every time (they are small, and the check is
    answered "unchanged" from the ETag). Without this a browser may keep yesterday's scripts for
    a while after a redeploy and run them against today's server."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers.setdefault("Cache-Control", "no-cache")
        return response


def create_app(
    homes: Homes | None = None,
    think: Callable[..., Iterator[dict]] | None = None,
    *,
    access_key: str | None = None,
    info: dict | None = None,
    town: Town | None = None,
    villages: Villages | None = None,
    shard_urls: Callable[[], list[str]] | None = None,
) -> FastAPI:
    """The game. Pass `villages` for a village per visitor; or `homes` (and `think` or `town`)
    for one village that everybody shares."""
    @contextlib.asynccontextmanager
    async def lifespan(_app):
        import anyio.to_thread

        anyio.to_thread.current_default_thread_limiter().total_tokens = WORKER_THREADS
        yield

    app = FastAPI(title="Sandbox Village", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    if villages is None:
        town = town or Town(homes, think)
        villages = Villages(lambda _id: (homes, town), shared=True)
        app.state.town = town
    villages.start()
    app.state.villages = villages
    if villages.shards > 1:
        # the page comes from one container and talks to whichever holds its village: another origin.
        # There are no cookies to protect; a village is reached by knowing its ID.
        app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"], max_age=3600)

    def here(request: Request) -> Village:
        """The village this request is about: the visitor's own, named in a header."""
        return villages.get(request.headers.get("x-village"))

    Here = Depends(here)

    @app.middleware("http")
    async def gate(request: Request, call_next):
        # Optional shared key, so a public URL doesn't let anyone spend the model budget.
        # (A browser's preflight carries no headers of ours and reaches nothing: it is let by.)
        if access_key and request.url.path.startswith("/api/") and request.method != "OPTIONS":
            if not hmac.compare_digest(request.headers.get("x-village-key", "").encode(), access_key.encode()):
                return JSONResponse({"error": "locked", "message": "This village needs a key. Add ?key=... to the URL."}, status_code=401)
        return await call_next(request)

    @app.exception_handler(VillageFull)
    async def _full(request: Request, exc: VillageFull):
        return JSONResponse({"error": "full", "message": str(exc)}, status_code=503)

    @app.exception_handler(WrongShard)
    async def _elsewhere(request: Request, exc: WrongShard):
        return JSONResponse({"error": "shard", "message": str(exc)}, status_code=421)

    @app.exception_handler(NoSuchVillage)
    async def _which(request: Request, exc: NoSuchVillage):
        return JSONResponse({"error": "village", "message": str(exc)}, status_code=400)

    @app.exception_handler(HomeGone)
    async def _gone(request: Request, exc: HomeGone):
        return JSONResponse({"error": "asleep", "message": str(exc)}, status_code=409)

    @app.exception_handler(HomeRubble)
    async def _rubble(request: Request, exc: HomeRubble):
        return JSONResponse({"error": "rubble", "message": str(exc)}, status_code=409)

    @app.exception_handler(HomeError)
    async def _home_error(request: Request, exc: HomeError):
        return JSONResponse({"error": "home", "message": str(exc)}, status_code=400)

    def villager(vid: str) -> world.Villager:
        try:
            return world.get(vid)
        except KeyError:
            raise HTTPException(404, f"no villager named {vid}") from None

    @app.get("/api/shards")
    def get_shards():
        """Where a browser should send its requests: the web containers, which one this is, and
        how full each is. With one container the answer is "here"."""
        urls = (shard_urls() if shard_urls else None) or [""] * villages.shards
        return {"count": villages.shards, "mine": villages.shard, "urls": urls, "room": villages.room(), "per_visitor": not villages.shared}

    @app.get("/api/world")
    def get_world(village: Village = Here):
        homes, town = village.homes, village.town
        return {
            "villagers": [{**v.public(), "runtime": homes.runtime_of(v.id), "common_tools": [tool["function"]["name"] for tool in COMMON_TOOLS]} for v in world.VILLAGERS],
            "runtime": homes.runtime_label,
            "info": info or {},
            "idle_s": town.idle_s,
            "brains": town.brain_stats(),
            "last_event": town.last_id(),
            # whose village this is, and how many are in use
            "village": {"id": village.id or None, "created": village.created, "talks_per_hour": town.talks_per_hour, **villages.stats()},
        }

    @app.get("/api/state")
    def get_state(after: int = 0, near: str = "", active: int = 0, village: Village = Here):
        """Everything a browser needs every couple of seconds: each villager's sandbox state,
        what has happened since it last asked, and who is out visiting whom."""
        homes, town = village.homes, village.town
        town.presence([vid for vid in near.split(",") if vid], bool(active))
        now = time.time()
        away = set(town.whereabouts) | set(town.whereabouts.values())
        villagers = {}
        for vid, st in homes.all_states(max_age=NEWS_AGE_S).items():
            resting = st["status"] == "awake" and st["busy_until"] < now and vid not in away
            # seconds until the watchman puts them to bed, if nobody comes near before then
            villagers[vid] = {**public_state(homes, vid, st), "sleeps_in": round(max(0.0, town.idle_s - (now - st["last_active"])), 1) if resting else None}
        return {
            "villagers": villagers,
            "events": town.since(after),
            "whereabouts": dict(town.whereabouts),
            "brains": [{key: brain[key] for key in ("key", "requests", "tokens_in", "tokens_out", "avg_ms")} for brain in town.brain_stats()],
            "weather": town.current_weather(),
            "installations": [{key: piece[key] for key in ("id", "slot", "name", "by")} for piece in town.installations],
            "now": time.time(),
        }

    @app.get("/api/brains")
    def get_brains(village: Village = Here):
        return village.town.brain_stats()

    @app.get("/api/installations/{piece_id}")
    def get_installation(piece_id: str, village: Village = Here):
        for piece in village.town.installations:
            if piece["id"] == piece_id:
                return piece
        raise HTTPException(404, "that pedestal is empty")

    @app.post("/api/villagers/{vid}/arcade")
    def arcade_move(vid: str, body: ArcadeBody, village: Village = Here):
        """One move on the TV in a villager's house. The game itself runs in their sandbox."""
        if not villager(vid).tv:
            raise HTTPException(404, "there is no TV in that house")
        return arcade.play(village.homes, vid, body.move)

    @app.post("/api/wake-all")
    def wake_all(village: Village = Here):
        return village.town.wake_everyone()

    @app.post("/api/villagers/{vid}/wake")
    def wake(vid: str, village: Village = Here):
        villager(vid)
        return public_state(village.homes, vid, village.homes.wake(vid))

    @app.post("/api/villagers/{vid}/sleep")
    def sleep(vid: str, village: Village = Here):
        villager(vid)
        homes = village.homes
        st = homes.state(vid)
        if st["busy_until"] > time.time() or time.time() - st["last_active"] < SLEEP_GRACE_S or vid in village.town.whereabouts:
            return JSONResponse({"error": "busy", "message": "Someone is still with them."}, status_code=409)
        return public_state(homes, vid, homes.sleep(vid))

    @app.post("/api/villagers/{vid}/rebuild")
    def rebuild(vid: str, body: RebuildBody, village: Village = Here):
        villager(vid)
        village.homes.rebuild(vid, body.snapshot)
        return public_state(village.homes, vid, village.homes.state(vid))

    @app.post("/api/villagers/{vid}/dare")
    def dare(vid: str, village: Village = Here):
        """A villager who can be dared deletes their own computer (homes.demolish)."""
        if not villager(vid).dare:
            raise HTTPException(404, "they will not be dared")
        st = village.homes.demolish(vid)
        return {**public_state(village.homes, vid, st), "dare": st["dare"]}

    @app.get("/api/villagers/{vid}/files")
    def files(vid: str, village: Village = Here):
        villager(vid)
        homes = village.homes
        entries = homes.list_files(vid)
        homes.touch(vid)
        return {"home": homes.home(vid), "files": entries}

    @app.get("/api/villagers/{vid}/file")
    def file(vid: str, path: str, village: Village = Here):
        villager(vid)
        return village.homes.read_file(vid, path)

    @app.get("/api/library")
    def get_library(village: Village = Here):
        """The shared shelf: read straight from the Volume, whoever is awake or asleep."""
        homes = village.homes
        return {"files": homes.library(), "where": homes.library_label, "path": homes.library_path}

    @app.get("/api/library/{by}/{name}")
    def get_library_file(by: str, name: str, village: Village = Here):
        return village.homes.library_file(by, name)

    @app.post("/api/villagers/{vid}/talk")
    def talk(vid: str, body: TalkBody, village: Village = Here):
        villager(vid)
        town = village.town

        def events() -> Iterator[str]:
            for event in town.talk(vid, body.message, body.player, body.look):
                yield f"data: {json.dumps(event)}\n\n"

        return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/", include_in_schema=False)
    def page(request: Request):
        """The page itself, with the address it was asked for written into its link-preview
        tags (previews want whole addresses, and only the request knows the domain)."""
        host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
        if not re.fullmatch(r"[A-Za-z0-9.-]+(:\d+)?", host):
            host = ""
        scheme = "http" if host.split(":")[0] in ("localhost", "127.0.0.1") else "https"
        html = (STATIC_DIR / "index.html").read_text().replace("__ORIGIN__", f"{scheme}://{host}" if host else "")
        return HTMLResponse(html, headers={"Cache-Control": "no-cache"})

    app.mount("/", _Static(directory=STATIC_DIR, html=True), name="static")
    return app
