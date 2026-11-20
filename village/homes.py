"""Homes: every villager's home is a sandbox that sleeps as a filesystem snapshot.

`Homes` is the state machine (wake, sleep, run a command, list the shelves, rebuild after a
disaster). Subclasses supply the handful of primitives that touch a real sandbox:

- `ModalHomes`  one Modal Sandbox per villager (what the demo runs on)
- `LocalHomes`  temp directories on this machine, for tests and offline UI work (see fakes.py)

A sleeping villager has no sandbox at all, only a snapshot image ID in the state store. Waking
creates a new sandbox from that image; going to sleep snapshots the filesystem and terminates it.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import posixpath
import re
import shlex
import threading
import time
from collections import defaultdict
from dataclasses import dataclass

from . import knowledge, world

MAX_READ_BYTES = 256 * 1024
# The most one command may send back. A command is whatever a model wrote, and `yes` alone
# writes 20 MB a second: what is read here ends up in the memory of the server that asked.
MAX_OUTPUT_BYTES = 1024 * 1024
MAX_SNAPSHOTS_KEPT = 6
LIBRARY_KEEP = 12  # how many of each villager's things stay on the shared shelf


class HomeError(Exception):
    """Something went wrong inside a home."""


class HomeGone(HomeError):
    """The sandbox is not running (the villager is asleep, or the sandbox timed out)."""


class HomeRubble(HomeError):
    """The sandbox's own system files were destroyed. Only a rebuild helps."""


@dataclass
class ExecResult:
    rc: int
    output: str
    ms: int


def blank_state() -> dict:
    return {
        "status": "asleep",  # asleep | awake | rubble
        "sandbox_id": None,
        "snapshot_id": None,  # image the next wake starts from; None = build a fresh home
        "snapshots": [],  # newest first: {"id", "at", "files"}
        "files": None,
        "wake_ms": None,
        "woke_from": None,  # "snapshot" | "fresh"
        "snapshot_ms": None,
        "wakes": 0,
        "last_active": 0.0,
        "busy_until": 0.0,
        "mail": [],  # files waiting to be put into the home the next time it wakes: {"path", "content"}
        "exhibit": None,  # the last lines of the file this villager shows the world (None: never read yet)
    }


class MemoryStore:
    """Villager state kept in this process. Fine for one server; tests use it too."""

    def __init__(self) -> None:
        self._data: dict[str, dict] = {}
        self._lock = threading.Lock()

    def get(self, vid: str, max_age: float = 0.0) -> dict | None:
        with self._lock:
            return copy.deepcopy(self._data.get(vid))

    def put(self, vid: str, state: dict) -> None:
        with self._lock:
            self._data[vid] = copy.deepcopy(state)

    def get_many(self, keys: list[str], max_age: float = 0.0) -> dict:
        return {key: self.get(key, max_age) for key in keys}

    def keys(self) -> list[str]:
        with self._lock:
            return list(self._data)

    def delete(self, key: str) -> None:
        with self._lock:
            self._data.pop(key, None)


class ModalDictStore:
    """Villager state in a modal.Dict, so the web server, the brain and the night watchman
    (three different Modal functions) all see the same village."""

    def __init__(self, name: str = "sandbox-village-state") -> None:
        import modal

        self._dict = modal.Dict.from_name(name, create_if_missing=True)
        self._cache: dict[str, tuple[float, dict | None]] = {}

    def get(self, vid: str, max_age: float = 0.0) -> dict | None:
        hit = self._cache.get(vid)
        if hit and max_age and time.monotonic() - hit[0] <= max_age:
            return copy.deepcopy(hit[1])
        value = self._dict.get(vid)
        self._cache[vid] = (time.monotonic(), value)
        return copy.deepcopy(value)

    def put(self, vid: str, state: dict) -> None:
        self._dict.put(vid, state)
        self._cache[vid] = (time.monotonic(), copy.deepcopy(state))

    _readers = None  # a few threads shared by every store, for reading several entries at once

    def get_many(self, keys: list[str], max_age: float = 0.0) -> dict:
        """Several entries at once. Those read less than `max_age` seconds ago come from memory;
        the rest are fetched side by side, so nine villagers take about as long as one."""
        now = time.monotonic()
        found, stale = {}, []
        for key in keys:
            hit = self._cache.get(key)
            if hit and max_age and now - hit[0] <= max_age:
                found[key] = copy.deepcopy(hit[1])
            else:
                stale.append(key)
        if len(stale) == 1:
            found[stale[0]] = self.get(stale[0])
        elif stale:
            if ModalDictStore._readers is None:
                from concurrent.futures import ThreadPoolExecutor

                ModalDictStore._readers = ThreadPoolExecutor(max_workers=48, thread_name_prefix="village-state")
            for key, value in zip(stale, ModalDictStore._readers.map(self.get, stale), strict=True):
                found[key] = value
        return found

    def keys(self) -> list[str]:
        return [key for key in self._dict.keys() if isinstance(key, str)]

    def delete(self, key: str) -> None:
        self._dict.pop(key, None)
        self._cache.pop(key, None)


