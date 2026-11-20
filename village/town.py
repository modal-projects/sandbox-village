"""Village life: what happens between villagers, and the record of it.

`Town` sits between the web API and the brain. It does three jobs:

- **The record.** A short log of what just happened (who is thinking, who said what, who walked
  where, presents), which every browser polls and draws.
- **The post office.** Sandboxes cannot reach each other: they have no outbound network. When a
  villager hands a neighbour a file, the town carries it from one sandbox to
  the other. If the receiving villager is asleep there is no sandbox to write to, so the file
  waits and is written when they next wake.
- **The director.** While somebody is actually watching, it starts small scenes: one villager
  walks over to visit another and they talk, or a villager gets on with something alone. Every
  line is a real turn through the shared brain, acting in that villager's own sandbox.

All of this lives in the web server's process, so there is one writer for the log.
"""

from __future__ import annotations

import random
import threading
import time
from collections import deque
from collections.abc import Callable, Iterator

from . import llm, safety, world
from .homes import HomeError, Homes

PRESENCE_S = 20  # a browser that polled this recently, with a person recently active, counts as "watching"
TALK_LOCK_S = 150
BUSY_PATIENCE_S = 12  # how long a visitor's question waits for a villager who is in the middle of something
TALKS_WAITING = 2  # how many questions may wait like that at once, in one village: each holds a request open
NEAR_KEEP_S = 8  # a villager the visitor was this recently standing by is left out of the village's own scenes
MAX_EVENTS = 240
WEATHER_S = 600  # how long a spell of weather lasts
PEDESTALS = 8  # how many of the tinkerer's pieces the village has room for

BELL_REST_S = 15.0  # the bell cannot wake the whole village more often than this

VISIT_REASONS = (
    "You want to ask them a small favour that suits what they do.",
    "You have a bit of news from the village to share, and an opinion about it.",
    "You want to show off the latest thing you made.",
    "Something odd has been bothering you and you think they are behind it.",
    "You came to borrow something, and you are not sure they will lend it.",
    "You brought them a small present from your home: hand it over with give_item.",
)


def travel_seconds(a: world.Villager, b: world.Villager) -> float:
    """Roughly how long the walk between two front doors takes on the map."""
    distance = abs(a.house[0] - b.house[0]) + abs(a.house[1] - b.house[1]) + 70
    return round(max(3.0, min(9.0, distance / 95)), 1)


