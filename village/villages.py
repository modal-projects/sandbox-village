"""One village per visitor.

A visitor's browser makes up an ID the first time it opens the game and sends it with every
request. Everything a village is made of hangs off that ID: its villagers' states and snapshots
(each key with "<id>/" in front), its own director and record of events, and its
own folder on the library Volume. Two visitors never see each other's villagers.

`Villages` hands out the village for an ID, making it the first time, and keeps the bill bounded:
only so many villages may be in use at once, a village nobody has looked at for a while is put
away (its sandboxes are already asleep by then), and one nobody has come back to in a week is
deleted. With `shared=True` there is one village for everybody.
"""

from __future__ import annotations

import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from . import world
from .homes import Homes
from .town import Town

ID = re.compile(r"[a-z0-9]{8,40}")
SHARED = ""  # the ID of the one village everybody gets when villages are not per visitor
MARK = "_village"  # the key, inside a village, that says when it was made and last used
IN_USE_S = 120.0  # a village somebody polled this recently counts as in use
REST_S = 600.0  # one nobody has polled for this long is put away
FORGET_S = 7 * 24 * 3600.0  # one nobody has come back to for this long is deleted


def shard_of(village_id: str, shards: int) -> int:
    """Which web container a village lives in. The first character of its ID says, so a browser
    making up a new ID can choose where it goes (static/js/api.js does the same sum)."""
    return int(village_id[0], 36) % shards if shards > 1 and village_id else 0


class WrongShard(Exception):
    """This village lives in another of the web containers."""


class VillageFull(Exception):
    """Too many villages are in use right now."""


class NoSuchVillage(Exception):
    """The request did not say which village, or said something that is not an ID."""


class ScopedStore:
    """A village's own corner of the state store: every key gets the village's ID in front."""

    def __init__(self, store, village: str) -> None:
        self.store = store
        self.prefix = f"{village}/" if village else ""

    def get(self, key: str, max_age: float = 0.0):
        return self.store.get(self.prefix + key, max_age)

    def get_many(self, keys: list[str], max_age: float = 0.0) -> dict:
        kept = self.store.get_many([self.prefix + key for key in keys], max_age)
        return {key: kept.get(self.prefix + key) for key in keys}

    def put(self, key: str, state) -> None:
        self.store.put(self.prefix + key, state)


@dataclass
class Village:
    id: str
    homes: Homes
    town: Town
    created: float = field(default_factory=time.time)
    seen: float = field(default_factory=time.time)
    marked: float = 0.0  # when `seen` was last written to the store