# Every command starts in the home directory, with stderr folded into stdout. If the home
# directory itself was deleted it is recreated empty, so the next command still has a place to run.
_PREAMBLE = 'exec 2>&1\nmkdir -p "$HOME" 2>/dev/null; cd "$HOME" 2>/dev/null || cd /\n'

# One command answers "is this home usable, and how much is in it?"
_PROBE = """
echo "files=$(find . -mindepth 1 2>/dev/null | wc -l)"
"""


def _library_script(villager: world.Villager) -> str:
    """Shell that puts a villager's reference books on the shelf if they are missing or out of
    date. Runs at every wake, so a home snapshotted before a book was written still gets it."""
    lines = []
    for path, text in villager.library.items():
        quoted = shlex.quote(path)
        digest = hashlib.md5(text.encode()).hexdigest()
        encoded = base64.b64encode(text.encode()).decode()
        lines.append(f"[ \"$(md5sum {quoted} 2>/dev/null | cut -c1-32)\" = {digest} ] || {{ mkdir -p \"$(dirname {quoted})\" && base64 -d > {quoted} <<'B64'\n{encoded}\nB64\n}}")
    return "\n".join(lines) + "\n" if lines else ""


def _move_in_script(villager: world.Villager) -> str:
    """Shell that writes a villager's day-one files into an empty home."""
    lines = []
    for path, text in villager.seed_files.items():
        quoted = shlex.quote(path)
        encoded = base64.b64encode(text.encode()).decode()
        lines.append(f"mkdir -p \"$(dirname {quoted})\" && base64 -d > {quoted} <<'B64'\n{encoded}\nB64")
    return "\n".join(lines) + "\n"


_MIME = {
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}


def _entry(rel: str, size: int, data: bytes) -> dict:
    """What the game shows for one file: its name, size, and its contents as text or a picture."""
    entry = {"path": rel, "name": posixpath.basename(rel), "size": size, "truncated": size > len(data)}
    mime = _MIME.get(posixpath.splitext(rel)[1].lower())
    if mime:
        entry.update(mime=mime, base64=base64.b64encode(data).decode())
        if mime == "image/svg+xml":
            entry["text"] = data.decode("utf-8", "replace")
        return entry
    try:
        entry.update(mime="text/plain", text=data.decode("utf-8"))
    except UnicodeDecodeError:
        entry.update(mime="application/octet-stream", text=None)
    return entry


