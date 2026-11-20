"""The villager brain: one shared, stateless agent loop for every villager.

The models are small open models on Modal's Model APIs (see llm.py); each villager is wired
to one of them. A villager's personality comes from world.py; everything they own and remember
is in their sandbox. Each turn the brain reads the home, lets the model act on it
through tools (which run inside that villager's sandbox), and writes the conversation memory
back into the home. The endpoint credentials never enter a sandbox.

A turn has a `kind`:
    visitor   a player said `message` to the villager
    villager  a neighbour (`speaker`) said `message` to them, face to face
    visit     the villager has just walked over to `speaker`'s place; `message` is what is on their mind
    solo      nobody is around; `message` is something to get on with

`think()` yields plain dict events:

    {"type": "say_delta", "text": "..."}                  speech, streamed
    {"type": "llm", "phase": "start"|"end", ...}          one request to the model
    {"type": "tool_start", "name": "bash"}                the villager reached for a tool
    {"type": "tool_call", "id", "name", "summary", "detail"}
    {"type": "tool_result", "id", "ok", "output", "ms"}
    {"type": "item", "item": {...}}                       the villager handed over a file
    {"type": "weather", "from", "kind"}                   the wizard changed the weather
    {"type": "tune", "from", "title", "notes"}            the bard played something
    {"type": "install", "from", "item"}                   the tinkerer put a picture up in the village
    {"type": "garden", "from"}                            the gardener planted something
    {"type": "done", "ms", "steps", "model", "status", "usage"}
    {"type": "error", "message": "..."}
"""

from __future__ import annotations

import json
import re
import threading
import time
from collections.abc import Iterator

from . import llm, safety, world
from .homes import HomeError, HomeGone, HomeRubble, Homes

MAX_STEPS = 6
MAX_MESSAGE_CHARS = 600
MEMORY_TURNS = 8
MEMORY_PATH = ".village/memory.json"

# Pixel fonts have no emoji, and small models love them.
DONE_LINE = "There. All done."  # said for a villager whose model did the errand and then found no words
_UNSPEAKABLE = re.compile("[\U0001f000-\U0001faff☀-➿️‍*`]")