class Town:
    def __init__(
        self,
        homes: Homes,
        think: Callable[..., Iterator[dict]],
        *,
        autonomous: bool = True,
        idle_s: float = 75.0,
        scene_gap_s: tuple[float, float] = (40.0, 70.0),
        scenes_per_hour: int = 60,
        talks_per_hour: int | None = None,
        pace: float = 1.0,
        seed: int | None = None,
    ) -> None:
        self.homes = homes
        self._think = think  # think(vid, message, speaker, kind, news) -> events
        self.autonomous = autonomous
        self.idle_s = idle_s
        self.scene_gap_s = scene_gap_s
        self._last_bell = 0.0  # when the bell last woke the whole village
        self._waiting = 0  # questions waiting for a busy villager to finish (see TALKS_WAITING)
        self._errand: dict | None = None  # a visit a player asked for, waiting for the villager to be free
        self.scenes_per_hour = scenes_per_hour
        self.talks_per_hour = talks_per_hour  # how many times an hour a visitor may ask a model something (None: no limit)
        self._talk_times: deque[float] = deque(maxlen=1000)
        self._stopped = False
        self.pace = pace  # 0 makes scenes instant, for tests
        self.random = random.Random(seed)
        self._lock = threading.Lock()
        self._events: deque[dict] = deque(maxlen=MAX_EVENTS)
        self._next_id = 1
        self._present_until = 0.0
        self._near: dict[str, float] = {}  # villager -> when a visitor was last standing by them
        self._next_scene = 0.0
        self._scene_times: deque[float] = deque(maxlen=400)
        self._last_sweep = 0.0
        self._thread: threading.Thread | None = None
        self.whereabouts: dict[str, str] = {}  # a villager who is out visiting -> whose house they are at
        self.brains = {key: {"requests": 0, "tokens_in": 0, "tokens_out": 0, "llm_ms": 0, "recent": deque(maxlen=12)} for key in llm.BRAINS}
        self.weather = {"kind": "clear", "by": None, "until": 0.0}
        self.installations: list[dict] = []  # the tinkerer's pieces on the pedestals: {"id", "slot", "name", "by", "file", "text"}
        self._stir: dict | None = None  # the last thing the whole village saw or heard: {"by", "what"}
        self._load()

    # ---- things that outlast a restart ----------------------------------------------------------

    def _load(self) -> None:
        """The weather and the pedestals are kept beside the villagers'
        states, so restarting the server does not reset the village."""
        try:
            kept = self.homes.store.get("_town") or {}
        except Exception:
            kept = {}
        self.weather = kept.get("weather") or self.weather
        self.installations = list(kept.get("installations") or [])

    def _keep(self) -> None:
        try:
            self.homes.store.put("_town", {"weather": self.weather, "installations": self.installations})
        except Exception:
            pass

    def current_weather(self) -> dict:
        if self.weather["until"] < time.time():
            return {"kind": "clear", "by": None}
        return {"kind": self.weather["kind"], "by": self.weather["by"]}

    # ---- the record ---------------------------------------------------------------------------

    def log(self, kind: str, **fields) -> dict:
        with self._lock:
            event = {"id": self._next_id, "t": time.time(), "kind": kind, **fields}
            self._next_id += 1
            self._events.append(event)
            return event

    def since(self, after: int) -> list[dict]:
        with self._lock:
            return [event for event in self._events if event["id"] > after]

    def last_id(self) -> int:
        with self._lock:
            return self._next_id - 1

    def news(self, limit: int = 5) -> str:
        """Recent happenings in plain words, for villagers to gossip about."""
        lines = []
        for event in reversed(self.since(0)):
            line = self._headline(event)
            if line and line not in lines:
                lines.append(line)
            if len(lines) >= limit:
                break
        return "\n".join(f"- {line}" for line in reversed(lines))

    def _headline(self, event: dict) -> str | None:
        name = lambda vid: world.get(vid).name if vid in world.BY_ID else str(vid)  # noqa: E731
        kind = event["kind"]
        if kind == "walk":
            return f"{name(event['who'])} went to visit {name(event['to'])}."
        if kind == "say" and event.get("to"):
            return f"{name(event['who'])} said to {name(event['to'])}: \"{event['text'][:110]}\""
        if kind == "gift":
            return f"{name(event['who'])} gave {name(event['to']) if event.get('to') else event.get('player', 'a visitor')} a present: {event['label']}."
        if kind == "weather":
            return f"{name(event['who'])} changed the weather to {event['weather']}."
        if kind == "tune":
            return f"{name(event['who'])} played a tune called \"{event['title']}\"."
        if kind == "install":
            return f"{name(event['who'])} put up \"{event['name']}\" on a pedestal in the village."
        if kind == "garden":
            return f"{name(event['who'])} planted something in the garden."
        return None

    def brain_stats(self) -> list[dict]:
        """Each brain's endpoint, with what it has been asked so far and who thinks with it."""
        out = []
        for info in llm.describe():
            with self._lock:
                tally = self.brains[info["key"]]
                totals = {key: tally[key] for key in ("requests", "tokens_in", "tokens_out", "llm_ms")}
                recent = list(tally["recent"])
            out.append(
                {
                    **info,
                    **totals,
                    "avg_ms": round(totals["llm_ms"] / totals["requests"]) if totals["requests"] else None,
                    "recent": recent,
                    "villagers": [v.id for v in world.VILLAGERS if llm.get(v.brain).key == info["key"]],
                }
            )
        return out

    # ---- one turn through the shared brain ----------------------------------------------------

    def turn(self, vid: str, message: str, speaker: str, kind: str, player: str | None = None, to: str | None = None, seen: str = "") -> Iterator[dict]:
        """Run a villager's turn, doing the things a turn can set in motion outside its own
        sandbox (presents, weather, pedestals) and recording what everyone should see.

        What the villager says is recorded line by line as they say it: the remark before they
        turn to their computer, then what they say when they look up again."""
        line = ""
        last_line = ""
        held = ""  # words on their way to the talk box: the last may still be growing

        def fit(final: bool = False) -> str:
            """As much of `held` as is whole words, with any listed word hummed over. Words that
            may be the start of a listed phrase wait for the rest of it."""
            nonlocal held
            cut = len(held) if final else max(held.rfind(" "), held.rfind("\n")) + 1
            if not final:
                cut -= safety.unfinished(held[:cut])
            ready, held = held[:cut], held[cut:]
            words = ready.strip()
            if not words:
                return ready
            start = ready.index(words)  # the spaces either side are kept as they came
            return ready[:start] + safety.soften(words) + ready[start + len(words) :]

        def spoken() -> None:
            nonlocal line, last_line
            text = safety.soften(" ".join(line.split()))
            line = ""
            if text:
                last_line = text
                self.log("say", who=vid, to=to, player=player, text=text[:280], dur=self._read_time(text))

        def thoughts() -> Iterator[dict]:
            try:
                yield from self._think(vid, message, speaker, kind, self.news(), *((seen,) if seen else ()))
            except Exception as exc:  # what was already said is passed on before the error is
                yield {"type": "_raised", "error": exc}

        for event in thoughts():
            kind_of = event["type"]
            if kind_of == "say_delta":
                line += event["text"]
                held += event["text"]
                ready = fit()
                if ready:
                    yield {**event, "text": ready}
                continue
            if held:  # anything else ends the sentence: say the rest of it first
                yield {"type": "say_delta", "text": fit(final=True)}
            if kind_of == "_raised":
                raise event["error"]
            if kind_of in ("tool_start", "done", "error"):
                spoken()
                if kind_of == "done":
                    event = {**event, "last_line": last_line, **({"said": safety.soften(event["said"])} if event.get("said") else {})}
            if kind_of == "llm":
                if event["phase"] == "start":
                    self.log("think", who=vid, phase="start")
                else:
                    with self._lock:
                        tally = self.brains.get(event.get("brain")) or self.brains[llm.DEFAULT]
                        tally["requests"] += 1
                        tally["tokens_in"] += event.get("tokens_in", 0)
                        tally["tokens_out"] += event.get("tokens_out", 0)
                        tally["llm_ms"] += event.get("ms", 0)
                        tally["recent"].append({"who": vid, "ms": event.get("ms", 0), "tokens_in": event.get("tokens_in", 0), "tokens_out": event.get("tokens_out", 0), "at": time.time()})
                    self.log("think", who=vid, phase="end", ms=event.get("ms", 0), tokens_in=event.get("tokens_in", 0), tokens_out=event.get("tokens_out", 0))
            elif kind_of == "tool_call":
                self.log("act", who=vid, tool=event["name"], summary=event["summary"][:140])
            elif kind_of == "item":
                self._hand_over(vid, event, player)
            elif kind_of == "weather":
                self.weather = {"kind": event["kind"], "by": vid, "until": time.time() + WEATHER_S}
                self._keep()
                self.log("weather", who=vid, weather=event["kind"])
                self._stir = {"by": vid, "what": f"{world.get(vid).name} has just changed the weather: it is now {event['kind']} over the whole village."}
            elif kind_of == "tune":
                self.log("tune", who=vid, title=event["title"], notes=event["notes"])
                self._stir = {"by": vid, "what": f"{world.get(vid).name} has just played a tune called \"{event['title']}\", loud enough for the whole village to hear."}
            elif kind_of == "install":
                self._install(vid, event["item"])
                self._stir = {"by": vid, "what": f"{world.get(vid).name} has just put a new piece called \"{event['item']['name']}\" on a pedestal by the lane."}
            elif kind_of == "visit":
                # Only a visitor can send a villager calling, and only one errand waits at a time.
                if player and event["to"] in world.BY_ID:
                    self._errand = {"guest": vid, "host": event["to"], "about": event.get("about", ""), "player": player, "at": time.time()}
            elif kind_of == "bell":
                self._last_bell = time.time()
                self.log("bell", who=vid, count=event["count"], ms=event["ms"])
            elif kind_of == "garden":
                self.log("garden", who=vid)
            elif kind_of == "done" and world.get(vid).exhibit:
                # Whatever they keep on show (a garden, a chronicle) may have changed: read it
                # back out of the sandbox so the village can show it, even after they sleep.
                self.homes.refresh_exhibit(vid)
            yield event
        if held:  # a turn that simply stopped: its last words are still said
            yield {"type": "say_delta", "text": fit(final=True)}
            spoken()

    def _install(self, vid: str, item: dict) -> None:
        """Put a piece on the next free pedestal; when all are full the oldest makes way."""
        taken = {piece["slot"] for piece in self.installations}
        free = [slot for slot in range(PEDESTALS) if slot not in taken]
        if free:
            slot = free[0]
        else:
            slot = self.installations.pop(0)["slot"]
        piece = {"id": f"piece-{int(time.time() * 1000)}", "slot": slot, "name": item["name"], "by": vid, "file": item["file"], "text": item["text"]}
        self.installations.append(piece)
        self._keep()
        self.log("install", who=vid, name=item["name"], slot=slot, piece=piece["id"])

    def _hand_over(self, vid: str, event: dict, player: str | None) -> None:
        item = event["item"]
        to = event.get("to")
        if to and to in world.BY_ID and isinstance(item.get("text"), str):
            try:
                self.homes.deliver(to, f"gifts/{item['name']}", item["text"])
            except HomeError:
                pass
        self.log("gift", who=vid, to=to, player=None if to else player, label=item["label"], shelf=item.get("shelf"))

    # ---- a player talking to a villager -------------------------------------------------------

    def talk(self, vid: str, message: str, player: str, look: dict | None = None) -> Iterator[dict]:
        villager = world.get(vid)
        player = safety.name(player)
        if not safety.ok(message):
            # Never reaches the model or the village log: the villager just turns it down.
            yield {"type": "say_delta", "text": safety.decline(villager.name)}
            yield {"type": "done", "said": "", "ms": 0, "usage": {"calls": 0, "in": 0, "out": 0}, "brain": villager.brain}
            return
        now = time.time()
        # The hour's allowance is counted here, under the lock, so questions sent side by side
        # cannot all slip under it.
        with self._lock:
            while self._talk_times and now - self._talk_times[0] > 3600:
                self._talk_times.popleft()
            spent = self.talks_per_hour is not None and len(self._talk_times) >= self.talks_per_hour
            if not spent:
                self._talk_times.append(now)
            patient = not spent and bool(self.pace) and self._waiting < TALKS_WAITING
            self._waiting += patient
        if spent:
            # no model is called, and nothing is woken
            wait = max(1, round((3600 - (now - self._talk_times[0])) / 60)) if self._talk_times else 60  # (an allowance of none at all)
            yield {"type": "say_delta", "text": f"{villager.name} has talked themselves hoarse. Give the village about {wait} minute{'s' if wait != 1 else ''}."}
            yield {"type": "done", "said": "", "ms": 0, "usage": {"calls": 0, "in": 0, "out": 0}, "brain": villager.brain, "spent": True}
            return
        # In the middle of something of their own (a pastime takes five to ten seconds)? The
        # question waits for them to finish, and is only turned away if they are still at it.
        # Only a couple of questions may wait at a time: each one holds a request open.
        patience = time.time() + (BUSY_PATIENCE_S if patient else 0)
        try:
            free = self.homes.set_busy(vid, TALK_LOCK_S)
            while not free and time.time() < patience and not self._stopped:
                time.sleep(0.3)
                free = self.homes.set_busy(vid, TALK_LOCK_S)
        finally:
            with self._lock:
                self._waiting -= patient
        if not free:
            with self._lock:  # a question nobody heard is not counted
                if now in self._talk_times:
                    self._talk_times.remove(now)
            host = self.whereabouts.get(vid)
            yield {"type": "error", "message": f"{villager.name} is busy with {'a neighbour' if host or vid in self.whereabouts.values() else 'someone else'}. Try again in a moment."}
            return
        try:
            self.log("heard", who=vid, player=player, text=message[:160])
            yield from self.turn(vid, message, player, "visitor", player=player, seen=world.describe_look(look))
        except Exception as exc:  # the stream is already open, so report instead of raising
            yield {"type": "error", "message": f"Something went wrong: {type(exc).__name__}: {exc}"}
        finally:
            self.homes.set_busy(vid, 0)
            if self._errand and self._thread is not None:
                # Off they go, now, even if the village is in the middle of some other scene.
                threading.Thread(target=self.run_errand, args=(45.0,), daemon=True, name="village-errand").start()

    def wake_everyone(self) -> dict:
        """Ring the bell: start a sandbox for every sleeping villager, all at the same time.
        Returns how long each took and how long the whole village took."""
        now = time.time()
        if now - self._last_bell < BELL_REST_S:
            raise HomeError("The bell is still swinging. Give it a moment.")
        self._last_bell = now
        result = self.homes.wake_all()
        if result["count"]:
            self.log("bell", count=result["count"], ms=result["ms"])
        return result

    def run_errand(self, patience_s: float = 0.0) -> bool:
        """Send a villager on the visit a player asked for. If either of them is busy, keep
        trying for `patience_s` seconds. Returns whether the visit happened."""
        with self._lock:
            errand, self._errand = self._errand, None
        if not errand:
            return False
        guest, host = world.get(errand["guest"]), world.get(errand["host"])
        deadline = time.time() + patience_s
        while not self.scene_visit(guest, host, reason=f"{errand['player']}, a visitor, asked you to come over: {errand['about']}"):
            if time.time() >= deadline:
                return False
            time.sleep(1.0)
        self._next_scene = max(self._next_scene, time.time() + self.random.uniform(*self.scene_gap_s) * (self.pace or 0.0))
        return True

    # ---- the director -------------------------------------------------------------------------

    def presence(self, near: list[str], active: bool) -> None:
        """A browser checked in. `near` are the villagers its player is standing close to."""
        now = time.time()
        if active:
            if self._present_until < now:  # someone just arrived: let them see life soon
                self._next_scene = min(self._next_scene, now + 8) if self._next_scene > now else now + 8
            self._present_until = now + PRESENCE_S
        for vid in near:
            if vid in world.BY_ID:
                self._near[vid] = now
                try:
                    st = self.homes.state(vid, max_age=1.0)
                    if st["status"] == "awake" and now - st["last_active"] > 8:
                        self.homes.touch(vid)
                except Exception:
                    pass

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, daemon=True, name="village-director")
            self._thread.start()

    def stop(self) -> None:
        """Stop the director's clock (the village is being put away)."""
        self._stopped = True

    def _run(self) -> None:
        while not self._stopped:
            time.sleep(1.0)
            try:
                self.tick()
            except Exception as exc:  # one bad scene must not stop village life
                if type(exc).__name__ == "ClientClosed":
                    return  # the container is shutting down: Modal has closed its client, so stop quietly
                print("director:", type(exc).__name__, exc)

    def tick(self, now: float | None = None) -> str | None:
        """One beat of the director's clock. Returns the kind of scene it ran, if any."""
        now = now if now is not None else time.time()
        if now - self._last_sweep > 10:
            self._last_sweep = now
            away = set(self.whereabouts) | set(self.whereabouts.values())
            for vid in self.homes.sleep_idle(self.idle_s, skip=away):
                self.log("slept", who=vid)
        if self._errand and self._thread is None:
            # Only when nothing is running the clock (tests, scripts). With the director started,
            # `talk` sends the villager off itself the moment they finish speaking; taking the
            # errand here would find them still mid-sentence, busy, and lose it.
            return "errand" if self.run_errand() else None
        if not self.autonomous or now > self._present_until or now < self._next_scene:
            return None
        while self._scene_times and now - self._scene_times[0] > 3600:
            self._scene_times.popleft()
        if len(self._scene_times) >= self.scenes_per_hour:
            return None
        self._scene_times.append(now)
        kind = self.scene()
        self._next_scene = time.time() + self.random.uniform(*self.scene_gap_s) * (self.pace or 0.0)
        return kind

    def scene(self) -> str | None:
        free = []
        for villager in world.VILLAGERS:
            if time.time() - self._near.get(villager.id, 0.0) < NEAR_KEEP_S:
                # A visitor is at their door and about to speak to them. A scene starting now
                # would have that first question turned away ("busy"): it was, about one time
                # in six on the public site.
                continue
            st = self.homes.state(villager.id)
            if st["status"] != "rubble" and st["busy_until"] < time.time():
                free.append((villager, st["status"] == "awake"))
        if not free:
            return None
        # Something the whole village just saw or heard: one neighbour who is up says what they think.
        stir, self._stir = self._stir, None
        if stir:
            up = [v for v, awake in free if awake and v.id != stir["by"]]
            if not up and self.random.random() < 0.6:
                up = [v for v, _ in free if v.id != stir["by"]]  # nobody else is up: sometimes the noise wakes one
            if up:
                self.scene_react(self.random.choice(up), stir["what"])
                return "react"
        # Villagers who are already up are likelier to be the one who acts.
        weights = [3 if awake else 1 for _, awake in free]
        actor = self.random.choices([v for v, _ in free], weights=weights)[0]
        others = [v for v, _ in free if v.id != actor.id]
        if others and self.random.random() < 0.6:
            self.scene_visit(actor, self.random.choice(others))
            return "visit"
        self.scene_solo(actor)
        return "solo"

    def scene_solo(self, actor: world.Villager, errand: str | None = None) -> None:
        if not self.homes.set_busy(actor.id, TALK_LOCK_S):
            return
        try:
            self._line(actor.id, errand or self.random.choice(actor.pastimes), "", "solo")
        finally:
            self.homes.set_busy(actor.id, 0)

    def scene_react(self, actor: world.Villager, what: str) -> None:
        """One remark from a neighbour about something everybody just saw or heard."""
        if not self.homes.set_busy(actor.id, TALK_LOCK_S):
            return
        try:
            self._line(actor.id, what, "", "react")
        finally:
            self.homes.set_busy(actor.id, 0)

    def scene_visit(self, guest: world.Villager, host: world.Villager, reason: str | None = None) -> bool:
        """One villager walks over to another and they talk. False if either was busy."""
        if not self.homes.set_busy(guest.id, TALK_LOCK_S):
            return False
        if not self.homes.set_busy(host.id, TALK_LOCK_S):
            self.homes.set_busy(guest.id, 0)
            return False
        walk = travel_seconds(guest, host)
        try:
            self.homes.wake(guest.id)  # you cannot leave the house without waking up
            self.whereabouts[guest.id] = host.id
            self.log("walk", who=guest.id, to=host.id, dur=walk)
            knock = threading.Thread(target=self._wake_quietly, args=(host.id,), daemon=True)
            knock.start()  # the knock on the door: the host's sandbox starts while the guest walks
            self._pause(walk)
            knock.join(timeout=30)
            opening = self._line(guest.id, reason or self.random.choice(VISIT_REASONS), host.name, "visit", to=host.id)
            if opening:
                answer = self._line(host.id, opening, guest.name, "villager", to=guest.id)
                if answer:
                    back = self._line(guest.id, answer, host.name, "villager", to=host.id)
                    if back and self.random.random() < 0.5:
                        self._line(host.id, back, guest.name, "villager", to=guest.id)
        except HomeError as exc:
            self.log("fizzle", who=guest.id, text=str(exc)[:120])
        finally:
            self.log("walk_home", who=guest.id, dur=walk)
            self.whereabouts.pop(guest.id, None)
            self.homes.set_busy(guest.id, 0)
            self.homes.set_busy(host.id, 0)
        return True

    def _wake_quietly(self, vid: str) -> None:
        try:
            self.homes.wake(vid)
        except Exception:
            pass

    def _line(self, vid: str, message: str, speaker: str, kind: str, to: str | None = None) -> str:
        """One villager's turn in a scene. Returns what they said (empty if it went wrong)."""
        said = last_line = ""
        for event in self.turn(vid, message, speaker, kind, to=to):
            if event["type"] == "done":
                said, last_line = event.get("said", ""), event.get("last_line", "")
            elif event["type"] == "error":
                self.log("fizzle", who=vid, text=event["message"][:120])
        if last_line:
            self._pause(self._read_time(last_line))  # give whoever is watching time to read it
        return said

    @staticmethod
    def _read_time(text: str) -> float:
        return round(max(3.5, min(11.0, 2.5 + len(text) / 16)), 1)

    def _pause(self, seconds: float) -> None:
        if self.pace:
            time.sleep(seconds * self.pace)