class Homes:
    """Wake, sleep and use villager homes. Subclasses implement the `_`-prefixed primitives."""

    runtime_label = "unknown"
    village = ""  # whose village these homes are in ("" when everybody shares one)
    keep_snapshots = MAX_SNAPSHOTS_KEPT  # how many of each home's snapshots to remember
    snapshot_ttl_s: int | None = None  # how long a snapshot is stored (None: the platform's default)

    def __init__(self, store) -> None:
        self.store = store
        self._locks: dict[str, threading.RLock] = defaultdict(threading.RLock)
        self._stocking: dict[str, threading.Lock] = defaultdict(threading.Lock)  # one unpacking per home at a time
        self._shelf: tuple[float, list[dict]] | None = None  # the library's listing, kept for a few seconds

    # ---- primitives (one real sandbox operation each) ------------------------------------

    def home(self, vid: str) -> str:
        return world.get(vid).home

    def runtime_of(self, vid: str) -> str:
        """What kind of sandbox this villager's home is, in words."""
        own = world.get(vid).runtime
        return {"vm": "VM", "gvisor": "gVisor"}.get(own, own) if own else self.runtime_label

    def _create(self, vid: str, snapshot_id: str | None) -> str:
        raise NotImplementedError

    def _alive(self, handle: str) -> bool:
        raise NotImplementedError

    def _exec(self, handle: str, vid: str, script: str, timeout: int) -> ExecResult:
        raise NotImplementedError

    def _write(self, handle: str, vid: str, path: str, data: bytes) -> None:
        raise NotImplementedError

    def _snapshot(self, handle: str) -> str:
        raise NotImplementedError

    def _terminate(self, handle: str) -> None:
        raise NotImplementedError

    def _ruin(self, handle: str, vid: str) -> None:
        """Have the home delete its own system files (see `demolish`)."""
        raise NotImplementedError


    # ---- state -----------------------------------------------------------------------------

    def state(self, vid: str, max_age: float = 0.0) -> dict:
        world.get(vid)  # KeyError for unknown villagers
        return {**blank_state(), **(self.store.get(vid, max_age) or {})}

    def all_states(self, max_age: float = 0.0) -> dict[str, dict]:
        kept = self.store.get_many([v.id for v in world.VILLAGERS], max_age)
        return {v.id: {**blank_state(), **(kept.get(v.id) or {})} for v in world.VILLAGERS}

    def _save(self, vid: str, st: dict) -> dict:
        self.store.put(vid, st)
        return st

    def touch(self, vid: str) -> None:
        st = self.state(vid)
        st["last_active"] = time.time()
        self._save(vid, st)

    def set_busy(self, vid: str, seconds: float) -> bool:
        """Mark a villager as mid-conversation. Returns False if someone else already has them."""
        with self._locks[vid]:
            st = self.state(vid)
            now = time.time()
            if seconds > 0 and st["busy_until"] > now:
                return False
            st["busy_until"] = now + seconds if seconds > 0 else 0.0
            st["last_active"] = now
            self._save(vid, st)
            return True

    # ---- lifecycle -------------------------------------------------------------------------

    def wake(self, vid: str, known_s: float = 0.0) -> dict:
        """Make sure the villager's sandbox is running, creating it from the last snapshot (or
        from scratch) if not. Returns the state, with `wake_ms` set when a sandbox was started.
        `known_s`: the caller read this villager's state less than that long ago, so it is not
        fetched again."""
        with self._locks[vid]:
            st = self.state(vid, known_s)
            if st["status"] == "rubble":
                return st
            if st["sandbox_id"] and self._alive(st["sandbox_id"]):
                st.update(status="awake", last_active=time.time())
                return self._save(vid, st)

            started = time.monotonic()
            snapshot_id = st["snapshot_id"]
            try:
                handle = self._create(vid, snapshot_id)
            except Exception:
                if not snapshot_id:
                    raise
                # The snapshot is gone (they are only stored for so long). Better a house as it was
                # on day one than no house at all.
                snapshot_id = None
                st.update(snapshot_id=None, snapshots=[])
                handle = self._create(vid, None)
            try:
                # One command does everything a new sandbox needs: a brand-new home gets its
                # day-one files, every home gets its books, and then it reports in.
                files = self._probe(handle, vid, before=("" if snapshot_id else _move_in_script(world.get(vid))) + _library_script(world.get(vid)))
            except Exception:
                self._terminate_quietly(handle)
                raise
            st.update(
                status="awake",
                sandbox_id=handle,
                wake_ms=int((time.monotonic() - started) * 1000),
                woke_from="snapshot" if snapshot_id else "fresh",
                wakes=st["wakes"] + 1,
                last_active=time.time(),
                files=files,
            )
            # Anything the post was holding goes onto the doormat now that there is a sandbox.
            waiting, st["mail"] = st["mail"], []
            for index, parcel in enumerate(waiting):
                try:
                    self._write(handle, vid, parcel["path"], parcel["content"].encode())
                except Exception:
                    st["mail"] = waiting[index:]
                    break
            saved = self._save(vid, st)
        if world.get(vid).archive:
            # their big books are checked once the house is up, so they never slow a wake
            threading.Thread(target=self._stock_quietly, args=(vid,), daemon=True, name=f"shelf-{vid}").start()
        return saved

    def sleep(self, vid: str) -> dict:
        """Snapshot the home's filesystem, then terminate the sandbox."""
        with self._locks[vid]:
            st = self.state(vid)
            handle = st["sandbox_id"]
            if handle and self._alive(handle) and not world.get(vid).keeps_snapshots:
                # This home is never saved: the sandbox is simply thrown away, and the next wake
                # builds a fresh one from the empty image.
                self._terminate_quietly(handle)
                st.update(snapshot_id=None, snapshots=[], snapshot_ms=None, exhibit=None)
            elif handle and self._alive(handle):
                try:
                    files = self._probe(handle, vid)
                except HomeRubble:
                    return self._collapse(vid, st)
                self._keep_snapshot(st, handle, files)
                self._terminate_quietly(handle)
            if st["status"] != "rubble":
                st["status"] = "asleep"
            st.update(sandbox_id=None, busy_until=0.0)
            return self._save(vid, st)

    def _keep_snapshot(self, st: dict, handle: str, files: int) -> None:
        started = time.monotonic()
        snapshot_id = self._snapshot(handle)
        st["snapshot_ms"] = int((time.monotonic() - started) * 1000)
        st["snapshot_id"] = snapshot_id
        st["snapshots"] = ([{"id": snapshot_id, "at": time.time(), "files": files}] + st["snapshots"])[: self.keep_snapshots]
        st["files"] = files

    def rebuild(self, vid: str, snapshot_id: str | None = "latest") -> dict:
        """Throw away whatever is running and wake again from a snapshot ("latest", or an ID from
        the home's snapshot history) or from scratch (None)."""
        with self._locks[vid]:
            st = self.state(vid)
            if st["sandbox_id"]:
                self._terminate_quietly(st["sandbox_id"])
            if snapshot_id == "latest":
                snapshot_id = st["snapshot_id"]
            elif snapshot_id is not None and snapshot_id not in {s["id"] for s in st["snapshots"]}:
                raise HomeError("that snapshot is not in this home's history")
            st.update(status="asleep", sandbox_id=None, snapshot_id=snapshot_id, busy_until=0.0)
            self._save(vid, st)
            woken = self.wake(vid)
        self.refresh_exhibit(vid)
        return {**woken, "exhibit": self.state(vid)["exhibit"]}

    def sleep_idle(self, max_idle_s: float, skip: set[str] | frozenset[str] = frozenset()) -> list[str]:
        """Put to sleep every villager nobody has interacted with for `max_idle_s` seconds."""
        slept = []
        now = time.time()
        for villager in world.VILLAGERS:
            if villager.id in skip:
                continue
            st = self.state(villager.id)
            if st["status"] == "awake" and st["busy_until"] < now and now - st["last_active"] > max_idle_s:
                self.sleep(villager.id)
                slept.append(villager.id)
        return slept

    def wake_all(self) -> dict:
        """Start a sandbox for every sleeping villager, all at the same time. Returns how long
        each took and how long the whole village took."""
        # Everybody's state is read in one go: one at a time, nine reads were over a second of
        # the bell doing nothing before a single sandbox had been asked for.
        asleep = [vid for vid, st in self.all_states().items() if st["status"] == "asleep"]
        woken: dict[str, dict] = {}

        def rouse(vid: str) -> None:
            try:
                st = self.wake(vid, known_s=2.0)
                woken[vid] = {"id": vid, "ms": st["wake_ms"], "from": st["woke_from"]}
            except Exception as exc:  # one house failing must not spoil the rest
                woken[vid] = {"id": vid, "error": str(exc)[:120]}

        started = time.monotonic()
        threads = [threading.Thread(target=rouse, args=(vid,), daemon=True) for vid in asleep]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=90)
        took = int((time.monotonic() - started) * 1000)
        count = sum(1 for vid in asleep if vid in woken and "error" not in woken[vid])
        return {"woken": [woken.get(vid, {"id": vid, "error": "still starting"}) for vid in asleep], "count": count, "already": len(world.VILLAGERS) - len(asleep), "ms": took}

    def stock(self, vid: str) -> bool:
        """Make sure a villager's archive (a whole folder of reading, such as Mo's GPU Glossary)
        is in their home and is the current version. Too big to send with every wake, so the
        home is asked which version it has, and the archive is only sent when that differs.
        Returns whether anything was unpacked."""
        folder = world.get(vid).archive
        if not folder:
            return False
        version, data = knowledge.ARCHIVES[folder]()
        quoted = shlex.quote(folder)
        with self._stocking[vid]:
            if self.exec(vid, f"cat {quoted}/.version 2>/dev/null", timeout=15).output.strip() == version:
                return False
            self._write(self._handle(vid), vid, ".village/shelf.tgz", data)
            done = self.exec(vid, f"rm -rf {quoted} {quoted}.md && tar xzf .village/shelf.tgz && rm -f .village/shelf.tgz && cat {quoted}/.version", timeout=40)
            if done.output.strip().splitlines()[-1:] != [version]:
                raise HomeError(f"the shelf would not take {folder}: {done.output.strip()[-160:]}")
            return True

    def _stock_quietly(self, vid: str) -> None:
        try:
            self.stock(vid)
        except Exception as exc:  # a missing book must never stop a villager waking
            print(f"stocking {vid}'s shelf: {type(exc).__name__}: {str(exc)[:160]}")

    def sidecar(self, vid: str, name: str, args: tuple[str, ...]) -> bool:
        """Make sure a sidecar container called `name`, running `args`, is up beside this
        villager's sandbox. Returns False where there are no sidecars (offline) or it failed."""
        return False

    # ---- using a home ----------------------------------------------------------------------

    def exec(self, vid: str, command: str, timeout: int = 25) -> ExecResult:
        """Run a shell command in the villager's home directory."""
        return self._run(vid, _PREAMBLE + command, timeout)

    def list_files(self, vid: str) -> list[dict]:
        result = self._run(vid, _PREAMBLE + "find . -mindepth 1 -maxdepth 4 -printf '%y\\t%s\\t%T@\\t%P\\n' 2>/dev/null | head -n 500", 20)
        entries = []
        for line in result.output.splitlines():
            parts = line.split("\t", 3)
            if len(parts) != 4:
                continue
            kind, size, mtime, path = parts
            entries.append(
                {
                    "path": path,
                    "name": posixpath.basename(path),
                    "type": "dir" if kind == "d" else "file",
                    "size": int(size) if size.isdigit() else 0,
                    "mtime": float(mtime) if mtime.replace(".", "", 1).isdigit() else 0.0,
                }
            )
        entries.sort(key=lambda e: e["path"])
        self._note_files(vid, len(entries))
        return entries

    def read_file(self, vid: str, path: str) -> dict:
        rel = self._rel(vid, path)
        script = f'f={shlex.quote(rel)}; [ -f "$f" ] || {{ echo "@@missing"; exit 0; }}; stat -c %s "$f"; head -c {MAX_READ_BYTES} "$f" | base64 -w0'
        out = self._run(vid, _PREAMBLE + script, 20).output
        head, _, body = out.partition("\n")
        if head.strip() == "@@missing" or not head.strip().isdigit():
            raise HomeError(f"there is no file at {rel}")
        return _entry(rel, int(head.strip()), base64.b64decode(body.strip() or b""))

    # ---- the library: one folder that every home shares ----------------------------------

    library_path = "/library"  # where the shared folder appears inside each home
    library_label = "a shared folder"  # what it really is, for the sign

    def shelve(self, vid: str, path: str, name: str) -> str | None:
        """Copy one of a villager's files onto the shared shelf, from inside their own home.
        Returns where it went ("bao/little-lantern.svg"), or None if there is no shelf."""
        rel = self._rel(vid, path)
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "thing"
        ending = re.sub(r"[^a-z0-9.]", "", posixpath.splitext(rel)[1].lower())[:8]  # it goes into a shell string below
        shelf = f"{vid}/{slug}{ending}"
        script = (
            f'L={shlex.quote(self.library_path)}; [ -d "$L" ] || exit 3\n'
            f'mkdir -p "$L/{vid}" && cp -- {shlex.quote(rel)} "$L/{shelf}" || exit 4\n'
            f'(cd "$L/{vid}" && ls -t | tail -n +{LIBRARY_KEEP + 1} | xargs -r rm -f --)\n'  # the oldest make way
            'sync "$L" 2>/dev/null\n'  # on a Modal Volume this commits the change, so others can see it
            f'[ -f "$L/{shelf}" ]'
        )
        if self._run(vid, _PREAMBLE + script, 30).rc != 0:
            return None
        self._shelf = None
        return shelf

    def library(self, max_age: float = 3.0) -> list[dict]:
        """Everything on the shared shelf, newest first: [{by, name, size, at}]. Read from
        outside, so it works when every villager is asleep."""
        kept = self._shelf
        if kept and time.time() - kept[0] < max_age:
            return kept[1]
        files = []
        try:
            listing = self._library_list()
        except Exception:  # no shelf today: the village carries on without it
            listing = []
        for path, size, mtime in listing:
            by, _, name = path.strip("/").partition("/")
            if by in world.BY_ID and name and "/" not in name and not name.startswith("."):
                files.append({"by": by, "name": name, "size": int(size), "at": float(mtime)})
        files.sort(key=lambda entry: -entry["at"])
        self._shelf = (time.time(), files)
        return files

    def library_file(self, by: str, name: str) -> dict:
        if by not in world.BY_ID or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,60}", name) or ".." in name:
            raise HomeError("there is nothing by that name on the shelf")
        try:
            data = self._library_read(f"{by}/{name}")
        except Exception:
            raise HomeError("there is nothing by that name on the shelf") from None
        return {**_entry(f"{by}/{name}", len(data), data[:MAX_READ_BYTES]), "by": by}

    def prepare(self) -> None:
        """Anything a brand-new village needs before its first house starts. Done in the
        background when the village is made, so the first wake does not wait for it."""

    def clear_library(self) -> None:
        """Empty this village's shelf (when the village itself is being deleted)."""
        self._shelf = None
        self._library_clear()

    def _library_list(self) -> list[tuple[str, int, float]]:
        return []

    def _library_read(self, path: str) -> bytes:
        raise HomeError("there is no library here")

    def _library_clear(self) -> None:
        pass

    def write_file(self, vid: str, path: str, content: str) -> str:
        rel = self._rel(vid, path)
        handle = self._handle(vid)
        self._guard(vid, lambda: self._write(handle, vid, rel, content.encode()))
        return rel

    def deliver(self, vid: str, path: str, content: str) -> bool:
        """Put a file into a villager's home from outside (a letter, a present). A sleeping
        villager has no sandbox to write to, so the file waits and arrives when they next wake.
        Returns True if it was written straight away."""
        rel = self._rel(vid, path)
        with self._locks[vid]:
            st = self.state(vid)
            if st["status"] == "awake" and st["sandbox_id"]:
                try:
                    self._write(st["sandbox_id"], vid, rel, content.encode())
                    return True
                except Exception:
                    pass  # fall through and hold it for the next wake
            st["mail"] = (st["mail"] + [{"path": rel, "content": content[:20000]}])[-12:]
            self._save(vid, st)
            return False

    def refresh_exhibit(self, vid: str) -> str | None:
        """Read the file this villager shows the world (a garden plot, a chronicle, a ledger) out
        of their sandbox and remember its last lines, so the village can still show it while
        they sleep. Returns the text, or None if they have nothing on show or are not awake."""
        villager = world.get(vid)
        st = self.state(vid)
        if not villager.exhibit or st["status"] != "awake" or not st["sandbox_id"]:
            return None
        try:
            text = self.exec(vid, f"tail -n 14 {shlex.quote(villager.exhibit)} 2>/dev/null | head -c 1500", timeout=10).output
        except HomeError:
            return None
        with self._locks[vid]:
            st = self.state(vid)
            if st["exhibit"] != text:
                st["exhibit"] = text
                self._save(vid, st)
        return text

    def demolish(self, vid: str) -> dict:
        """The dare: a villager deletes their own computer, for real.

        The running home is saved first (a filesystem snapshot, as before anything risky), then
        the sandbox deletes its own system files. With no shell left it is rubble, and stays so
        until `rebuild` starts a new sandbox from that snapshot. Nothing outside the one sandbox
        is touched: not the neighbours, not the library. Returns the state, plus `dare`: what
        was run and how long the saving and the deleting took."""
        with self._locks[vid]:
            st = self.state(vid)
            handle = self._handle(vid)
            saved_ms = None
            if world.get(vid).keeps_snapshots:
                self._keep_snapshot(st, handle, self._probe(handle, vid))
                saved_ms = st["snapshot_ms"]
                self._save(vid, st)
            started = time.monotonic()
            self._ruin(handle, vid)
            took = int((time.monotonic() - started) * 1000)
            st = self._collapse(vid, st)
            st["exhibit"] = ""
            self._save(vid, st)
        return {**st, "dare": {"command": world.DARE_COMMAND, "ms": took, "saved_ms": saved_ms}}

    # ---- internals -------------------------------------------------------------------------

    def _handle(self, vid: str) -> str:
        st = self.state(vid)
        if st["status"] == "rubble":
            raise HomeRubble(f"{world.get(vid).name}'s home is rubble")
        if not st["sandbox_id"]:
            raise HomeGone(f"{world.get(vid).name} is asleep")
        return st["sandbox_id"]

    def _rel(self, vid: str, path: str) -> str:
        """Model- and player-supplied paths are untrusted: confine them to the home directory."""
        home = self.home(vid)
        raw = (path or "").strip()
        if raw.startswith("~/"):
            raw = raw[2:]
        elif raw == "~":
            raw = "."
        elif raw.startswith(home + "/"):
            raw = raw[len(home) + 1 :]
        elif raw == home:
            raw = "."
        rel = posixpath.normpath(raw)
        if rel in ("", ".") or rel.startswith("/") or rel == ".." or rel.startswith("../"):
            raise HomeError("that path is not inside the home")
        return rel

    def _probe(self, handle: str, vid: str, before: str = "") -> int:
        out = self._exec(handle, vid, _PREAMBLE + before + _PROBE, 30).output
        last = out.strip().splitlines()[-1] if out.strip() else ""
        fields = dict(part.split("=", 1) for part in last.split() if "=" in part)
        if "files" not in fields:
            raise HomeError(f"the home did not answer: {out.strip()[-200:]}")
        return int(fields["files"])

    def _run(self, vid: str, script: str, timeout: int) -> ExecResult:
        handle = self._handle(vid)
        return self._guard(vid, lambda: self._exec(handle, vid, script, timeout))

    def _guard(self, vid: str, call):
        """Run one sandbox operation, turning 'the sandbox is gone' and 'the sandbox destroyed
        itself' into state changes the game can show."""
        try:
            return call()
        except HomeRubble:
            with self._locks[vid]:
                self._collapse(vid, self.state(vid))
            raise
        except HomeError:
            raise
        except Exception as exc:
            with self._locks[vid]:
                st = self.state(vid)
                if st["sandbox_id"] and not self._alive(st["sandbox_id"]):
                    st.update(status="asleep", sandbox_id=None, busy_until=0.0)
                    self._save(vid, st)
                    raise HomeGone(f"{world.get(vid).name}'s sandbox stopped") from exc
            raise HomeError(f"{type(exc).__name__}: {exc}") from exc

    def _collapse(self, vid: str, st: dict) -> dict:
        if st["sandbox_id"]:
            self._terminate_quietly(st["sandbox_id"])
        st.update(status="rubble", sandbox_id=None, files=0, busy_until=0.0)
        return self._save(vid, st)

    def _note_files(self, vid: str, count: int) -> None:
        with self._locks[vid]:
            st = self.state(vid)
            if st["files"] != count:
                st["files"] = count
                self._save(vid, st)

    def _terminate_quietly(self, handle: str) -> None:
        try:
            self._terminate(handle)
        except Exception:
            pass