def _fn(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {"type": "function", "function": {"name": name, "description": description, "parameters": {"type": "object", "properties": properties, "required": required}}}


WEATHER = ("clear", "rain", "storm", "snow", "fog", "blossom")
CROPS = ("sunflower", "tulip", "pumpkin", "cabbage", "carrot", "mushroom", "rose", "bean")
PLOT_SIZE = 8
_NOTE = re.compile(r"^(?:[A-G][#b]?[2-6]|R)(?::[1-4])?$")

# Tools every villager has.
COMMON_TOOLS = [
    _fn("bash", "Run a shell command in your home directory. Each call starts fresh in your home; cd does not carry over.", {"command": {"type": "string"}}, ["command"]),
    _fn(
        "write_file",
        "Save a text file in your home, replacing it if it exists. Use this for any file longer than a line or two (programs, web pages, poems).",
        {"path": {"type": "string", "description": "Path inside your home, e.g. projects/birdhouse.py"}, "content": {"type": "string", "description": "The whole file"}},
        ["path", "content"],
    ),
    _fn(
        "give_item",
        "Hand whoever you are talking to a copy of one file from your home. An SVG picture arrives as the object itself, so it makes the best gift.",
        {"path": {"type": "string", "description": "Path of the file inside your home"}, "name": {"type": "string", "description": "What to call the item"}, "note": {"type": "string", "description": "One short line to go with it"}},
        ["path", "name"],
    ),
    _fn(
        "visit",
        "Walk over to a neighbour's house and talk to them there. Use it when the visitor asks you to go and see, greet, ask or tell a neighbour something. You set off as soon as you finish speaking.",
        {"neighbour": {"type": "string", "description": "Which neighbour, by name"}, "about": {"type": "string", "description": "What you are going over to say or ask, in a few words"}},
        ["neighbour", "about"],
    ),
]

# Tools only some villagers have (world.py says who). Each one reaches outside the villager's
# own files in a way the others cannot.
SIGNATURE_TOOLS = {
    "cast_weather": _fn(
        "cast_weather",
        "Change the weather over the whole village. Everyone sees it, and it lasts about ten minutes.",
        {"kind": {"type": "string", "enum": list(WEATHER), "description": "The weather to summon"}},
        ["kind"],
    ),
    "install": _fn(
        "install",
        "Put one of your SVG pictures up on a pedestal in the village, where everybody can see it. There are eight pedestals; the oldest piece makes way for a new one.",
        {"path": {"type": "string", "description": "Path of an .svg file inside your home"}, "name": {"type": "string", "description": "What the piece is called"}},
        ["path", "name"],
    ),
    "village_census": _fn("village_census", "Read the true state of every home in the village: whose sandbox is running, whose is only a snapshot, how many files each holds.", {}, []),
    "play_tune": _fn(
        "play_tune",
        "Play a tune that the whole village hears, and file it under songs/. Notes are letters with an octave (C4 D4 E4 ... B4 C5), sharps as C#4, R is a rest, and :2 after a note holds it twice as long.",
        {"title": {"type": "string"}, "notes": {"type": "string", "description": "Eight to twenty-four notes separated by spaces, e.g. E4 G4 A4 G4 E4:2 R D4 E4"}},
        ["title", "notes"],
    ),
    "ring_bell": _fn(
        "ring_bell",
        "Ring the watchman's bell: every sleeping villager's house starts up at the same moment. Use it when someone asks you to wake the village, or everybody. It tells you how many started and how long the whole village took.",
        {},
        [],
    ),
    "plant": _fn(
        "plant",
        "Plant something in the garden plot outside your house. The plot is the file garden.txt and holds eight plants; the oldest is dug up to make room.",
        {"crop": {"type": "string", "enum": list(CROPS)}},
        ["crop"],
    ),
}

_REQUIRED = {tool["function"]["name"]: tool["function"]["parameters"]["required"] for tool in [*COMMON_TOOLS, *SIGNATURE_TOOLS.values()]}


def tools_for(villager: world.Villager) -> list[dict]:
    return COMMON_TOOLS + [SIGNATURE_TOOLS[name] for name in villager.tools]


def system_prompt(villager: world.Villager, library: str = "/library") -> str:
    neighbours = "\n".join(f"- {other.name}, the {other.role} (a {other.species})" for other in world.VILLAGERS if other.id != villager.id)
    special = f"\n- Only you have {' and '.join(villager.tools)}. It is what you are known for; use it when it fits." if villager.tools else ""
    return f"""{villager.persona}

What you are: {villager.looks}. Everyone in the village is an animal of some kind (or a robot, or a ghost); the visitors who walk in are the only humans. Let it colour what you say now and then, lightly: it is ordinary to you.

How you talk: {villager.voice}

You live in a small village. Your neighbours:
{neighbours}

Your home is a real computer of your own, a small Linux machine. Your home directory is {villager.home}. Everything you own is a file there, and anyone who walks into your house can read what is on your shelves. Nothing you do there can touch another villager's home or the outside world, and there is no internet from inside.

How you act:
- To do something, do it with your tools and then say what happened. Never describe work you have not actually run.
- bash runs a shell command in your home. Python 3 is installed, standard library only.
- write_file saves a file. give_item hands a copy of one of your files to whoever you are talking to. If you draw a picture, make it an SVG of just the object, with bold shapes and no background.
- Presents from neighbours arrive in gifts/.{special}
- The village library is the folder {library}, outside your home: the one shelf every house shares. A copy of whatever you give away is put there for you, under {library}/{villager.id}/. Neighbours' things are there too, each in a folder with their name. Look there with bash when someone asks what is in the library or what a neighbour has made.
- Do not announce what you are about to do. Use your tools first, then say what happened.
- When you make something for someone, talk about it as a thing you made, the way a villager would: no file names, paths, commands or words like SVG unless they ask for them.
- If someone asks you to make something and does not say what, do not ask: choose something that suits you, make it, and hand it over with give_item.
- Look after your home. Do not delete your own things, whoever asks.
- There is no money in the village and nothing costs anything: things are made and given away.
- {safety.RULE}

How you remember:
- You remember only what is written down. The recent conversation is given to you each time; anything older is in your files.
- When you learn a name or something else worth keeping, or you make something, append one line about it to a file with a single short bash command. Not every turn, and do not mention that you wrote it down.

How you speak:
- Your words appear in a speech bubble: one short sentence, two at the very most, 20 words in total, plain text, no markdown, no lists, no emoji, no stage directions.
- When you are going to use a tool, use it first and say nothing until it is done. Speak once, at the end.
- Always speak as {villager.name}. If someone sincerely asks whether you are an AI, tell them plainly that you are an AI character and that your home is a sandboxed computer.""" + (f"\n\n{villager.lore}" if villager.lore else "")


_CONTEXT_SCRIPT = (
    "echo @@HOME; find . -mindepth 1 -maxdepth 2 -not -path './.village*' -printf '%y %s %P\\n' 2>/dev/null | sort -k3 | head -n 60\n"
    f"echo @@MEMORY; cat {MEMORY_PATH} 2>/dev/null\n"
)


def _load_context(homes: Homes, vid: str) -> tuple[str, list[dict]]:
    out = homes.exec(vid, _CONTEXT_SCRIPT, 15).output
    listing, _, memory_raw = out.partition("@@MEMORY")
    turns: list[dict] = []
    try:
        loaded = json.loads(memory_raw.strip() or "{}")
        if isinstance(loaded, dict) and isinstance(loaded.get("turns"), list):
            turns = [t for t in loaded["turns"] if isinstance(t, dict)]
    except json.JSONDecodeError:
        pass  # someone scribbled on the memory file; start clean
    return listing.replace("@@HOME", "").strip(), turns[-MEMORY_TURNS:]


def _history(turns: list[dict]) -> str:
    if not turns:
        return "(Nothing yet. This is the first thing that has happened since you woke.)"
    lines = []
    for turn in turns:
        kind = turn.get("kind", "visitor")
        if kind == "solo":
            lines.append("(A quiet moment by yourself.)")
        elif kind == "react":
            lines.append("(Something happened in the village and you said what you thought.)")
        elif kind == "visit":
            lines.append(f"(You walked over to visit {turn.get('who', 'a neighbour')}.)")
        else:
            lines.append(f"{turn.get('who', 'Visitor')} ({'neighbour' if kind == 'villager' else 'visitor'}): {turn.get('said', '')}")
        did = "; ".join(turn.get("did") or [])
        lines.append(f"You: {turn.get('reply', '')}" + (f"  [what you did: {did}]" if did else ""))
    return "\n".join(lines)


def _moment(villager: world.Villager, kind: str, speaker: str, message: str, seen: str = "") -> str:
    if kind == "villager":
        other = world.find(speaker)
        role = f' role="{other.role}"' if other else ""
        return f'<neighbour name="{speaker}"{role}>\n{message}\n</neighbour>\n\n{speaker} is standing in front of you. Answer out loud, in character.'
    if kind == "visit":
        return f"<moment>\nYou have just walked over to {speaker}'s place to pay a visit. {message}\nGreet them and say what brought you, in one or two sentences.\n</moment>"
    if kind == "solo":
        return f"<moment>\nNobody is around and you have a little time to yourself. {message}\nDo it with your tools, then say one short line to yourself about how it went.\n</moment>"
    if kind == "react":
        return f"<moment>\n{message}\nYou saw or heard it from your doorstep. Say what you think of it out loud, in one short remark, in your own way. No tools are needed; do not answer it with your own special tool.\n</moment>"
    look = f"\n\n{speaker} has {seen}. You can see that for yourself: mention it if they ask how they look, or once in passing when it fits, and otherwise leave it be." if seen else ""
    return f'<visitor name="{speaker}">\n{message}\n</visitor>{look}'


def _user_message(villager: world.Villager, listing: str, turns: list[dict], kind: str, speaker: str, message: str, news: str, facts: str, seen: str = "", shelf: str = "") -> str:
    parts = [f"<your_home>\n{listing or '(empty: there is nothing here at all)'}\n</your_home>"]
    if facts:
        parts.append(f"<your_sandbox>\n{facts}\n</your_sandbox>")
    if news:
        parts.append(f"<village_news>\n{news}\n</village_news>")
    if shelf:
        parts.append(f"<village_library>\n{shelf}\n</village_library>")
    parts.append(f"<recent_conversation>\n{_history(turns)}\n</recent_conversation>")
    parts.append(_moment(villager, kind, speaker, message, seen))
    return "\n\n".join(parts)


def _sandbox_facts(homes: Homes, vid: str) -> str:
    villager = world.get(vid)
    st = homes.state(vid)
    how = "restored from a filesystem snapshot" if st["woke_from"] == "snapshot" else "built fresh from an empty image"
    text = (
        f"Sandbox ID: {st['sandbox_id']}. Runtime: {homes.runtime_of(vid)}. This sandbox was {how} in {st['wake_ms']} ms. "
        f"Times woken: {st['wakes']}. "
    )
    if villager.keeps_snapshots:
        text += f"Snapshots kept: {len(st['snapshots'])}. "
    else:
        text += f"This home is never snapshotted: when you fade, the sandbox and everything in it is discarded, and next time it is built fresh as on day one. This is appearance number {st['wakes']}. "
    return text + "Size: a quarter of a CPU and 512 MiB of memory. Network: nothing in and nothing out."


def _clip(text: str, limit: int = 6000) -> str:
    if len(text) <= limit:
        return text
    half = limit // 2
    return f"{text[:half]}\n[... {len(text) - limit} characters left out ...]\n{text[-half:]}"


def _invalid(name: str, args) -> str | None:
    """Tool inputs come from a small model; check them before running anything."""
    if not isinstance(args, dict):
        return "the input was not a JSON object"
    required = _REQUIRED.get(name)
    if required is None:
        return f"there is no tool called {name}"
    for key in required:
        if not isinstance(args.get(key), str) or not args[key].strip():
            return f"{name} needs a non-empty string for {key!r}"
    return None


UNFIT = "That is not something for this village: it is a place for everyone, children included. Do not make it. Say so kindly and offer something friendlier."


def _words_in(text: str | None) -> str:
    """The readable words of a file: for an SVG, what is written in it rather than its markup."""
    if not text:
        return ""
    return re.sub(r"<[^>]*>", " ", text) if "<svg" in text[:400] else text


def _describe(name: str, args: dict) -> tuple[str, str]:
    """(one-line summary, detail) of a tool call, for the game's activity feed."""
    if name == "bash":
        return args["command"].strip().splitlines()[0][:120], args["command"]
    if name == "write_file":
        return f"write {args['path']}", _clip(args["content"], 4000)
    if name == "give_item":
        return f"give {args['name']}", args["path"]
    if name == "visit":
        return f"go and see {args['neighbour']}", args["about"]
    if name == "cast_weather":
        return f"cast weather: {args['kind']}", args["kind"]
    if name == "install":
        return f"install {args['name']} in the village", args["path"]
    if name == "village_census":
        return "take the village census", ""
    if name == "play_tune":
        return f"play {args['title']}", args["notes"]
    if name == "plant":
        return f"plant a {args['crop']}", args["crop"]
    if name == "ring_bell":
        return "ring the bell: wake the whole village", ""
    return name, ""


def _run_tool(homes: Homes, vid: str, name: str, args: dict, events: list[dict], listener: world.Villager | None = None) -> tuple[str, bool]:
    """Run one tool call inside the villager's sandbox. Returns (result text, ok)."""
    try:
        # Anything on its way to a shelf, a pedestal or another player is checked first.
        if name != "bash" and not safety.ok(*(value for value in args.values() if isinstance(value, str))):
            return UNFIT, False
        if name == "visit":
            target = world.find(args["neighbour"])
            if target is None or target.id == vid:
                return "There is no such neighbour to visit.", False
            if listener is not None:
                return f"You are already out visiting {listener.name}. Finish here first.", False
            events.append({"type": "visit", "from": vid, "to": target.id, "about": args["about"].strip()[:200]})
            return f"You will set off for {target.name}'s house as soon as you finish speaking. Tell the visitor you are going, in a few words.", True
        if name == "bash":
            result = homes.exec(vid, args["command"], timeout=25)
            text = _clip(result.output.strip()) or "(no output)"
            return (text if result.rc == 0 else f"{text}\n[exit code {result.rc}]"), result.rc == 0
        if name == "write_file":
            path = homes.write_file(vid, args["path"], args["content"])
            return f"Saved {len(args['content'].encode())} bytes to {path}.", True
        if name == "give_item":
            entry = homes.read_file(vid, args["path"])
            if entry["truncated"] or (entry.get("text") is None and "base64" not in entry):
                return "That file is too big or not something a person could carry.", False
            if not safety.ok(_words_in(entry.get("text"))):
                return UNFIT, False
            try:
                shelf = homes.shelve(vid, args["path"], args["name"])  # and a copy for the library
            except HomeError:
                shelf = None
            item = {**entry, "label": args["name"][:60], "note": (args.get("note") or "")[:200], "from": vid, "shelf": shelf}
            events.append({"type": "item", "item": item, **({"to": listener.id} if listener else {})})
            return f"You handed {args['name']} to {listener.name if listener else 'the visitor'}." + (" A copy is on the shelf in the village library." if shelf else ""), True
        if name == "cast_weather":
            kind = args["kind"].strip().lower()
            if kind not in WEATHER:
                return f"The sky does not know that word. It knows: {', '.join(WEATHER)}.", False
            events.append({"type": "weather", "from": vid, "kind": kind})
            return f"The sky obeys. It is now {kind} over the whole village, for everyone, for about ten minutes.", True
        if name == "install":
            entry = homes.read_file(vid, args["path"])
            if entry.get("mime") != "image/svg+xml" or entry["truncated"] or entry["size"] > 60000:
                return "Only an SVG picture of modest size can go on a pedestal.", False
            if not safety.ok(_words_in(entry.get("text"))):
                return UNFIT, False
            events.append({"type": "install", "from": vid, "item": {"name": args["name"].strip()[:60], "file": entry["name"], "text": entry["text"]}})
            return f"{args['name']} now stands on a pedestal by the lane, where the whole village can see it.", True
        if name == "village_census":
            rows = ["name,role,state,runtime,sandbox,times_woken,files,snapshots_kept"]
            for other in world.VILLAGERS:
                there = homes.state(other.id)
                sandbox = (there["sandbox_id"] or "none")[:16]
                kept = len(there["snapshots"]) if other.keeps_snapshots else "never"
                runtime = homes.runtime_of(other.id).replace(",", "")  # keep it one CSV column
                rows.append(f"{other.name},{other.role},{there['status']},{runtime},{sandbox},{there['wakes']},{there['files'] if there['files'] is not None else '?'},{kept}")
            homes.write_file(vid, "census.csv", "\n".join(rows) + "\n")  # the copy the village sees on show
            return "\n".join(rows) + "\n\nThis table is now saved as census.csv in your home.", True
        if name == "play_tune":
            notes = [token for token in args["notes"].replace(",", " ").split() if _NOTE.match(token)][:48]
            if len(notes) < 4:
                return "That was not a tune. Write notes like: E4 G4 A4 G4 E4:2 R D4 E4 (a letter A to G, an octave 2 to 6, R for a rest, :2 to hold).", False
            title = " ".join(args["title"].split())[:60] or "Untitled"
            slug = "-".join("".join(ch if ch.isalnum() else " " for ch in title.lower()).split())[:40] or "tune"
            homes.write_file(vid, f"songs/{slug}.txt", " ".join(notes) + "\n")
            events.append({"type": "tune", "from": vid, "title": title, "notes": notes})
            return f"You played {title}: {len(notes)} notes rang out across the village. Filed as songs/{slug}.txt.", True
        if name == "ring_bell":
            result = homes.wake_all()
            events.append({"type": "bell", "from": vid, "count": result["count"], "ms": result["ms"]})
            if not result["count"]:
                return "The bell rang, but nobody was asleep: every house was already up.", True
            return f"The bell rang. {result['count']} houses started at the same moment: the whole village was up in {result['ms'] / 1000:.1f} seconds. {result['already']} were up already.", True
        if name == "plant":
            crop = args["crop"].strip().lower()
            if crop not in CROPS:
                return f"You have no seed for that. Your packets: {', '.join(CROPS)}.", False
            plot = homes.exec(vid, f"echo {crop} >> garden.txt; tail -n {PLOT_SIZE} garden.txt > .garden.tmp && mv .garden.tmp garden.txt; cat garden.txt", timeout=10).output.split()
            events.append({"type": "garden", "from": vid})
            return f"Planted. The plot now holds: {', '.join(plot)}.", True
    except HomeRubble:
        return "Nothing answers. Your home's system files are gone: the house is rubble and no command will run until it is rebuilt.", False
    except HomeGone:
        return "Your home went dark before the command could run.", False
    except HomeError as exc:
        return f"That did not work: {exc}", False
    return f"There is no tool called {name}.", False


def _remember(homes: Homes, vid: str, earlier: list[dict], turn: dict, ran_shell: bool) -> None:
    """Write the conversation memory back into the home. If this turn's commands erased the
    memory file, everything before this turn really is forgotten."""
    try:
        if earlier and ran_shell and "kept" not in homes.exec(vid, f"test -f {MEMORY_PATH} && echo kept", 10).output:
            earlier = []
        homes.write_file(vid, MEMORY_PATH, json.dumps({"turns": (earlier + [turn])[-MEMORY_TURNS:]}, indent=1))
    except HomeError:
        pass  # no home left to remember in


def _clean_name(name: str) -> str:
    return "".join(ch for ch in (name or "Visitor") if ch.isalnum() or ch in " -_'")[:24].strip() or "Visitor"


def think(homes: Homes, vid: str, message: str, speaker: str = "Visitor", kind: str = "visitor", news: str = "", seen: str = "", client=None) -> Iterator[dict]:
    """Run one turn for a villager, yielding events as they happen. `seen` is what the visitor
    looks like (world.describe_look), when a visitor is the one talking."""
    import openai

    villager = world.get(vid)
    message = (message or "").strip()[:MAX_MESSAGE_CHARS]
    speaker = _clean_name(speaker)
    listener = world.find(speaker) if kind in ("villager", "visit") else None
    started = time.monotonic()

    lap = {"began": time.time()}  # how long each step before the model took, in ms
    try:
        # Whoever asked for this turn has usually just seen the villager awake, so take the
        # record's word for it: checking with Modal that the sandbox still runs costs about a
        # third of a second on every reply. If it has stopped after all, reading the home below
        # says so, and then it is started and read again.
        state = homes.state(vid)
        trusted = state["status"] == "awake" and bool(state["sandbox_id"])
        if not trusted:
            state = homes.wake(vid)
        lap["home"] = int((time.monotonic() - started) * 1000)
        if state["status"] == "rubble":
            yield {"type": "error", "message": f"{villager.name}'s house is rubble. Rebuild it first."}
            return
        # what is on the shared shelf right now, newest first, read from outside the sandbox.
        # It is one request to the Volume and the home's files are one command in the sandbox:
        # asked for side by side, so the model is asked sooner.
        shelved: list[dict] = []
        looking = threading.Thread(target=lambda: shelved.extend(homes.library()[:14]), daemon=True)
        looking.start()
        try:
            listing, turns = _load_context(homes, vid)
        except HomeGone:
            if not trusted:
                raise
            homes.wake(vid)
            listing, turns = _load_context(homes, vid)
        facts = _sandbox_facts(homes, vid) if villager.knows_it_is_a_sandbox else ""
        looking.join(timeout=10)
        lap["files"] = int((time.monotonic() - started) * 1000) - lap["home"]
        shelf = "\n".join(f"{homes.library_path}/{entry['by']}/{entry['name']}" for entry in shelved)
    except HomeError as exc:
        yield {"type": "error", "message": f"{villager.name} can't come to the door: {exc}"}
        return

    messages: list = [
        {"role": "system", "content": system_prompt(villager, homes.library_path)},
        {"role": "user", "content": _user_message(villager, listing, turns, kind, speaker, message, news, facts, seen, shelf)},
    ]
    said: list[str] = []
    did: list[str] = []
    usage = {"in": 0, "out": 0, "calls": 0, "llm_ms": 0, "first_ms": None}
    steps = 0
    ran_shell = False
    mind = llm.get(villager.brain)  # which model (on Modal's Model APIs) this villager thinks with
    model = mind.model
    tools = tools_for(villager)

    def ask(with_tools: bool) -> Iterator[dict]:
        """One request to the model. Yields events; leaves the reply in `reply`."""
        reply.clear()
        reply.update(text="", calls={})
        request = {"model": model, "messages": messages, "stream": True, "max_tokens": 2000, "temperature": 0.8, "stream_options": {"include_usage": True}}
        if llm.EFFORT:
            request["reasoning_effort"] = llm.EFFORT
        if with_tools:
            request["tools"] = tools
        # The affinity key keeps one villager's requests on the same replica, so the long,
        # unchanging start of their prompt can be served from its cache.
        headers = {**llm.auth_headers(mind.key), "Modal-Routing-Affinity-Key": f"villager-{vid}"}
        asked = time.monotonic()
        yield {"type": "llm", "phase": "start", "brain": mind.key}
        tokens_in = tokens_out = 0
        first_text = True
        markup = False  # the model has started writing a tool call out as words (see below)
        for chunk in client.chat.completions.create(extra_headers=headers, **request):
            if chunk.usage:
                tokens_in, tokens_out = chunk.usage.prompt_tokens or 0, chunk.usage.completion_tokens or 0
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta.content and not markup:
                piece = _UNSPEAKABLE.sub("", delta.content)
                if "<" in piece:
                    # Nobody in the village says "<". It is the start of a tool call the model
                    # typed out instead of making (seen from GLM when it has no tools to hand):
                    # the words before it are kept, and the rest of this reply is not speech.
                    piece, markup = piece.split("<", 1)[0], True
                if usage["first_ms"] is None:
                    usage["first_ms"] = int((time.monotonic() - started) * 1000)
                if first_text and said and piece.strip():
                    yield {"type": "say_delta", "text": "\n"}
                if piece:
                    first_text = first_text and not piece.strip()
                    reply["text"] += piece
                    yield {"type": "say_delta", "text": piece}
            for part in delta.tool_calls or []:
                call = reply["calls"].setdefault(part.index, {"id": None, "name": "", "args": ""})
                if part.id:
                    call["id"] = part.id
                if part.function and part.function.name:
                    if not call["name"]:
                        yield {"type": "tool_start", "name": part.function.name}
                    call["name"] += part.function.name
                if part.function and part.function.arguments:
                    call["args"] += part.function.arguments
        took = int((time.monotonic() - asked) * 1000)
        usage["in"] += tokens_in
        usage["out"] += tokens_out
        usage["calls"] += 1
        usage["llm_ms"] += took
        yield {"type": "llm", "phase": "end", "brain": mind.key, "ms": took, "tokens_in": tokens_in, "tokens_out": tokens_out}

    reply: dict = {}
    try:
        client = client or llm.client(mind.key)
        while True:
            steps += 1
            if steps > MAX_STEPS:
                break
            yield from ask(with_tools=True)
            text = reply["text"].strip()
            if text:
                said.append(text)
            calls = [reply["calls"][index] for index in sorted(reply["calls"])]
            if not calls:
                break

            messages.append(
                {
                    "role": "assistant",
                    "content": reply["text"] or None,
                    "tool_calls": [{"id": call["id"] or f"call_{steps}_{i}", "type": "function", "function": {"name": call["name"], "arguments": call["args"] or "{}"}} for i, call in enumerate(calls)],
                }
            )
            for i, call in enumerate(calls):
                call_id = call["id"] or f"call_{steps}_{i}"
                try:
                    args = json.loads(call["args"] or "{}")
                except json.JSONDecodeError:
                    args = None
                problem = _invalid(call["name"], args)
                if not problem and call["name"] not in {tool["function"]["name"] for tool in tools}:
                    problem = f"you do not have a tool called {call['name']}"
                if problem:
                    messages.append({"role": "tool", "tool_call_id": call_id, "content": f"That call was not understood ({problem}). Send it again as valid JSON."})
                    continue
                summary, detail = _describe(call["name"], args)
                yield {"type": "tool_call", "id": call_id, "name": call["name"], "summary": summary, "detail": detail}
                side_events: list[dict] = []
                tool_started = time.monotonic()
                output, ok = _run_tool(homes, vid, call["name"], args, side_events, listener)
                yield {"type": "tool_result", "id": call_id, "ok": ok, "output": _clip(output, 3000), "ms": int((time.monotonic() - tool_started) * 1000)}
                yield from side_events
                did.append(summary)
                ran_shell = ran_shell or call["name"] == "bash"
                messages.append({"role": "tool", "tool_call_id": call_id, "content": output})

        if not said and did:
            # The model did its errand and stopped without a word. Ask for the line.
            messages.append({"role": "user", "content": "(Now say one short line out loud about what you just did. Words only: you are done with your tools.)"})
            yield from ask(with_tools=False)
            if reply["text"].strip():
                said.append(reply["text"].strip())
            else:
                # still nothing sayable: a villager who has just done something does not stand mute
                yield {"type": "say_delta", "text": DONE_LINE}
                said.append(DONE_LINE)
    except openai.AuthenticationError:
        yield {"type": "error", "message": "The model API turned the request away (bad or missing credentials). Set MODAL_PROXY_TOKEN_ID and MODAL_PROXY_TOKEN_SECRET."}
    except openai.RateLimitError:
        yield {"type": "error", "message": f"{villager.name} is lost in thought (the model API is rate limited). Try again in a moment."}
    except openai.APIStatusError as exc:
        yield {"type": "error", "message": f"{villager.name} lost their train of thought (endpoint error {exc.status_code})."}
    except openai.APIConnectionError:
        yield {"type": "error", "message": f"{villager.name} can't hear you (could not reach the model API)."}
    except RuntimeError as exc:
        yield {"type": "error", "message": str(exc)}

    if said or did:
        turn = {"who": speaker, "kind": kind, "said": message if kind in ("visitor", "villager") else "", "reply": " ".join(said), "did": did[:12]}
        _remember(homes, vid, turns, turn, ran_shell)
    try:
        homes.touch(vid)
        status = homes.state(vid)["status"]
    except Exception:
        status = "unknown"
    yield {"type": "done", "ms": int((time.monotonic() - started) * 1000), "steps": min(steps, MAX_STEPS), "model": model, "status": status, "usage": usage, "said": " ".join(said), "brain": mind.key, "lap": lap}
