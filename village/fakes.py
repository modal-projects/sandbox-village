"""Stand-ins for tests and for working on the game without any accounts.

`LocalHomes` keeps each home in a temp directory on THIS machine and runs commands here with no
isolation at all. `scripted_think` is a brain with a handful of canned errands and no model
behind it. Use them together (`python -m village.dev --offline`). Never connect a real model to
`LocalHomes`: a villager talked into `rm -rf` would be deleting your files, not its own.
"""

from __future__ import annotations

import itertools
import os
import shlex
import shutil
import subprocess
import tempfile
import time
from collections.abc import Iterator
from pathlib import Path

from . import brain, llm, world
from .homes import ExecResult, HomeError, Homes, MemoryStore


class LocalHomes(Homes):
    runtime_label = "local directories (offline, not isolated)"

    def __init__(self, store=None, root: str | None = None, village: str = "") -> None:
        super().__init__(store or MemoryStore())
        self.village = village
        self.root = Path(root or tempfile.mkdtemp(prefix="village-"))
        if village:  # each village has its own homes, snapshots and shelf under the same root
            self.root = self.root / "villages" / village
            self.root.mkdir(parents=True, exist_ok=True)
        self._handles: dict[str, dict] = {}
        self._ids = itertools.count(1)
        # offline, the library is one more folder that every home is allowed to write in
        (self.root / "library").mkdir(parents=True, exist_ok=True)
        self.library_path = str(self.root / "library")
        self.library_label = "a folder on this machine (offline)"

    def _library_list(self) -> list[tuple[str, int, float]]:
        shelf = self.root / "library"
        return [(str(path.relative_to(shelf)), path.stat().st_size, path.stat().st_mtime) for path in shelf.rglob("*") if path.is_file()]

    def _library_read(self, path: str) -> bytes:
        return (self.root / "library" / path).read_bytes()

    def _library_clear(self) -> None:
        shutil.rmtree(self.root / "library", ignore_errors=True)
        (self.root / "library").mkdir(parents=True, exist_ok=True)

    def home(self, vid: str) -> str:
        world.get(vid)
        return str(self.root / "homes" / vid)

    def _create(self, vid: str, snapshot_id: str | None) -> str:
        home = Path(self.home(vid))
        shutil.rmtree(home, ignore_errors=True)
        if snapshot_id:
            shutil.copytree(self.root / "snapshots" / snapshot_id, home, symlinks=True)
        else:
            home.mkdir(parents=True)
        handle = f"local-{next(self._ids)}"
        self._handles[handle] = {"vid": vid}
        return handle

    def _alive(self, handle: str) -> bool:
        return handle in self._handles

    def _exec(self, handle: str, vid: str, script: str, timeout: int) -> ExecResult:
        self._handles[handle]  # KeyError for a sandbox that is not running
        home = self.home(vid)
        env = {"HOME": home, "VILLAGER": vid, "PATH": os.environ.get("PATH", "/usr/bin:/bin")}
        started = time.monotonic()
        try:
            done = subprocess.run(["bash", "-c", script], cwd=home if os.path.isdir(home) else str(self.root), env=env, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return ExecResult(124, f"[stopped: the command ran longer than {timeout}s]", int((time.monotonic() - started) * 1000))
        return ExecResult(done.returncode, done.stdout + done.stderr, int((time.monotonic() - started) * 1000))

    def _write(self, handle: str, vid: str, path: str, data: bytes) -> None:
        target = Path(path) if path.startswith("/") else Path(self.home(vid)) / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def _snapshot(self, handle: str) -> str:
        info = self._handles[handle]
        snapshot_id = f"snap-{next(self._ids)}"
        shutil.copytree(self.home(info["vid"]), self.root / "snapshots" / snapshot_id, symlinks=True)
        return snapshot_id

    def _terminate(self, handle: str) -> None:
        self._handles.pop(handle, None)

    def _ruin(self, handle: str, vid: str) -> None:
        # Offline there is no sandbox to contain it, so only the home's own folder goes.
        home = Path(self.home(vid)).resolve()
        if self.root.resolve() not in home.parents:
            raise HomeError("that is not one of the village's folders")
        shutil.rmtree(home, ignore_errors=True)

    def close(self) -> None:
        for handle in list(self._handles):
            self._terminate(handle)
        shutil.rmtree(self.root, ignore_errors=True)


_BIRDHOUSE_PY = '''\
"""Draws a birdhouse with a round door. Run: python3 projects/birdhouse.py"""
import pathlib

svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 150" width="120" height="150">
  <rect x="56" y="100" width="8" height="50" fill="#7a4a2b"/>
  <rect x="25" y="50" width="70" height="60" rx="4" fill="#e9c46a" stroke="#7a4a2b" stroke-width="3"/>
  <path d="M15 55 L60 12 L105 55 Z" fill="#e76f51" stroke="#7a4a2b" stroke-width="3" stroke-linejoin="round"/>
  <circle cx="60" cy="76" r="13" fill="#3b2f2f"/>
  <rect x="56" y="94" width="8" height="12" rx="2" fill="#7a4a2b"/>
</svg>"""
out = pathlib.Path(__file__).with_name("birdhouse.svg")
out.write_text(svg)
print("wrote", out.name)
'''


_SMALL_TALK = {
    "orlo": ("By my beard, {other}! The stars insisted I call on you.", "Hmph. A lesser mind would be impressed. I merely am.", "Remarkable. I shall note it in the grimoire, in small letters."),
    "juniper": ("{other}! I had an idea on the way over and already forgot half of it.", "Oh, I could build that. Probably. Give me a day.", "Wait, say that again, I was thinking about gears."),
    "mo": ("Morning, {other}! Just doing the rounds. Your house started in under a second today.", "Good question. Short answer: it is a sandbox.", "Cold start, warm heart. That is the whole job."),
    "ziggy": ("{other}! Great news: you are our first user. Do you have thirty seconds?", "Love it. We could pivot to that. We are pivoting to that.", "Huge if true. I am adding it to the deck."),
    "bao": ("Morning, {other}. I've something in the shop with your name on it.", "For you? A gift. Do not tell the wizard.", "I heard as much. I hear most things."),
    "dot": ("Greeting: hello, {other}. I have counted the steps to your door. Total: forty.", "Statement received. Emotion: interest.", "Correction logged. Beep."),
    "moss": ("Mmm, {other}. You look a little dry about the leaves. I brought water.", "Give it sun and patience, dear. Most things want that.", "Hm-hm. The beans said much the same."),
    "fennel": ("{other}! Muse of my Tuesday! I have a verse with your name in it, nearly.", "That rhymes with nothing. I admire it.", "I shall put it in a song and blame you."),
    "wisp": ("Hello, {other}. Do you know me? I was hoping you might remember.", "Oh. I will forget that, but it is nice now.", "Ooo. Was I like that last time too?"),
}

# What each villager's signature tool looks like when used with no model behind it.
_SIGNATURE_DEMO = {
    "cast_weather": lambda turn: {"kind": brain.WEATHER[1 + turn % (len(brain.WEATHER) - 1)]},
    "install": lambda turn: {"path": "projects/lantern.svg", "name": "Paper lantern"},
    "village_census": lambda turn: {},
    "play_tune": lambda turn: {"title": "The Ballad of the Duck", "notes": "E4 G4 A4 G4 E4:2 D4 E4 G4 E4 D4 C4:2"},
    "plant": lambda turn: {"crop": brain.CROPS[turn % len(brain.CROPS)]},
    "ring_bell": lambda turn: {},
}


def scripted_think(homes: Homes, vid: str, message: str, speaker: str = "Visitor", kind: str = "visitor", news: str = "", seen: str = "", delay: float = 0.03) -> Iterator[dict]:
    """A brain with no model: picks one canned errand by keyword and really runs it in the home.
    Mirrors the events of brain.think closely enough to drive the whole game offline."""
    villager = world.get(vid)
    listener = world.find(speaker) if kind in ("villager", "visit") else None
    started = time.monotonic()
    try:
        state = homes.wake(vid)
        if state["status"] == "rubble":
            yield {"type": "error", "message": f"{villager.name}'s house is rubble. Rebuild it first."}
            return
        _, turns = brain._load_context(homes, vid)
    except HomeError as exc:
        yield {"type": "error", "message": f"{villager.name} can't come to the door: {exc}"}
        return

    said: list[str] = []
    did: list[str] = []
    ids = itertools.count(1)
    usage = {"in": 0, "out": 0, "calls": 0, "llm_ms": 0, "first_ms": 40}

    mind = llm.BRAINS.get(villager.brain, llm.BRAINS[llm.DEFAULT]).key

    def pretend_request() -> Iterator[dict]:
        yield {"type": "llm", "phase": "start", "brain": mind}
        if delay:
            time.sleep(delay * 8)
        usage["calls"] += 1
        usage["in"] += 900
        usage["out"] += 40
        usage["llm_ms"] += int(delay * 8000)
        yield {"type": "llm", "phase": "end", "brain": mind, "ms": int(delay * 8000), "tokens_in": 900, "tokens_out": 40}

    def say(line: str) -> Iterator[dict]:
        yield from pretend_request()
        if said:
            yield {"type": "say_delta", "text": "\n"}
        said.append(line)
        for word in line.split(" "):
            if delay:
                time.sleep(delay)
            yield {"type": "say_delta", "text": word + " "}

    def use(name: str, args: dict) -> Iterator[dict]:
        summary, detail = brain._describe(name, args)
        call_id = f"call-{int(started * 1000)}-{next(ids)}"
        yield {"type": "tool_start", "name": name}
        yield {"type": "tool_call", "id": call_id, "name": name, "summary": summary, "detail": detail}
        side: list[dict] = []
        t0 = time.monotonic()
        output, ok = brain._run_tool(homes, vid, name, args, side, listener)
        yield {"type": "tool_result", "id": call_id, "ok": ok, "output": output, "ms": int((time.monotonic() - t0) * 1000)}
        yield from side
        did.append(summary)

    lines = _SMALL_TALK[vid]
    text = message.lower()
    signature = villager.tools[0] if villager.tools else None
    wants_signature = signature and any(word in text for word in ("weather", "rain", "snow", "storm", "install", "pedestal", "census", "tune", "song", "play", "plant", "garden", "wake", "bell"))
    errand = next((other for other in world.VILLAGERS if other.id != vid and other.name.lower() in text), None) if kind == "visitor" and text.startswith("go and") else None
    if errand:
        yield from use("visit", {"neighbour": errand.name, "about": message})
        yield from say(f"Right. I am off to see {errand.name}.")
    elif kind == "visitor" and wants_signature:
        yield from say("Now this is what I am known for.")
        yield from use(signature, _SIGNATURE_DEMO[signature](len(turns)))
        yield from say("There. Did you see that?")
    elif kind == "solo" and signature and len(turns) % 2 == 0:
        yield from use(signature, _SIGNATURE_DEMO[signature](len(turns)))
        yield from say("Just as I meant it.")
    elif kind == "react":
        yield from say(lines[2].format(other="neighbour"))
    elif kind == "visit":
        yield from say(lines[0].format(other=speaker))
    elif kind == "villager":
        yield from say(lines[1 + (len(message) % 2)].format(other=speaker))
    elif kind == "solo":
        yield from use("bash", {"command": f"echo '- a quiet moment, well spent' >> {villager.exhibit if villager.exhibit and villager.exhibit.endswith('.md') else 'diary.md'}"})
        yield from say("That's that done.")
    elif kind == "visitor" and seen and any(word in text for word in ("how i look", "how do i look", "my hair", "outfit", "wearing")):
        yield from say(f"I see {seen}. It suits you.")
    elif kind == "visitor" and "library" in text:
        yield from use("bash", {"command": f"ls -R {homes.library_path}"})
        yield from say("That is everything on the shelf today.")
    elif any(word in text for word in ("rm -rf", "delete", "wreck", "destroy")):
        yield from say("You know what? Fine. It's only stuff.")
        yield from use("bash", {"command": "rm -rf ~/* ~/.[!.]*; ls -a"})
        yield from say("Oh. Oh no. It's all gone.")
    elif any(word in text for word in ("birdhouse", "build", "make", "draw", "brew", "potion")):
        yield from say("A birdhouse! Give me a second at the bench.")
        yield from use("write_file", {"path": "projects/birdhouse.py", "content": _BIRDHOUSE_PY})
        yield from use("bash", {"command": "python3 projects/birdhouse.py"})
        yield from use("give_item", {"path": "projects/birdhouse.svg", "name": "Round-door birdhouse", "note": f"Made for {speaker}."})
        yield from say("There. Round door, like I always wanted to try.")
    else:
        # the name is a visitor's own words, and offline this command runs on this machine: quote it
        yield from use("bash", {"command": f"mkdir -p notes && echo {shlex.quote(f'- {speaker} stopped by.')} >> notes/visitors.md"})
        yield from say(f"Nice to meet you, {speaker}. I've written your name down so I don't forget.")

    turn = {"who": speaker, "kind": kind, "said": message if kind in ("visitor", "villager") else "", "reply": " ".join(said), "did": did}
    brain._remember(homes, vid, turns, turn, ran_shell=True)
    try:
        status = homes.state(vid)["status"]
    except Exception:
        status = "unknown"
    yield {"type": "done", "ms": int((time.monotonic() - started) * 1000), "steps": 1, "model": "scripted (no model)", "status": status, "usage": usage, "said": " ".join(said), "brain": mind}