class ModalHomes(Homes):
    """One Modal Sandbox per villager.

    Each sandbox gets a quarter of a CPU and 512 MiB (one core and 1 GiB at most), and no network in or out. `runtime` picks the isolation
    technology for the village: None lets Modal choose, or pass "gvisor" or "vm". A villager can
    ask for their own in world.py (the robot lives in a VM).
    """

    # Runs as the sandbox's main process: it only has to stay alive. Everything a villager does
    # arrives as a separate command.
    ENTRY = 'mkdir -p "$HOME"; cd "$HOME"; exec sleep infinity'
    # What a home may use: (asked for, never more than). Without the second number a sandbox can
    # burst to every core of its machine, and a command a model wrote is what would do it.
    CPU = (0.25, 1.0)
    MEMORY = (512, 1024)
    # Runs a script ($1) for at most $2 seconds, with its output cut off inside the sandbox so
    # that it is never sent at all.
    # - `timeout` stops the script and everything it started; without it, a script that outlived
    #   Modal's own limit carried on to its later commands. It reports 124.
    # - `head` cuts the output; a script still writing then ends with 141.
    # - `iconv -c` drops the half of a letter the cut may have left, which could not be decoded.
    # The exit code is the script's own (PIPESTATUS), not the pipeline's.
    CAPPED = f'timeout -k 2 "$2" bash -c "$1" 2>&1 | head -c {MAX_OUTPUT_BYTES} | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null; exit "${{PIPESTATUS[0]}}"'

    _apps: dict[str, object] = {}  # one lookup per app name, shared by every village's homes

    def __init__(self, store, *, app_name: str | None = "sandbox-village", runtime: str | None = None, max_life_s: int = 1800, village: str = "", library: str | None = None) -> None:
        super().__init__(store)
        import modal

        self._modal = modal
        self.village = village
        if village:  # a visitor's own village: one snapshot per home, stored for two weeks
            self.keep_snapshots = 1
            self.snapshot_ttl_s = 14 * 24 * 3600
        self.app_name = app_name
        self.runtime = runtime or None
        self.runtime_label = {"vm": "VM", "gvisor": "gVisor"}.get(runtime, "gVisor (Modal's default)")
        self.max_life_s = max_life_s
        self._app = None
        self._sandboxes: dict[str, object] = {}
        self._sidecars: set[tuple[str, str]] = set()  # (sandbox id, sidecar name) known to be up
        self._base_image = modal.Image.debian_slim(python_version="3.12").apt_install("procps", "curl")
        # The library: one Volume, mounted in every villager's sandbox. Each app has its own, so a
        # test village never writes on the real one's shelf.
        # `library` names the Volume when `app_name` cannot (deployed, it is None: "the app this
        # code runs in"), so that two deployments never share one.
        self.library_name = library or f"{app_name or 'sandbox-village'}-library"
        self.library_label = f"the Modal Volume {self.library_name}" + (f", folder {village}" if village else "")
        self._library = modal.Volume.from_name(self.library_name, create_if_missing=True, version=2)
        self._library_dir = f"/{village}" if village else "/"  # each village has its own folder on the one Volume

    def _get_app(self):
        # app_name=None means "the Modal app this code is already running inside".
        if self._app is None and self.app_name:
            if self.app_name not in ModalHomes._apps:
                ModalHomes._apps[self.app_name] = self._modal.App.lookup(self.app_name, create_if_missing=True)
            self._app = ModalHomes._apps[self.app_name]
        return self._app

    def prepare(self) -> None:
        self._shelf_mount()

    def _shelf_mount(self):
        """The library as this village's sandboxes see it: the whole Volume when everybody shares
        one village, otherwise only the village's own folder, so one visitor's villagers cannot
        read another's. A folder has to exist before it can be mounted."""
        if not self.village:
            return self._library
        if not self.store.get("_shelf"):
            import io

            with self._library.batch_upload(force=True) as batch:
                batch.put_file(io.BytesIO(b"this village's shelf\n"), f"{self._library_dir}/.shelf")
            self.store.put("_shelf", {"made": time.time()})
        return self._library.with_mount_options(sub_path=self._library_dir)

    def _sb(self, handle: str):
        if handle not in self._sandboxes:
            self._sandboxes[handle] = self._modal.Sandbox.from_id(handle)
        return self._sandboxes[handle]

    def _create(self, vid: str, snapshot_id: str | None) -> str:
        modal = self._modal
        image = modal.Image.from_id(snapshot_id) if snapshot_id else self._base_image
        sandbox = modal.Sandbox.create(
            "bash",
            "-c",
            self.ENTRY,
            app=self._get_app(),
            image=image,
            timeout=self.max_life_s,  # hard cap; the night watchman snapshots idle homes long before
            cpu=self.CPU,
            memory=self.MEMORY,
            outbound_cidr_allowlist=[],  # nothing inside a home can reach the internet, and no port is opened to it
            volumes={self.library_path: self._shelf_mount()},  # the one thing the houses share
            env={"HOME": self.home(vid), "VILLAGER": vid},
            runtime=world.get(vid).runtime or self.runtime,
        )
        self._sandboxes[sandbox.object_id] = sandbox
        return sandbox.object_id

    def _library_list(self) -> list[tuple[str, int, float]]:
        inside = self._library_dir.strip("/")
        files = []
        for entry in self._library.iterdir(self._library_dir, recursive=True):
            if entry.type == self._modal.volume.FileEntryType.FILE:
                path = entry.path.strip("/")
                files.append((path[len(inside) :].lstrip("/") if inside and path.startswith(inside + "/") else path, entry.size, entry.mtime))
        return files

    def _library_read(self, path: str) -> bytes:
        return b"".join(self._library.read_file(f"{self._library_dir.rstrip('/')}/{path}"))

    def _library_clear(self) -> None:
        if self.village:
            self._library.remove_file(self._library_dir, recursive=True)

    def _alive(self, handle: str) -> bool:
        try:
            return self._sb(handle).poll() is None
        except Exception:
            return False

    def sidecar(self, vid: str, name: str, args: tuple[str, ...]) -> bool:
        # A second container in the same sandbox, with its own command. The main container
        # reaches it by name (http://<name>:port) over the sandbox's private network; like the
        # home itself, it has no way out to the internet. Sidecars are a beta Modal
        # API, so any failure here just means "no sidecar" and the caller carries on without.
        st = self.state(vid)
        handle = st["sandbox_id"]
        if not handle:
            return False
        if (handle, name) in self._sidecars:
            return True
        try:
            manager = self._sb(handle)._experimental_sidecars
            if not any(other.name == name and other.poll() is None for other in manager.list()):
                # A sidecar's image has to exist already. The villager's own last snapshot does
                # (and has Python in it); on a first day with no snapshot yet, build the base.
                if st["snapshot_id"]:
                    image = self._modal.Image.from_id(st["snapshot_id"])
                else:
                    image = self._base_image.build(self._get_app())
                manager.create(*args, name=name, image=image, outbound_cidr_allowlist=[])
        except Exception as exc:
            print(f"sidecar {name!r} for {vid}: {type(exc).__name__}: {str(exc)[:200]}")
            return False
        self._sidecars.add((handle, name))
        return True

    def _exec(self, handle: str, vid: str, script: str, timeout: int) -> ExecResult:
        started = time.monotonic()
        try:
            # (Modal's own limit is a few seconds behind the one inside, as a backstop)
            process = self._sb(handle).exec("bash", "-c", self.CAPPED, "home", script, str(timeout), timeout=timeout + 5)
            out = process.stdout.read()
            err = process.stderr.read()
            process.wait()
        except self._modal.exception.ExecTimeoutError:
            return ExecResult(124, f"[stopped: the command ran longer than {timeout}s]", int((time.monotonic() - started) * 1000))
        rc = process.returncode if process.returncode is not None else -1
        if len(out) >= MAX_OUTPUT_BYTES // 4 and len(out.encode()) >= MAX_OUTPUT_BYTES - 4:
            out += f"\n[cut off: more than {MAX_OUTPUT_BYTES // 1024} KB of output]"
        if rc == 124 and time.monotonic() - started >= timeout:
            out += ("\n" if out and not out.endswith("\n") else "") + f"[stopped: the command ran longer than {timeout}s]"
        if rc in (126, 127, 128) and ("error finding executable" in err or not (out + err).strip()):
            # "Could not even start a shell" looks different on each runtime (gVisor names the
            # missing executable, a VM just returns 127 with no output). Ask directly.
            if not self._shell_works(handle):
                raise HomeRubble("the home's system files are gone")
        if rc == -1 and not out and time.monotonic() - started >= timeout:
            out = f"[stopped: the command ran longer than {timeout}s]"
            rc = 124
        return ExecResult(rc, out + err, int((time.monotonic() - started) * 1000))

    def _shell_works(self, handle: str) -> bool:
        try:
            process = self._sb(handle).exec("bash", "-c", "echo shell-ok", timeout=10)
            out = process.stdout.read()
            process.wait()
            return "shell-ok" in out
        except Exception:
            return False

    def _write(self, handle: str, vid: str, path: str, data: bytes) -> None:
        target = path if path.startswith("/") else f"{self.home(vid)}/{path}"
        fs = self._sb(handle).filesystem
        try:
            fs.write_bytes(data, target)
        except self._modal.exception.SandboxFilesystemError:
            # Usually a missing parent directory; make it and try once more.
            fs.make_directory(posixpath.dirname(target), create_parents=True)
            fs.write_bytes(data, target)

    # The dare, in full. Only ever run inside a sandbox, through its own exec: system files and
    # the home directory go; the library (a Volume other houses read) is left alone.
    RUIN = 'rm -rf /usr /bin /sbin /lib /lib64 /etc /opt /var /home /root "$HOME" 2>/dev/null; true'

    def _ruin(self, handle: str, vid: str) -> None:
        process = self._sb(handle).exec("bash", "-c", self.RUIN, timeout=90)
        process.stdout.read()
        process.wait()
        if self._shell_works(handle):
            raise HomeError("the house is somehow still standing")

    def _snapshot(self, handle: str) -> str:
        if self.snapshot_ttl_s:
            return self._sb(handle).snapshot_filesystem(ttl=self.snapshot_ttl_s).object_id
        return self._sb(handle).snapshot_filesystem().object_id

    def _terminate(self, handle: str) -> None:
        self._sb(handle).terminate()
        self._sandboxes.pop(handle, None)