class Villages:
    def __init__(self, make: Callable[[str], tuple[Homes, Town]], store=None, *, shared: bool = False, max_in_use: int = 50, shard: int = 0, shards: int = 1, on_arrival: Callable[[str], None] | None = None) -> None:
        """`make(village_id)` builds a village's homes and town. `store` is the unscoped state
        store, used to remember which villages exist; without one, nothing outlasts the process.

        One web container can keep up with about 50 visitors, so a deployment may run several
        (`shards`), each holding the villages whose IDs point at it (`shard`) and allowing
        `max_in_use` of them at once. The containers do not talk to each other; each writes how
        full it is to the store, so a browser can be told where there is room."""
        self.shard, self.shards = shard, max(1, shards)
        self.on_arrival = on_arrival  # called, off to one side, when somebody arrives in a village
        self._make = make
        self.store = store
        self.shared = shared
        self.max_in_use = max_in_use
        self._open: dict[str, Village] = {}
        self._lock = threading.Lock()
        self._sweeper: threading.Thread | None = None

    # ---- finding a visitor's village ------------------------------------------------------------

    def get(self, village_id: str | None) -> Village:
        village_id = SHARED if self.shared else (village_id or "").strip().lower()
        if not self.shared and not ID.fullmatch(village_id):
            raise NoSuchVillage("Say which village: the X-Village header should be 8 to 40 letters and digits.")
        if not self.shared and shard_of(village_id, self.shards) != self.shard:
            raise WrongShard(f"That village lives in container {shard_of(village_id, self.shards)}, and this is {self.shard}.")
        now = time.time()
        with self._lock:
            village = self._open.get(village_id)
            arriving = village is None or now - village.seen > IN_USE_S
            if arriving:
                # somebody is arriving (or coming back after a pause): is there room?
                if not self.shared and self.in_use(now) >= self.max_in_use:
                    raise VillageFull(f"All {self.max_in_use} villages are busy just now. Try again in a few minutes.")
            if village is None:
                homes, town = self._make(village_id)
                village = Village(village_id, homes, town)
                kept = self._mark_of(village_id)
                village.created = (kept or {}).get("created", now)
                self._open[village_id] = village
                town.start()
                if village_id != SHARED:
                    threading.Thread(target=self._prepare, args=(homes,), daemon=True, name="village-prepare").start()
            village.seen = now
        if arriving and self.on_arrival:
            # They will not speak to anyone for some seconds yet: time to get the brain ready.
            threading.Thread(target=self._announce, args=(village_id,), daemon=True, name="village-arrival").start()
        if now - village.marked > 60:
            village.marked = now
            self._write_mark(village)
        return village

    def _announce(self, village_id: str) -> None:
        try:
            self.on_arrival(village_id)
        except Exception as exc:  # the first conversation is slower, that is all
            print("announcing an arrival:", type(exc).__name__, exc)

    @staticmethod
    def _prepare(homes: Homes) -> None:
        try:
            homes.prepare()
        except Exception as exc:  # the first wake will do it instead
            print("preparing a village:", type(exc).__name__, exc)

    def in_use(self, now: float | None = None) -> int:
        now = now or time.time()
        return sum(1 for village in self._open.values() if now - village.seen <= IN_USE_S)

    def stats(self) -> dict:
        return {"per_visitor": not self.shared, "in_use": self.in_use(), "room_for": self.max_in_use, "open": len(self._open), "shard": self.shard, "shards": self.shards}

    def publish(self) -> None:
        """Write down how full this container is, for the others to tell browsers."""
        if self.store is not None and self.shards > 1:
            self.store.put(f"_shards/{self.shard}", {"in_use": self.in_use(), "at": time.time()})

    def room(self) -> list[dict]:
        """How full each container is: [{"in_use", "room_for"}]. One that has not reported in a
        while has no container running, which means nobody is in it."""
        now = time.time()
        kept = self.store.get_many([f"_shards/{n}" for n in range(self.shards)], 5.0) if self.store is not None and self.shards > 1 else {}
        found = []
        for n in range(self.shards):
            entry = kept.get(f"_shards/{n}") or {}
            in_use = self.in_use() if n == self.shard else entry.get("in_use", 0) if now - entry.get("at", 0) < 45 else 0
            found.append({"in_use": in_use, "room_for": self.max_in_use})
        return found

    # ---- putting villages away ------------------------------------------------------------------

    def start(self) -> None:
        if self._sweeper is None and not self.shared:
            self._sweeper = threading.Thread(target=self._run, daemon=True, name="villages-sweeper")
            self._sweeper.start()

    def _run(self) -> None:
        beat = 0
        while True:
            time.sleep(10)
            beat += 1
            try:
                self.publish()
                if beat % 3:
                    continue
                self.rest()
            except Exception as exc:
                if type(exc).__name__ == "ClientClosed":
                    return
                print("villages:", type(exc).__name__, exc)

    def rest(self, now: float | None = None) -> list[str]:
        """Put away villages nobody has looked at for a while. Their villagers have long been in
        bed by then (the town's own watchman does that after a minute or so); if any is somehow
        still up, the village stays open until it is not."""
        now = now or time.time()
        put_away = []
        for village in list(self._open.values()):
            if village.id == SHARED or now - village.seen < REST_S:
                continue
            if any(st["status"] == "awake" for st in village.homes.all_states().values()):
                village.homes.sleep_idle(0)
                continue
            village.town.stop()
            self._write_mark(village)
            with self._lock:
                self._open.pop(village.id, None)
            put_away.append(village.id)
        return put_away

    # ---- remembering, and forgetting --------------------------------------------------------------

    def _mark_of(self, village_id: str) -> dict | None:
        if self.store is None or village_id == SHARED:
            return None
        try:
            return self.store.get(f"{village_id}/{MARK}")
        except Exception:
            return None

    def _write_mark(self, village: Village) -> None:
        if self.store is None or village.id == SHARED:
            return
        try:
            self.store.put(f"{village.id}/{MARK}", {"created": village.created, "seen": village.seen})
        except Exception:
            pass

    def known(self) -> dict[str, dict]:
        """Every village the store remembers: {id: {"created", "seen"}}."""
        if self.store is None:
            return {}
        found = {}
        for key in self.store.keys():
            village_id, _, rest = key.partition("/")
            if rest == MARK:
                found[village_id] = self.store.get(key) or {}
        return found

    def watch(self, idle_s: float) -> list[str]:
        """What a scheduled job does when the web server may not be running: put to bed whoever
        is still up in any village, and delete villages nobody has come back to in a week.
        Returns what it did, for the log."""
        did = []
        now = time.time()
        for village_id, mark in self.known().items():
            if village_id in self._open:
                continue
            homes, _ = self._make(village_id)
            if now - mark.get("seen", now) > FORGET_S:
                self.forget(village_id, homes)
                did.append(f"deleted {village_id}")
                continue
            for vid in homes.sleep_idle(idle_s):
                did.append(f"{village_id}/{vid} to bed")
        return did

    def forget(self, village_id: str, homes: Homes) -> None:
        """Delete a village: stop anything still running, empty its folder in the library, and
        remove its entries from the store. Its snapshots expire on their own."""
        for vid in world.BY_ID:
            try:
                st = homes.state(vid)
                if st.get("sandbox_id"):
                    homes._terminate_quietly(st["sandbox_id"])
            except Exception:
                pass
        try:
            homes.clear_library()
        except Exception:
            pass
        for key in [key for key in self.store.keys() if key.startswith(f"{village_id}/")]:
            self.store.delete(key)
