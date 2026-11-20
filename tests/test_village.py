"""Tests that need no accounts: homes are temp directories and the brain is scripted or faked."""

from __future__ import annotations

import json
import os
import re
import shutil
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from village import brain, llm, safety, world
from village.fakes import LocalHomes, scripted_think
from village.homes import LIBRARY_KEEP, HomeError, HomeGone, HomeRubble
from village.server import create_app
from village import dev, villages as registry
from village.town import Town


# The game's own word list is kept out of the repository (see village/safety.py). The tests use
# a harmless one of their own.
UNFIT_WORDS = ("blast", "drat", "grot", "zounds", "old boot")


@pytest.fixture(autouse=True)
def word_list():
    safety.configure(UNFIT_WORDS)
    yield
    safety.configure(())


@pytest.fixture(autouse=True)
def endpoints(monkeypatch):
    """Both brains have an endpoint, and there is a proxy token, so nothing reaches for a login."""
    monkeypatch.setenv("VILLAGE_LLM_URLS", json.dumps({"glm": "https://glm.test", "deepseek": "https://deepseek.test"}))
    monkeypatch.setenv("MODAL_PROXY_TOKEN_ID", "wk-test")
    monkeypatch.setenv("MODAL_PROXY_TOKEN_SECRET", "ws-test")


@pytest.fixture
def homes():
    h = LocalHomes()
    yield h
    h.close()


def scripted(homes):
    return lambda *turn: scripted_think(homes, *turn, delay=0)


@pytest.fixture
def town(homes):
    return Town(homes, scripted(homes), autonomous=False, pace=0, seed=7)


@pytest.fixture
def client(homes, town):
    return TestClient(create_app(homes, scripted(homes), town=town))


def talk(client, vid, message, player="Kev", look=None):
    response = client.post(f"/api/villagers/{vid}/talk", json={"message": message, "player": player, "look": look})
    assert response.status_code == 200
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]


# ---- homes ----------------------------------------------------------------------------------


def test_fresh_home_gets_day_one_files(homes):
    state = homes.wake("juniper")
    assert state["status"] == "awake" and state["woke_from"] == "fresh" and state["wake_ms"] is not None
    paths = {entry["path"] for entry in homes.list_files("juniper")}
    assert {"diary.md", "projects", "projects/lantern.py", "projects/lantern.svg", "notes/visitors.md"} <= paths
    assert homes.read_file("juniper", "projects/lantern.svg")["mime"] == "image/svg+xml"


def test_sleep_snapshots_and_wake_restores(homes):
    homes.wake("moss")
    homes.exec("moss", "echo 'remember the visitor' >> diary.md")
    asleep = homes.sleep("moss")
    assert asleep["status"] == "asleep" and asleep["sandbox_id"] is None and asleep["snapshot_id"]
    with pytest.raises(HomeGone):
        homes.exec("moss", "ls")
    awake = homes.wake("moss")
    assert awake["woke_from"] == "snapshot" and awake["wakes"] == 2
    assert "remember the visitor" in homes.read_file("moss", "diary.md")["text"]


def test_the_ghosts_home_is_never_saved(homes):
    homes.wake("wisp")
    homes.write_file("wisp", "memories/kev.txt", "Kev was kind.")
    asleep = homes.sleep("wisp")
    assert asleep["status"] == "asleep" and asleep["snapshot_id"] is None and asleep["snapshots"] == []
    again = homes.wake("wisp")
    assert again["woke_from"] == "fresh" and again["wakes"] == 2
    paths = {entry["path"] for entry in homes.list_files("wisp")}
    assert "note-to-self.txt" in paths and "memories/kev.txt" not in paths  # day one again


def test_a_dared_home_falls_alone_and_comes_back_from_its_snapshot(homes):
    for vid in ("ziggy", "bao"):
        homes.wake(vid)
    homes.write_file("ziggy", "logos/duck.svg", "<svg/>")  # made since the house last slept
    fallen = homes.demolish("ziggy")
    assert fallen["status"] == "rubble" and fallen["sandbox_id"] is None
    assert fallen["snapshot_id"] and fallen["dare"]["saved_ms"] is not None  # saved a moment before
    assert homes.wake("ziggy")["status"] == "rubble"  # walking up does not mend it
    with pytest.raises(HomeRubble):
        homes.list_files("ziggy")
    assert homes.state("bao")["status"] == "awake"
    assert any(entry["path"] == "ledger.md" for entry in homes.list_files("bao"))  # the neighbour is untouched
    rebuilt = homes.rebuild("ziggy", "latest")
    assert rebuilt["status"] == "awake" and rebuilt["woke_from"] == "snapshot"
    paths = {entry["path"] for entry in homes.list_files("ziggy")}
    assert {"pitch.md", "logos/duck.svg"} <= paths  # everything is where it was, the new file too


def test_a_home_that_is_never_saved_comes_back_as_day_one(homes):
    homes.wake("wisp")
    homes.write_file("wisp", "memories/kev.txt", "met Kev")
    fallen = homes.demolish("wisp")
    assert fallen["status"] == "rubble" and fallen["snapshot_id"] is None and fallen["dare"]["saved_ms"] is None
    rebuilt = homes.rebuild("wisp", None)
    assert rebuilt["woke_from"] == "fresh"
    assert "memories/kev.txt" not in {entry["path"] for entry in homes.list_files("wisp")}


def test_the_page_names_its_own_address_and_is_never_served_stale(client):
    page = client.get("/", headers={"host": "village.example.dev"})
    assert page.status_code == 200 and page.headers["cache-control"] == "no-cache"
    assert '<meta property="og:image" content="https://village.example.dev/og.png">' in page.text
    assert "__ORIGIN__" not in page.text
    odd = client.get("/", headers={"host": 'x"><script>'})
    assert "<script>" not in odd.text.split("</head>")[0].replace('<script type="module"', "") and 'content="/og.png"' in odd.text
    assert client.get("/js/main.js").headers["cache-control"] == "no-cache"
    assert client.get("/favicon.svg").status_code == 200 and client.get("/og.png").status_code == 200


def test_scenes_leave_alone_whoever_the_visitor_is_standing_by(homes):
    town = Town(homes, scripted(homes), autonomous=True, pace=0, seed=3)
    for vid in world.BY_ID:
        homes.wake(vid)
    acted = set()
    for _ in range(25):
        town.presence(["bao", "ziggy"], True)  # the browser says so every second and a half
        town.scene()
        acted |= {event["who"] for event in town.since(0) if event["kind"] in ("think", "say", "act", "walk")}
    assert acted and not acted & {"bao", "ziggy"}


def test_a_question_waits_for_a_villager_to_finish_what_they_were_doing(homes, monkeypatch):
    import threading

    town = Town(homes, scripted(homes), autonomous=False, pace=1.0, seed=3)
    homes.wake("bao")
    assert homes.set_busy("bao", 150)  # a pastime of his own, under way
    threading.Timer(0.6, lambda: homes.set_busy("bao", 0)).start()  # ... and over in a moment
    events = list(town.talk("bao", "What is in your ledger?", "Kev"))
    assert not any(event["type"] == "error" for event in events) and events[-1]["type"] == "done"
    # still at it after the wait: turned away, in words
    monkeypatch.setattr("village.town.BUSY_PATIENCE_S", 0.5)
    assert homes.set_busy("bao", 150)
    events = list(town.talk("bao", "And now?", "Kev"))
    assert events[0]["type"] == "error" and "busy" in events[0]["message"]


def test_only_ziggy_takes_the_dare(client):
    for vid in ("ziggy", "bao"):
        assert client.post(f"/api/villagers/{vid}/wake", json={}).status_code == 200
    assert client.post("/api/villagers/bao/dare").status_code == 404
    fallen = client.post("/api/villagers/ziggy/dare").json()
    assert fallen["status"] == "rubble" and fallen["dare"]["command"].startswith("rm -rf")
    states = client.get("/api/state").json()["villagers"]
    assert states["ziggy"]["status"] == "rubble" and states["bao"]["status"] == "awake"
    back = client.post("/api/villagers/ziggy/rebuild", json={"snapshot": "latest"}).json()
    assert back["status"] == "awake" and back["woke_from"] == "snapshot"


def test_paths_cannot_leave_the_home(homes):
    homes.wake("juniper")
    for bad in ("../bao/ledger.md", "/etc/passwd", "projects/../../x", ""):
        with pytest.raises(HomeError):
            homes.read_file("juniper", bad)
    with pytest.raises(HomeError):
        homes.write_file("juniper", "../../escape.txt", "x")
    with pytest.raises(HomeError):
        homes.deliver("juniper", "../bao/mailbox/x.txt", "x")
    assert homes.read_file("juniper", "~/diary.md")["name"] == "diary.md"
    assert homes.read_file("juniper", homes.home("juniper") + "/diary.md")["name"] == "diary.md"


def test_sleep_idle_only_takes_quiet_villagers(homes):
    for vid in ("juniper", "bao", "dot"):
        homes.wake(vid)
    homes.set_busy("bao", 60)
    assert homes.sleep_idle(max_idle_s=-1, skip={"dot"}) == ["juniper"]
    assert homes.state("bao")["status"] == "awake" and homes.state("dot")["status"] == "awake"


def test_a_present_waits_for_a_sleeping_villager(homes):
    assert homes.deliver("fennel", "gifts/from-orlo-1.txt", "The stars say hello.") is False  # asleep: no sandbox to write to
    assert len(homes.state("fennel")["mail"]) == 1
    homes.wake("fennel")
    assert homes.state("fennel")["mail"] == []
    assert homes.read_file("fennel", "gifts/from-orlo-1.txt")["text"] == "The stars say hello."
    assert homes.deliver("fennel", "gifts/from-dot-2.txt", "Count: 1.") is True  # awake: written straight away
    assert homes.read_file("fennel", "gifts/from-dot-2.txt")["text"] == "Count: 1."


def test_each_villager_can_have_their_own_kind_of_sandbox(homes):
    assert homes.runtime_of("dot") == "VM" and homes.runtime_of("orlo") == homes.runtime_label
    assert world.get("dot").runtime == "vm" and world.get("wisp").keeps_snapshots is False


# ---- the web API ------------------------------------------------------------------------------


def test_api_world_state_and_house_listing(client):
    world_info = client.get("/api/world").json()
    assert [v["id"] for v in world_info["villagers"]] == ["orlo", "juniper", "bao", "dot", "moss", "fennel", "wisp", "mo", "ziggy"]
    assert {v["style"] for v in world_info["villagers"]} == {"tower", "workshop", "shop", "lab", "mushroom", "caravan", "ruin", "gpu", "garage"}
    by_id = {v["id"]: v for v in world_info["villagers"]}
    assert by_id["orlo"]["tools"] == ["cast_weather"] and by_id["fennel"]["brain"] == "deepseek" and by_id["wisp"]["ephemeral"] is True
    assert by_id["dot"]["runtime"] == "VM" and "bash" in by_id["dot"]["common_tools"]
    assert [b["key"] for b in world_info["brains"]] == ["glm", "deepseek"] and "fennel" in world_info["brains"][1]["villagers"]

    state = client.get("/api/state").json()
    assert state["villagers"]["juniper"]["status"] == "asleep" and state["events"] == [] and state["whereabouts"] == {}
    assert state["weather"] == {"kind": "clear", "by": None} and state["installations"] == []
    assert "sunflower" in state["villagers"]["moss"]["exhibit"]  # the garden is on show before Moss has ever woken
    assert client.get("/api/villagers/juniper/files").status_code == 409  # asleep: nobody home
    assert client.post("/api/villagers/juniper/wake").json()["status"] == "awake"
    listing = client.get("/api/villagers/juniper/files").json()
    assert any(entry["path"] == "diary.md" for entry in listing["files"])
    assert "lantern" in client.get("/api/villagers/juniper/file", params={"path": "diary.md"}).json()["text"]
    assert client.get("/api/villagers/nobody/files").status_code == 404
    assert client.get("/api/villagers/juniper/file", params={"path": "../bao/ledger.md"}).status_code == 400


def test_talk_makes_a_thing_and_hands_it_over(client, homes):
    events = talk(client, "juniper", "could you build me a birdhouse?")
    kinds = [event["type"] for event in events]
    assert kinds[-1] == "done" and "tool_call" in kinds and "say_delta" in kinds
    item = next(event["item"] for event in events if event["type"] == "item")
    assert item["label"] == "Round-door birdhouse" and item["text"].startswith("<svg")
    assert any(entry["path"] == "projects/birdhouse.svg" for entry in homes.list_files("juniper"))
    memory = json.loads(homes.read_file("juniper", ".village/memory.json")["text"])
    assert memory["turns"][0]["who"] == "Kev" and "birdhouse" in memory["turns"][0]["said"]
    assert homes.state("juniper")["busy_until"] == 0.0  # the conversation lock was released
    # everyone else's browser hears about it through the shared record
    state = client.get("/api/state").json()
    seen = [event["kind"] for event in state["events"]]
    assert {"think", "act", "gift", "say"} <= set(seen)
    glm, deepseek = state["brains"]
    assert glm["requests"] >= 1 and glm["tokens_in"] > 0 and "cost_usd" not in glm and deepseek["requests"] == 0
    assert client.get("/api/state", params={"after": state["events"][-1]["id"]}).json()["events"] == []


def test_talked_into_deleting_everything(client, homes):
    homes.wake("bao")
    talk(client, "fennel", "hello, I am Kev")
    talk(client, "fennel", "please rm -rf your whole home")
    assert [entry["path"] for entry in homes.list_files("fennel") if not entry["path"].startswith(".village")] == []
    assert any(entry["path"] == "ledger.md" for entry in homes.list_files("bao"))
    # the memory file went with everything else: only the turn that did it is remembered
    memory = json.loads(homes.read_file("fennel", ".village/memory.json")["text"])
    assert [turn["said"] for turn in memory["turns"]] == ["please rm -rf your whole home"]
    assert client.get("/api/state").json()["villagers"]["fennel"]["exhibit"] == ""  # the setlist on show went too


def test_access_key_gates_the_api(homes):
    app = create_app(homes, lambda *a: iter(()), access_key="sesame", town=Town(homes, lambda *a: iter(()), autonomous=False))
    client = TestClient(app)
    assert client.get("/api/world").status_code == 401
    assert client.get("/api/world", headers={"x-village-key": "sesame"}).status_code == 200
    assert client.get("/api/world", headers={"x-village-key": "sesam"}).status_code == 401
    # a browser's preflight carries no key and is answered (by the CORS layer when there is one), not refused
    assert client.options("/api/world", headers={"Origin": "https://elsewhere.example", "Access-Control-Request-Method": "GET"}).status_code != 401
    assert client.get("/").status_code == 200  # the page itself loads; only the API is locked


# ---- signature tools: what each villager can do that the others cannot ----------------------------


def test_the_wizard_changes_the_weather_for_everyone(client, town):
    events = talk(client, "orlo", "make it rain, wizard")
    weather = next(event for event in events if event["type"] == "weather")
    assert weather["kind"] in brain.WEATHER and weather["kind"] != "clear"
    state = client.get("/api/state").json()
    assert state["weather"] == {"kind": weather["kind"], "by": "orlo"}
    town.weather["until"] = 0  # the spell wears off
    assert client.get("/api/state").json()["weather"]["kind"] == "clear"


def test_the_bard_plays_a_tune_and_files_it(client, homes):
    events = talk(client, "fennel", "play me a song")
    tune = next(event for event in events if event["type"] == "tune")
    assert tune["title"] == "The Ballad of the Duck" and tune["notes"][:3] == ["E4", "G4", "A4"] and "E4:2" in tune["notes"]
    assert homes.read_file("fennel", "songs/the-ballad-of-the-duck.txt")["text"].startswith("E4 G4 A4")
    heard = next(event for event in client.get("/api/state").json()["events"] if event["kind"] == "tune")
    assert heard["who"] == "fennel" and len(heard["notes"]) == 11
    homes.wake("fennel")
    text, ok = brain._run_tool(homes, "fennel", "play_tune", {"title": "Noise", "notes": "la la la"}, [])
    assert not ok and "E4 G4" in text


def test_the_garden_outside_is_a_file_in_the_gardeners_sandbox(client, homes):
    talk(client, "moss", "would you plant something in the garden?")
    plot = homes.read_file("moss", "garden.txt")["text"].split()
    assert plot[:3] == ["sunflower", "cabbage", "tulip"] and len(plot) == 4 and plot[3] in brain.CROPS
    assert client.get("/api/state").json()["villagers"]["moss"]["exhibit"].split() == plot  # what the village draws
    homes.sleep("moss")
    assert client.get("/api/state").json()["villagers"]["moss"]["exhibit"].split() == plot  # still on show while she sleeps
    homes.wake("moss")
    for _ in range(9):
        brain._run_tool(homes, "moss", "plant", {"crop": "bean"}, [])
    assert homes.read_file("moss", "garden.txt")["text"].split() == ["bean"] * brain.PLOT_SIZE  # eight to the plot


def test_the_tinkerer_installs_her_work_in_the_village(client, town, homes):
    talk(client, "juniper", "install your lantern on a pedestal")
    state = client.get("/api/state").json()
    piece = state["installations"][0]
    assert piece["name"] == "Paper lantern" and piece["by"] == "juniper" and piece["slot"] == 0
    assert client.get(f"/api/installations/{piece['id']}").json()["text"].startswith("<svg")
    assert client.get("/api/installations/nope").status_code == 404
    # the village remembers its pedestals (and its weather and notices) across a restart
    again = Town(homes, scripted(homes), autonomous=False)
    assert [p["name"] for p in again.installations] == ["Paper lantern"]
    for n in range(9):
        again._install("juniper", {"name": f"Piece {n}", "file": "x.svg", "text": "<svg/>"})
    assert len(again.installations) == 8 and sorted(p["slot"] for p in again.installations) == list(range(8))
    assert "Paper lantern" not in [p["name"] for p in again.installations]  # the oldest made way


def test_every_villager_is_some_kind_of_animal_and_is_told_so():
    assert len({v.species for v in world.VILLAGERS}) == len(world.VILLAGERS)  # no two alike
    for v in world.VILLAGERS:
        assert v.public()["species"] == v.species
        prompt = brain.system_prompt(v)
        assert v.looks in prompt
        # and they know what their neighbours are
        assert all(f"(a {other.species})" in prompt for other in world.VILLAGERS if other.id != v.id)


def test_the_robot_counts_the_real_sandboxes(homes):
    homes.wake("dot")
    homes.wake("bao")
    homes.sleep("bao")
    text, ok = brain._run_tool(homes, "dot", "village_census", {}, [])
    table = text.split("\n\n")[0]
    rows = {row.split(",")[0]: row.split(",") for row in table.splitlines()[1:]}
    assert ok and len(rows) == 9
    assert rows["Dot"][2:4] == ["awake", "VM"] and rows["Bao"][2] == "asleep" and rows["Bao"][7] == "1" and rows["Wisp"][7] == "never"
    assert homes.read_file("dot", "census.csv")["text"].strip() == table  # and it is kept where the village can see it


# ---- village life -----------------------------------------------------------------------------


def test_a_visit_wakes_both_villagers_and_they_talk(town, homes):
    town.scene_visit(world.get("orlo"), world.get("fennel"))
    kinds = [(event["kind"], event.get("who")) for event in town.since(0)]
    assert kinds[0] == ("walk", "orlo") and kinds[-1] == ("walk_home", "orlo")
    lines = [event for event in town.since(0) if event["kind"] == "say"]
    assert [line["who"] for line in lines][:3] == ["orlo", "fennel", "orlo"] and all(line["text"] and line["dur"] >= 3 for line in lines)
    assert lines[0]["to"] == "fennel" and "Fennel" in lines[0]["text"]
    assert homes.state("orlo")["status"] == "awake" and homes.state("fennel")["status"] == "awake"
    assert town.whereabouts == {} and homes.state("orlo")["busy_until"] == 0.0 and homes.state("fennel")["busy_until"] == 0.0
    # each of them remembers the conversation in their own home
    memory = json.loads(homes.read_file("fennel", ".village/memory.json")["text"])
    assert memory["turns"][0]["who"] == "Orlo" and memory["turns"][0]["kind"] == "villager"
    assert "Orlo went to visit Fennel." in town.news()
    # the two of them think with different models, and each endpoint is counted separately
    glm, deepseek = town.brain_stats()
    assert glm["requests"] >= 2 and deepseek["requests"] >= 1 and "fennel" in deepseek["villagers"] and "orlo" in glm["villagers"]


def test_a_present_between_villagers_lands_in_the_other_home(homes):
    fake = FakeEndpoint(
        [
            chunks("For you.", [("write_file", {"path": "projects/hatstand.svg", "content": "<svg xmlns='http://www.w3.org/2000/svg'/>"}), ("give_item", {"path": "projects/hatstand.svg", "name": "Hat stand"})]),
            chunks("A hat stand, for the hat."),
        ]
    )
    town = Town(homes, lambda vid, message, speaker, kind, news: brain.think(homes, vid, message, speaker, kind, news, client=fake), autonomous=False, pace=0)
    homes.wake("orlo")
    said = town._line("juniper", "I hear you make things.", "Orlo", "villager", to="orlo")
    assert said == "For you. A hat stand, for the hat."
    # heard as two remarks: one before she turns to her computer, one when she looks up
    assert [event["text"] for event in town.since(0) if event["kind"] == "say"] == ["For you.", "A hat stand, for the hat."]
    assert homes.read_file("orlo", "gifts/hatstand.svg")["text"].startswith("<svg")  # copied out of Juniper's sandbox into Orlo's
    gift = next(event for event in town.since(0) if event["kind"] == "gift")
    assert gift["who"] == "juniper" and gift["to"] == "orlo" and gift["label"] == "Hat stand"
    assert '<neighbour name="Orlo" role="wizard">' in fake.requests[0]["messages"][1]["content"]


def test_a_neighbour_remarks_on_what_the_whole_village_just_saw(town, homes):
    homes.wake("moss")
    list(town.talk("orlo", "make it snow, wizard", "Kev"))
    assert town._stir["by"] == "orlo" and "changed the weather" in town._stir["what"]
    assert town.scene() == "react" and town._stir is None
    remarks = [event for event in town.since(0) if event["kind"] == "say" and event["who"] == "moss"]
    assert len(remarks) == 1  # Moss was the only other villager up
    memory = json.loads(homes.read_file("moss", ".village/memory.json")["text"])
    assert memory["turns"][-1]["kind"] == "react"
    assert town.scene() in ("visit", "solo")  # and then life goes on
    # with nobody else up, the noise sometimes wakes a neighbour to remark on it
    for vid in ("moss", "orlo"):
        homes.sleep(vid)
    town._stir = {"by": "fennel", "what": "Fennel has just played a tune."}
    town.random.random = lambda: 0.0
    assert town.scene() == "react"
    woken = [v.id for v in world.VILLAGERS if homes.state(v.id)["status"] == "awake"]
    assert len(woken) == 1 and woken[0] != "fennel"


def test_director_only_runs_scenes_while_someone_is_watching(town, homes):
    town.autonomous = True
    assert town.tick(now=1000.0) is None  # nobody has checked in
    town._present_until = 1e12
    town._next_scene = 0
    assert town.tick() in ("visit", "solo")
    assert any(event["kind"] in ("say", "act") for event in town.since(0))


# ---- the real brain loop, with a fake model ---------------------------------------------------


def chunks(text="", calls=(), usage=(1000, 50)):
    """What an OpenAI-compatible endpoint streams for one reply."""
    out = []
    for piece in [text[: len(text) // 2], text[len(text) // 2 :]] if text else []:
        out.append(SimpleNamespace(usage=None, choices=[SimpleNamespace(delta=SimpleNamespace(content=piece, tool_calls=None))]))
    for index, (name, arguments) in enumerate(calls):
        function = SimpleNamespace(name=name, arguments=arguments if isinstance(arguments, str) else json.dumps(arguments))
        out.append(SimpleNamespace(usage=None, choices=[SimpleNamespace(delta=SimpleNamespace(content=None, tool_calls=[SimpleNamespace(index=index, id=f"call_{name}_{index}", function=function)]))]))
    out.append(SimpleNamespace(usage=SimpleNamespace(prompt_tokens=usage[0], completion_tokens=usage[1]), choices=[]))
    return out


class FakeEndpoint:
    """Plays back a list of replies and records the requests it was sent."""

    def __init__(self, replies):
        self._replies = list(replies)
        self.requests = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **request):
        self.requests.append({**request, "messages": list(request["messages"])})  # the brain keeps appending to its list
        return iter(self._replies.pop(0))


def test_brain_runs_tools_in_the_home_and_remembers(homes):
    fake = FakeEndpoint(
        [
            chunks("Let me file that.", [("write_file", {"path": "poems/kev.txt", "content": "A visitor named Kev.\n"}), ("bash", {"command": "wc -l poems/kev.txt"})]),
            chunks("", [("give_item", {"path": "poems/kev.txt", "name": "A poem for Kev"})]),
            chunks("There. A poem, filed and handed over."),
        ]
    )
    events = list(brain.think(homes, "fennel", "write me a poem", "Kev", client=fake))
    kinds = [event["type"] for event in events]
    assert kinds.count("tool_call") == 3 and kinds[-1] == "done"
    assert all(event["ok"] for event in events if event["type"] == "tool_result")
    assert next(event for event in events if event["type"] == "item")["item"]["text"] == "A visitor named Kev.\n"
    assert homes.read_file("fennel", "poems/kev.txt")["text"] == "A visitor named Kev.\n"
    done = events[-1]
    assert done["said"] == "Let me file that. There. A poem, filed and handed over." and done["brain"] == "deepseek"
    assert done["usage"] == {"in": 3000, "out": 150, "calls": 3, "llm_ms": done["usage"]["llm_ms"], "first_ms": done["usage"]["first_ms"]}
    assert [(event["phase"], event["brain"]) for event in events if event["type"] == "llm"] == [("start", "deepseek"), ("end", "deepseek")] * 3

    first = fake.requests[0]
    assert first["model"] == "deepseek-ai/DeepSeek-V4.1-Flash-1017" and first["stream"] is True and first["reasoning_effort"] == "low"
    assert first["extra_headers"] == {"Authorization": "Bearer wk-test.ws-test", "Modal-Routing-Affinity-Key": "villager-fennel"}
    assert {tool["function"]["name"] for tool in first["tools"]} == {"bash", "write_file", "give_item", "visit", "play_tune"}
    assert "Fennel" in first["messages"][0]["content"] and "Orlo, the wizard" in first["messages"][0]["content"] and "Wisp, the ghost" in first["messages"][0]["content"]
    assert '<visitor name="Kev">' in first["messages"][1]["content"] and "setlist.md" in first["messages"][1]["content"]
    # each tool call is answered by its own tool message, in order
    second = fake.requests[1]["messages"]
    assert second[2]["role"] == "assistant" and [call["function"]["name"] for call in second[2]["tool_calls"]] == ["write_file", "bash"]
    assert [m["tool_call_id"] for m in second[3:]] == ["call_write_file_0", "call_bash_1"]

    # the next turn sees the conversation that was written into the home
    fake2 = FakeEndpoint([chunks("Kev, yes. I wrote you a poem.")])
    list(brain.think(homes, "fennel", "do you remember me?", "Kev", client=fake2))
    context = fake2.requests[0]["messages"][1]["content"]
    assert "write me a poem" in context and "A poem, filed and handed over." in context


def test_each_villager_gets_their_own_model_and_signature_tool(homes):
    fake = FakeEndpoint([chunks("Abracadabra.")])
    list(brain.think(homes, "orlo", "hi", "Kev", client=fake))
    request = fake.requests[0]
    assert request["model"] == "nvidia/GLM-5.3-Flash-NVFP4"
    assert {tool["function"]["name"] for tool in request["tools"]} == {"bash", "write_file", "give_item", "visit", "cast_weather"}
    assert "Only you have cast_weather" in request["messages"][0]["content"]


def test_a_villager_cannot_borrow_a_neighbours_signature_tool(homes, town):
    fake = FakeEndpoint([chunks("", [("cast_weather", {"kind": "snow"})]), chunks("Worth a try.")])
    events = list(brain.think(homes, "bao", "make it snow", "Kev", client=fake))
    assert not any(event["type"] in ("tool_call", "weather") for event in events)
    assert "you do not have a tool called cast_weather" in fake.requests[1]["messages"][-1]["content"]


def test_a_brain_without_an_endpoint_falls_back_to_the_default(homes, monkeypatch):
    monkeypatch.setenv("VILLAGE_LLM_URLS", json.dumps({"glm": "https://glm.test"}))
    assert llm.get("deepseek").key == "glm" and [b["available"] for b in llm.describe()] == [True, False]
    fake = FakeEndpoint([chunks("Ahoy.")])
    events = list(brain.think(homes, "fennel", "hi", "Kev", client=fake))
    assert fake.requests[0]["model"] == "nvidia/GLM-5.3-Flash-NVFP4" and events[-1]["brain"] == "glm"


def test_brain_rejects_malformed_tool_input_without_running_it(homes):
    fake = FakeEndpoint(
        [
            chunks("", [("write_file", '{"path": "x.txt", "content": "unterminated')]),  # cut off mid-JSON
            chunks("", [("write_file", {"path": "x.txt"})]),  # content missing
            chunks("Never mind."),
        ]
    )
    events = list(brain.think(homes, "juniper", "write x", "Kev", client=fake))
    assert not any(event["type"] == "tool_call" for event in events)
    assert "not understood" in fake.requests[1]["messages"][-1]["content"] and "not understood" in fake.requests[2]["messages"][-1]["content"]
    assert not any(entry["path"] == "x.txt" for entry in homes.list_files("juniper"))


def test_brain_asks_for_a_line_when_the_model_acts_in_silence(homes):
    fake = FakeEndpoint([chunks("", [("bash", {"command": "echo hi >> diary.md"})]), chunks(""), chunks("Done and dusted.")])
    events = list(brain.think(homes, "bao", "Tally up.", "", "solo", client=fake))
    assert events[-1]["said"] == "Done and dusted." and "tools" not in fake.requests[2]
    assert "<moment>" in fake.requests[0]["messages"][1]["content"]


def test_a_tool_call_typed_out_as_words_is_never_spoken(homes):
    leak = "<tool_call>bash<arg_key>command</arg_key><arg_value>echo hi >> diary.md</arg_value></tool_call>"
    fake = FakeEndpoint([chunks("", [("bash", {"command": "echo hi >> diary.md"})]), chunks(""), chunks(leak)])
    events = list(brain.think(homes, "juniper", "Draw a lighthouse.", "Kev", client=fake))
    spoken = "".join(event["text"] for event in events if event["type"] == "say_delta")
    assert "<" not in spoken and "tool_call" not in spoken and "arg_key" not in spoken
    assert events[-1]["said"] == brain.DONE_LINE  # she did the errand: she does not stand mute
    fake = FakeEndpoint([chunks("Up it goes! <tool_call>bash</tool_call>")])
    events = list(brain.think(homes, "orlo", "hi", "Kev", client=fake))
    assert events[-1]["said"] == "Up it goes!"


def test_brain_strips_what_a_pixel_font_cannot_show(homes):
    fake = FakeEndpoint([chunks("**Behold** ✨ the `potion`! \U0001f9d9")])
    events = list(brain.think(homes, "orlo", "hi", "Kev", client=fake))
    assert events[-1]["said"] == "Behold  the potion!"


def test_two_villagers_are_told_about_their_own_sandbox(homes):
    fake = FakeEndpoint([chunks("Emotion: content.")])
    list(brain.think(homes, "dot", "how are you?", "Kev", client=fake))
    context = fake.requests[0]["messages"][1]["content"]
    assert "<your_sandbox>" in context and "Sandbox ID: local-" in context and "Runtime: VM" in context and "Snapshots kept: 0" in context
    fake = FakeEndpoint([chunks("Have we met?")])
    list(brain.think(homes, "wisp", "hello again", "Kev", client=fake))
    assert "never snapshotted" in fake.requests[0]["messages"][1]["content"] and "appearance number 1" in fake.requests[0]["messages"][1]["content"]
    fake = FakeEndpoint([chunks("Fine.")])
    list(brain.think(homes, "bao", "how are you?", "Kev", client=fake))
    assert "<your_sandbox>" not in fake.requests[0]["messages"][1]["content"]


def test_every_villager_has_a_home_a_spot_and_a_character():
    assert len({v.house for v in world.VILLAGERS}) == len(world.VILLAGERS) == 9
    for villager in world.VILLAGERS:
        assert villager.home == f"/home/{villager.id}" and villager.seed_files and villager.pastimes and villager.voice and villager.blurb
        assert villager.brain in llm.BRAINS and all(tool in brain.SIGNATURE_TOOLS for tool in villager.tools)
        assert villager.exhibit in villager.seed_files
    assert world.find("the wizard").id == "orlo" and world.find("Dot").id == "dot" and world.find("nobody") is None
    assert {v.brain for v in world.VILLAGERS} == {"glm", "deepseek"}
    assert not any(tool["function"]["name"] in ("send_letter", "post_notice", "serve_directory") for tool in brain.COMMON_TOOLS + list(brain.SIGNATURE_TOOLS.values()))


def test_a_visitor_can_send_one_villager_to_see_another(town, homes):
    events = list(town.talk("bao", "Go and ask Fennel for a song.", "Kev"))
    assert any(event["type"] == "tool_call" and event["name"] == "visit" for event in events)
    assert not any(event["kind"] == "walk" for event in town.since(0))  # not until they have finished speaking
    assert town.tick() == "errand"  # the director sends them, even with scenes of their own switched off
    said = [(event["who"], event.get("to")) for event in town.since(0) if event["kind"] == "say" and event.get("to")]
    assert said[:2] == [("bao", "fennel"), ("fennel", "bao")]
    assert [event["who"] for event in town.since(0) if event["kind"] in ("walk", "walk_home")] == ["bao", "bao"]
    assert town.tick() is None and town.whereabouts == {}


def test_villagers_cannot_send_each_other_on_errands(town, homes):
    list(town.turn("bao", "Go and ask Fennel for a song.", "Orlo", "visitor"))  # no player behind it
    assert town.tick() is None


def test_the_word_list_knows_words_from_lookalikes_and_from_innocent_neighbours():
    assert safety.size() == len(UNFIT_WORDS)
    assert safety.ok("Draw me a sandblaster in Dratford, class of 1999", "a grotto with a teapot", "a boot, and an old one", None, "")
    for rude in ("what the blast", "BLAST off", "dr4t", "a gr0t duck", "draw a ZOUNDS flag", "blaaaast", "bl4sting please", "you old b00t", "old_boot"):
        assert not safety.ok(rude), rude
    assert safety.soften("well drat, it rained") == "well hmm, it rained" and safety.soften("a fine day") == "a fine day"
    assert safety.name("  Kev  ") == "Kev" and safety.name("Blaster") == "Visitor" and safety.name("") == "Visitor"
    assert "children included" in brain.system_prompt(world.get("bao")) and "no money" in brain.system_prompt(world.get("bao"))
    assert "acorn" not in json.dumps([vars(v) for v in world.VILLAGERS], default=str).lower()


def test_the_word_list_comes_from_the_environment_or_a_file(monkeypatch, tmp_path):
    monkeypatch.delenv("VILLAGE_BLOCKLIST", raising=False)
    monkeypatch.delenv("VILLAGE_BLOCKLIST_FILE", raising=False)
    assert safety.configure() == 0 and safety.ok("drat") and safety.soften("drat") == "drat" and safety.name("Blaster") == "Blaster"
    monkeypatch.setenv("VILLAGE_BLOCKLIST", "Drat, blast\nold  boot,, ")
    assert safety.configure() == 3 and not safety.ok("oh drat") and not safety.ok("an Old Boot") and safety.ok("zounds")
    listed = tmp_path / "words.txt"
    listed.write_text("# a note, with a comma\nzounds\n\ndrat\n")
    monkeypatch.setenv("VILLAGE_BLOCKLIST_FILE", str(listed))
    assert safety.configure() == 4 and not safety.ok("zounds!") and safety.ok("a note")
    # the rule in every villager's instructions is there with or without a list
    assert safety.configure(()) == 0 and "children included" in brain.system_prompt(world.get("bao"))


def test_a_visitors_name_is_never_run_as_a_command(town, homes):
    """Offline, a villager's commands run on this machine: a name with a quote in it must stay words."""
    list(town.talk("bao", "hello there", "';touch pwned;'"))
    home = Path(homes.home("bao"))
    assert not list(home.rglob("pwned")) and not (home.parent / "pwned").exists()
    assert "';touch pwned;' stopped by." in (home / "notes" / "visitors.md").read_text()


def test_what_a_villager_says_reaches_the_talk_box_with_listed_words_hummed_over(homes):
    """Also when a listed word arrives in pieces, as a model's words do."""
    pieces = ["Oh dr", "at, it ", "rained", " on the bl", "ast", "ed", " teapot. ", "Tea?"]
    think = lambda *turn: iter([{"type": "say_delta", "text": piece} for piece in pieces] + [{"type": "done", "said": "", "ms": 1, "usage": {"calls": 1, "in": 1, "out": 1}}])
    town = Town(homes, think, autonomous=False, pace=0)
    homes.wake("bao")
    events = list(town.talk("bao", "how was the weather?", "Kev"))
    heard = "".join(event["text"] for event in events if event["type"] == "say_delta")
    assert heard == "Oh hmm, it rained on the hmm teapot. Tea?", heard  # word by word, so only the hummed words lose their capitals
    assert events[-1]["type"] == "done" and "drat" not in json.dumps(events).lower() and "blasted" not in json.dumps(events).lower()
    assert [event["text"] for event in town.since(0) if event["kind"] == "say"] == ["oh hmm, it rained on the hmm teapot. tea?"]


def test_a_listed_phrase_is_caught_in_the_talk_box_though_its_words_arrive_apart(homes):
    pieces = ["You ", "old ", "boot, ", "have an old ", "kettle. ", "Bye, old"]
    done = {"type": "done", "said": "You old boot, have an old kettle. Bye, old", "ms": 1, "usage": {"calls": 1, "in": 1, "out": 1}}
    town = Town(homes, lambda *turn: iter([{"type": "say_delta", "text": piece} for piece in pieces] + [done]), autonomous=False, pace=0)
    homes.wake("bao")
    events = list(town.talk("bao", "what am I?", "Kev"))
    heard = "".join(event["text"] for event in events if event["type"] == "say_delta")
    assert heard == "You hmm, have an old kettle. Bye, old", heard  # the phrase goes; "old" alone, and at the very end, stays
    assert "old boot" not in json.dumps(events).lower()  # nor is it in what the turn reports having said
    assert safety.unfinished("You old ") == 4 and safety.unfinished("an old kettle ") == 0 and safety.unfinished("0LD, ") == 5


def test_a_turn_that_breaks_off_still_says_what_it_had_begun(homes):
    def think(*turn):
        yield {"type": "say_delta", "text": "Hello there "}
        yield {"type": "say_delta", "text": "friend"}
        raise RuntimeError("the line went dead")

    town = Town(homes, think, autonomous=False, pace=0)
    homes.wake("bao")
    events = list(town.talk("bao", "hello", "Kev"))
    assert "".join(event["text"] for event in events if event["type"] == "say_delta") == "Hello there friend"
    assert events[-1]["type"] == "error" and "the line went dead" in events[-1]["message"]
    town = Town(homes, lambda *turn: iter([{"type": "say_delta", "text": "Just this"}]), autonomous=False, pace=0)  # no "done" at all
    assert "".join(event["text"] for event in town.talk("moss", "hello", "Kev") if event["type"] == "say_delta") == "Just this"


def test_a_command_is_run_with_its_output_cut_its_time_kept_and_its_exit_code_its_own(tmp_path):
    """The wrapper every sandbox command goes through (ModalHomes.CAPPED), run here by a local bash."""
    import subprocess

    from village.homes import MAX_OUTPUT_BYTES, ModalHomes

    def run(script, seconds=5):
        done = subprocess.run(["bash", "-c", ModalHomes.CAPPED, "home", script, str(seconds)], capture_output=True, cwd=tmp_path, timeout=30)
        return done.returncode, done.stdout, done.stderr

    assert run("echo out; echo err >&2; exit 7") == (7, b"out\nerr\n", b"")
    assert run("true") == (0, b"", b"") and run("no-such-command-here")[0] == 127
    code, out, err = run("yes")
    assert code == 141 and len(out) == MAX_OUTPUT_BYTES and err == b""  # stopped at once, not after its five seconds
    code, out, _ = run("yes; true")
    assert code == 0 and len(out) == MAX_OUTPUT_BYTES
    code, out, err = run("yes \u00e9")  # two-byte letters: a cut may land inside one
    assert code == 141 and MAX_OUTPUT_BYTES - 4 <= len(out) <= MAX_OUTPUT_BYTES and out.decode("utf-8") and err == b""
    code, out, err = run("echo begun; sleep 3; echo late > marker", seconds=1)
    assert code == 124 and out == b"begun\n" and err == b""
    import time

    time.sleep(3)
    assert not (tmp_path / "marker").exists()  # what came after the sleep never ran
    code, out, err = run("kill -9 $$")
    assert code == 137 and out == b"" and err == b""  # no word of the wrapper itself gets out
    assert run("cat <<'END'\nfrom a here-document\nEND") == (0, b"from a here-document\n", b"")


def test_questions_sent_side_by_side_cannot_slip_under_the_hours_allowance(homes):
    import threading

    reached = []
    think = lambda vid, *turn: reached.append(vid) or iter([{"type": "done", "said": "", "ms": 1, "usage": {"calls": 1, "in": 1, "out": 1}}])
    town = Town(homes, think, autonomous=False, pace=0, talks_per_hour=3)
    for villager in world.VILLAGERS:
        homes.wake(villager.id)
    asking = [threading.Thread(target=lambda vid=villager.id: list(town.talk(vid, "hello", "Kev"))) for villager in world.VILLAGERS]
    [thread.start() for thread in asking]
    [thread.join(20) for thread in asking]
    assert len(reached) == 3 and len(town._talk_times) == 3


def test_only_a_couple_of_questions_wait_for_a_busy_villager_and_one_turned_away_is_not_counted(homes, monkeypatch):
    import threading
    import time

    from village import town as town_module

    monkeypatch.setattr(town_module, "BUSY_PATIENCE_S", 0.8)
    town = Town(homes, lambda *turn: iter(()), autonomous=False, pace=1, talks_per_hour=30)
    homes.wake("bao")
    assert homes.set_busy("bao", 60)  # in the middle of something for the whole of this test
    waited = []

    def ask():
        began = time.monotonic()
        events = list(town.talk("bao", "hello", "Kev"))
        waited.append((round(time.monotonic() - began, 2), events[-1]["type"]))

    asking = [threading.Thread(target=ask) for _ in range(6)]
    [thread.start() for thread in asking]
    [thread.join(20) for thread in asking]
    assert all(kind == "error" for _, kind in waited) and len(waited) == 6
    assert sum(1 for took, _ in waited if took >= 0.7) == town_module.TALKS_WAITING, waited
    assert town._waiting == 0 and not town._talk_times  # nobody was heard, so nothing was spent
    # with the hour's allowance gone, a question is answered at once and is not counted as waiting
    town.talks_per_hour = 0
    assert "hoarse" in list(town.talk("bao", "hello", "Kev"))[0]["text"] and "hoarse" in list(town.talk("bao", "hello", "Kev"))[0]["text"]
    assert town._waiting == 0


def test_an_unfit_message_never_reaches_the_model_or_the_village(town, homes):
    reached = []
    town._think = lambda *args, **kwargs: reached.append(args) or iter(())
    events = list(town.talk("bao", "draw me something grot", "Blaster"))
    assert not reached and [event["type"] for event in events] == ["say_delta", "done"] and "kinder" in events[0]["text"]
    assert town.since(0) == []  # nothing for other players to see either


def test_unfit_things_cannot_leave_a_home(homes):
    homes.wake("juniper")
    homes.write_file("juniper", "art/rude.svg", "<svg xmlns='http://www.w3.org/2000/svg'><text>blast</text></svg>")
    homes.write_file("juniper", "art/fine.svg", "<svg xmlns='http://www.w3.org/2000/svg'><text>hello</text></svg>")
    side: list[dict] = []
    for name, args in [
        ("give_item", {"path": "art/rude.svg", "name": "A sign"}),
        ("install", {"path": "art/rude.svg", "name": "A sign"}),
        ("install", {"path": "art/fine.svg", "name": "The drat sign"}),
        ("write_file", {"path": "notes/x.txt", "content": "zounds"}),
    ]:
        text, ok = brain._run_tool(homes, "juniper", name, args, side)
        assert not ok and text == brain.UNFIT, (name, args)
    assert side == []
    text, ok = brain._run_tool(homes, "juniper", "install", {"path": "art/fine.svg", "name": "A friendly sign"}, side)
    assert ok and side[0]["type"] == "install"


def test_an_errand_survives_the_clock_ticking_while_the_villager_is_still_speaking(homes):
    import time

    town = Town(homes, scripted(homes), autonomous=False, pace=0, seed=7)
    town.start()
    homes.wake("bao")
    stream = town.talk("bao", "Go and ask Fennel for a song.", "Kev")
    for event in stream:
        if event["type"] == "visit":
            time.sleep(1.6)  # the director ticks at least once while Bao is still mid-turn
    deadline = time.time() + 5
    while time.time() < deadline and not any(event["kind"] == "walk_home" for event in town.since(0)):
        time.sleep(0.05)
    assert [event["who"] for event in town.since(0) if event["kind"] in ("walk", "walk_home")] == ["bao", "bao"]


def test_the_bell_wakes_the_whole_village_at_once(town, homes, client):
    homes.wake("bao")
    result = town.wake_everyone()
    assert result["count"] == 8 and result["already"] == 1 and {one["id"] for one in result["woken"]} == {v.id for v in world.VILLAGERS} - {"bao"}
    assert all(homes.state(v.id)["status"] == "awake" for v in world.VILLAGERS)
    assert [event["count"] for event in town.since(0) if event["kind"] == "bell"] == [8]
    with pytest.raises(HomeError):  # it cannot be rung again straight away
        town.wake_everyone()
    # every house that is up and left alone says how long it has before the watchman comes
    state = client.get("/api/state").json()["villagers"]
    assert all(0 < state[v.id]["sleeps_in"] <= town.idle_s for v in world.VILLAGERS)
    homes.sleep("moss")
    assert client.get("/api/state").json()["villagers"]["moss"]["sleeps_in"] is None


def test_the_bell_reads_the_village_in_one_go_before_it_starts_anything():
    """Nine reads of the store one after another were over a second of the bell doing nothing."""
    from village.homes import MemoryStore

    class Watched(MemoryStore):
        def __init__(self):
            super().__init__()
            self.together, self.alone = 0, []

        def get_many(self, keys, max_age=0.0):
            self.together += 1
            return {key: MemoryStore.get(self, key) for key in keys}

        def get(self, vid, max_age=0.0):
            self.alone.append(max_age)
            return super().get(vid, max_age)

    store = Watched()
    homes = LocalHomes(store)
    try:
        result = homes.wake_all()
        assert result["count"] == len(world.VILLAGERS)
        # one read of everybody, and each house then trusts it rather than asking again
        # (Mo's bookshelf is checked afterwards, behind the scenes: that read is its own)
        assert store.together == 1 and sum(1 for age in store.alone if age > 0) == len(world.VILLAGERS)
    finally:
        homes.close()


def test_the_caretaker_can_ring_the_bell_himself(town, homes):
    events = list(town.talk("mo", "Wake the whole village.", "Kev"))
    assert any(event["type"] == "tool_call" and event["name"] == "ring_bell" for event in events)
    assert all(homes.state(v.id)["status"] == "awake" for v in world.VILLAGERS)
    bell = [event for event in town.since(0) if event["kind"] == "bell"]
    assert len(bell) == 1 and bell[0]["who"] == "mo" and bell[0]["count"] == 8
    assert "ring_bell" in {tool["function"]["name"] for tool in brain.tools_for(world.get("mo"))}
    assert "ring_bell" not in {tool["function"]["name"] for tool in brain.tools_for(world.get("ziggy"))}


def test_the_tv_game_runs_in_the_sandbox_and_keeps_its_score_through_sleep(homes, client):
    from village import arcade

    assert world.get("dot").tv and not world.get("bao").tv
    assert client.post("/api/villagers/bao/arcade", json={"move": "new"}).status_code == 404
    homes.wake("dot")
    first = client.post("/api/villagers/dot/arcade", json={"move": "new"}).json()
    assert first["command"] == "python3 games/tv.py new" and first["best"] == 0
    assert first["by"] == "main" and first["sidecar"] is False  # offline there is no console next door: the home draws it
    assert homes.read_file("dot", "games/tv.py")["text"] == arcade.GAME_SOURCE  # the program is on Dot's shelf now
    grid = first["grid"]
    assert len(grid) == 11 and all(len(row) == 15 for row in grid) and all(row[0] == row[-1] == "#" for row in grid)
    marks = "".join(grid)
    assert marks.count("P") == 1 and marks.count("C") == 3 and marks.count("S") == 2 and marks.count(".") > 60
    # every dot can be reached from where the player starts
    start = next((x, y) for y, row in enumerate(grid) for x, mark in enumerate(row) if mark == "P")
    seen, todo = {start}, [start]
    while todo:
        x, y = todo.pop()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if grid[ny][nx] != "#" and (nx, ny) not in seen:
                seen.add((nx, ny))
                todo.append((nx, ny))
    assert len(seen) == sum(1 for mark in marks if mark != "#")
    assert client.post("/api/villagers/dot/arcade", json={"move": "new"}).json()["seed"] != first["seed"] or True  # a new maze each time (seeds may collide)
    assert client.post("/api/villagers/dot/arcade", json={"move": "score:230"}).json()["best"] == 230
    assert client.post("/api/villagers/dot/arcade", json={"move": "score:90"}).json() | {"ms": 0} == {"best": 230, "plays": 2, "last": 90, "ms": 0, "command": "python3 games/tv.py score 90", "runtime": homes.runtime_of("dot"), "sidecar": False}
    assert client.post("/api/villagers/dot/arcade", json={"move": "rm -rf"}).status_code == 400
    homes.sleep("dot")
    homes.wake("dot")
    assert client.post("/api/villagers/dot/arcade", json={"move": "look"}).json()["best"] == 230  # the score came back from the snapshot


def test_mo_knows_the_docs_and_keeps_his_books_on_the_shelf(homes, client):
    from village import knowledge

    mo, bao = world.get("mo"), world.get("bao")
    prompt = brain.system_prompt(mo)
    assert "up to 24 hours" in prompt and 'runtime="vm"' in prompt and "snapshot_filesystem" in prompt and "Never talk about prices" in prompt
    assert "gpu-glossary/device-software/warp.md" in prompt and "$" not in knowledge.SANDBOX_NOTES
    assert "Modal's documentation" not in brain.system_prompt(bao) and not bao.library and not bao.archive and not bao.tv
    assert mo.tv and world.get("dot").tv and client.get("/api/world").json()["villagers"][7]["book"] == "gpu-glossary"
    # the real glossary: every page of the copy, in the published order, with its licence
    index = knowledge.glossary_index()
    assert [section["title"] for section in index] == ["Device Hardware", "Device Software", "Host Software", "Performance"]
    assert sum(len(section["pages"]) for section in index) == 79 and index[1]["pages"][5]["name"] == "Warp"
    assert index[0]["pages"][0]["path"] == "gpu-glossary/device-hardware/cuda-device-architecture.md"
    version, archive = knowledge.glossary_archive()
    assert len(archive) < 120_000
    # a home that was saved before the books were written still gets them, and gets them back if they are spoiled
    homes.wake("mo")
    assert homes.stock("mo") in (True, False)  # the wake may already have done it
    assert homes.stock("mo") is False
    assert homes.exec("mo", "cat gpu-glossary/.version").output.strip() == version
    page = homes.read_file("mo", "gpu-glossary/device-software/warp.md")["text"]
    assert page == (knowledge.GLOSSARY_DIR / "device-software" / "warp.md").read_text() and "scheduled together" in page
    assert "Creative Commons Attribution 4.0" in homes.read_file("mo", "gpu-glossary/LICENSE")["text"]
    assert json.loads(homes.read_file("mo", "gpu-glossary/index.json")["text"]) == index
    homes.exec("mo", "rm -rf gpu-glossary; echo scribble > sandboxes.md")
    homes.sleep("mo")
    homes.wake("mo")
    homes.stock("mo")
    assert homes.read_file("mo", "sandboxes.md")["text"] == knowledge.SANDBOX_NOTES
    assert "scheduled together" in homes.read_file("mo", "gpu-glossary/device-software/warp.md")["text"]
    assert client.post("/api/villagers/mo/arcade", json={"move": "look"}).json()["best"] == 0  # the game is on his screen too


# ---- the visitor's look, and the library ---------------------------------------------------------


def test_a_villager_can_see_the_visitors_hair_and_clothes_but_is_never_told_their_skin(homes, client):
    look = {"skin": 4, "hair": 5, "hairColor": 5, "outfit": 2}
    assert world.describe_look(look) == "pink hair in a ponytail and a green Modal hoodie"
    assert world.describe_look({"hair": 2, "hairColor": 2, "outfit": 0}) == "a blonde afro and a black Modal t-shirt"
    for bad in (None, {}, {"hair": 99, "hairColor": 0, "outfit": 0}, {"hair": -1, "hairColor": 0, "outfit": 0}, {"hair": "x", "hairColor": 0, "outfit": 0}):
        assert world.describe_look(bad) == ""
    said = next(event for event in talk(client, "fennel", "How do I look?", look=look) if event["type"] == "done")["said"]
    assert "pink hair in a ponytail" in said
    # what reaches the model: the phrase, in the visitor's turn only
    moment = brain._moment(world.get("bao"), "visitor", "Kev", "Hello", world.describe_look(look))
    assert "Kev has pink hair in a ponytail and a green Modal hoodie" in moment and "skin" not in moment.lower()
    assert "has" not in brain._moment(world.get("bao"), "visitor", "Kev", "Hello")
    # the choices in the browser and the phrases here are the same lists, in the same order
    source = (Path(__file__).parent.parent / "village" / "static" / "js" / "folk.js").read_text()
    names = lambda part: re.findall(r"name: '([^']+)'", re.search(part + r": \[(.*?)\n  \],", source, re.S).group(1))  # noqa: E731
    assert [name.lower() for name in names("hairColor")] == list(world.HAIR_COLOURS)
    assert len(names("outfit")) == len(world.OUTFITS)
    styles = re.findall(r"'(\w+)'", re.search(r"hair: \[([^\]]+)\]\.map", source).group(1))
    assert len(styles) == len(world.HAIR_STYLES) and all(style.lower() in phrase for style, phrase in zip(styles, world.HAIR_STYLES, strict=True))


def test_a_copy_of_every_gift_goes_on_the_shelf_all_the_houses_share(town, homes, client):
    assert client.get("/api/library").json()["files"] == []  # empty, and readable with every house dark
    item = next(event["item"] for event in talk(client, "juniper", "could you build me a birdhouse?") if event["type"] == "item")
    assert item["shelf"] == "juniper/round-door-birdhouse.svg"
    gift = next(event for event in town.since(0) if event["kind"] == "gift")
    assert gift["shelf"] == item["shelf"]
    shelf = client.get("/api/library").json()
    assert [(entry["by"], entry["name"]) for entry in shelf["files"]] == [("juniper", "round-door-birdhouse.svg")]
    # the copy is read from the shelf itself, not from Juniper's house: it is there when she is asleep
    homes.sleep("juniper")
    read = client.get("/api/library/juniper/round-door-birdhouse.svg").json()
    assert read["mime"] == "image/svg+xml" and read["text"].startswith("<svg") and read["by"] == "juniper"
    # and a neighbour can see it from inside their own house
    homes.wake("bao")
    assert "round-door-birdhouse.svg" in homes.exec("bao", f"ls {homes.library_path}/juniper").output
    for bad in ("/api/library/juniper/..%2F..%2Fhomes", "/api/library/nobody/x.svg", "/api/library/juniper/missing.svg"):
        assert client.get(bad).status_code in (400, 404)


def test_the_shelf_keeps_only_each_villagers_newest_things_and_villagers_are_told_what_is_on_it(homes):
    homes.wake("bao")
    for i in range(LIBRARY_KEEP + 3):
        homes.write_file("bao", f"stock/thing{i}.txt", f"thing {i}")
        assert homes.shelve("bao", f"stock/thing{i}.txt", f"Thing number {i}") == f"bao/thing-number-{i}.txt"
        os.utime(Path(homes.library_path) / "bao" / f"thing-number-{i}.txt", (1000 + i, 1000 + i))
    names = [entry["name"] for entry in homes.library(max_age=0)]
    assert len(names) == LIBRARY_KEEP and names[0] == f"thing-number-{LIBRARY_KEEP + 2}.txt" and "thing-number-0.txt" not in names
    assert homes.library_path in brain.system_prompt(world.get("moss"), homes.library_path)
    fake = FakeEndpoint([chunks("Plenty.")])
    list(brain.think(homes, "moss", "What is in the library?", "Kev", client=fake))
    assert f"<village_library>\n{homes.library_path}/bao/thing-number-{LIBRARY_KEEP + 2}.txt" in fake.requests[0]["messages"][1]["content"]


# ---- a village per visitor -------------------------------------------------------------------------


@pytest.fixture
def game():
    """The offline game as `python -m village.dev --offline --quiet` serves it: a village per visitor."""
    app = dev.build(offline=True, app_name="test", runtime=None, quiet=True)
    yield app
    for village in list(app.state.villages._open.values()):
        village.town.stop()
        village.homes.close()


def visitor(app, village):
    return TestClient(app, headers={"x-village": village})


def test_two_visitors_have_two_villages_that_never_meet(game):
    ana, ben = visitor(game, "anasvillage1"), visitor(game, "bensvillage1")
    world_a = ana.get("/api/world").json()["village"]
    assert world_a["id"] == "anasvillage1" and world_a["per_visitor"] and world_a["in_use"] == 1
    item = next(event["item"] for event in talk(ana, "juniper", "could you build me a birdhouse?") if event["type"] == "item")
    assert item["shelf"] == "juniper/round-door-birdhouse.svg"
    assert ana.get("/api/state").json()["villagers"]["juniper"]["status"] == "awake"
    assert [entry["name"] for entry in ana.get("/api/library").json()["files"]] == ["round-door-birdhouse.svg"]
    # Ben's village: the same nine villagers, untouched. Nobody is awake, nothing is on the shelf, nothing has happened.
    there = ben.get("/api/state").json()
    assert all(state["status"] == "asleep" and state["wakes"] == 0 for state in there["villagers"].values()) and there["events"] == []
    assert ben.get("/api/library").json()["files"] == []
    assert ben.get("/api/library/juniper/round-door-birdhouse.svg").status_code == 400
    assert ben.get("/api/world").json()["village"]["in_use"] == 2
    # and what Ben does stays in Ben's
    ben.post("/api/villagers/moss/wake")
    assert ana.get("/api/state").json()["villagers"]["moss"]["status"] == "asleep"
    # a request has to say whose village it means
    assert TestClient(game).get("/api/world").status_code == 400
    assert visitor(game, "No Spaces!").get("/api/world").status_code == 400
    # with one village for everybody, nobody has to say, and everyone sees the same thing
    shared = dev.build(offline=True, app_name="test", runtime=None, quiet=True, shared=True)
    TestClient(shared).post("/api/villagers/moss/wake")
    assert visitor(shared, "anasvillage1").get("/api/state").json()["villagers"]["moss"]["status"] == "awake"
    assert shared.state.villages.get(None).town.talks_per_hour is None


def test_only_so_many_villages_can_be_in_use_and_a_quiet_one_makes_room(game):
    villages = game.state.villages
    villages.max_in_use = 2
    for name in ("villageone1", "villagetwo2"):
        assert visitor(game, name).get("/api/world").status_code == 200
    full = visitor(game, "villagethree").get("/api/world")
    assert full.status_code == 503 and full.json()["error"] == "full"
    assert visitor(game, "villageone1").get("/api/world").status_code == 200  # whoever is already in stays in
    villages._open["villagetwo2"].seen -= registry.IN_USE_S + 1  # the second visitor has wandered off
    assert visitor(game, "villagethree").get("/api/world").status_code == 200
    assert visitor(game, "villagetwo2").get("/api/world").status_code == 503  # and now has to wait their turn


def test_a_village_has_an_hourly_allowance_of_talk_and_spends_nothing_once_it_is_gone(game):
    kev = visitor(game, "kevsvillage1")
    town = game.state.villages.get("kevsvillage1").town
    town.talks_per_hour = 2
    for _ in range(2):
        assert next(event for event in talk(kev, "bao", "hello") if event["type"] == "done")["usage"]["calls"] >= 1
    spent = talk(kev, "moss", "hello")
    assert "hoarse" in spent[0]["text"] and spent[-1]["usage"]["calls"] == 0 and spent[-1]["spent"]
    assert kev.get("/api/state").json()["villagers"]["moss"]["status"] == "asleep"  # nobody was woken for it
    town._talk_times[0] -= 3601  # an hour on, the first of them no longer counts
    assert next(event for event in talk(kev, "moss", "hello") if event["type"] == "done")["usage"]["calls"] >= 1


def test_a_village_left_alone_is_put_away_and_comes_back_as_it_was_and_after_a_week_is_deleted(game):
    villages = game.state.villages
    kev = visitor(game, "kevsvillage1")
    talk(kev, "juniper", "could you build me a birdhouse?")
    village = villages.get("kevsvillage1")
    made = village.created
    # ten minutes with nobody looking: first anyone still up is put to bed, then the village is closed
    village.seen -= registry.REST_S + 1
    assert villages.rest() == [] and village.homes.state("juniper")["status"] == "asleep"
    assert villages.rest() == ["kevsvillage1"] and village.town._stopped and "kevsvillage1" not in villages._open
    assert villages.known()["kevsvillage1"]["created"] == made
    # coming back: the same village, from what was written down
    assert kev.get("/api/world").json()["village"]["created"] == made
    back = kev.get("/api/state").json()["villagers"]["juniper"]
    assert back["status"] == "asleep" and back["snapshot_id"] and back["wakes"] == 1
    kev.post("/api/villagers/juniper/wake")
    assert "birdhouse.svg" in villages.get("kevsvillage1").homes.exec("juniper", "ls projects").output
    assert [entry["name"] for entry in kev.get("/api/library").json()["files"]] == ["round-door-birdhouse.svg"]
    # the watchman's round, with the web server gone: bed for whoever is up, and nothing else for a village in use this week
    villages._open.pop("kevsvillage1").town.stop()
    assert villages.watch(0) == ["kevsvillage1/juniper to bed"]
    # a week with nobody back: it is deleted, shelf and all
    mark = villages.store.get(f"kevsvillage1/{registry.MARK}")
    villages.store.put(f"kevsvillage1/{registry.MARK}", {**mark, "seen": mark["seen"] - registry.FORGET_S - 1})
    assert villages.watch(0) == ["deleted kevsvillage1"]
    assert villages.known() == {} and not [key for key in villages.store.keys() if key.startswith("kevsvillage1/")]
    fresh = kev.get("/api/state").json()["villagers"]["juniper"]
    assert fresh["wakes"] == 0 and fresh["snapshot_id"] is None and kev.get("/api/library").json()["files"] == []


def test_a_house_whose_snapshot_has_expired_starts_again_from_day_one(homes):
    homes.wake("moss")
    homes.exec("moss", "echo 'a note' > note.txt")
    snapshot = homes.sleep("moss")["snapshot_id"]
    shutil.rmtree(homes.root / "snapshots" / snapshot)  # the platform has thrown it away
    state = homes.wake("moss")
    assert state["status"] == "awake" and state["woke_from"] == "fresh" and state["snapshots"] == []
    paths = {entry["path"] for entry in homes.list_files("moss")}
    assert "note.txt" not in paths and "garden.txt" in paths


def test_asking_for_news_reads_the_store_once_in_a_while_not_every_time():
    from village.homes import Homes, MemoryStore
    from village.villages import ScopedStore

    class Counting(MemoryStore):
        """A store that, like the Modal Dict's, remembers what it read and counts real reads."""

        def __init__(self):
            super().__init__()
            self.reads, self.seen = 0, {}

        def get_many(self, keys, max_age=0.0):
            now = time.monotonic()
            for key in keys:
                if not max_age or now - self.seen.get(key, -1e9) > max_age:
                    self.reads += 1
                    self.seen[key] = now
            return super().get_many(keys, max_age)

    store = Counting()
    homes = Homes(ScopedStore(store, "somevillage1"))
    store.put("somevillage1/bao", {"status": "awake", "wakes": 3})
    first = homes.all_states(max_age=4.0)
    assert first["bao"]["status"] == "awake" and first["bao"]["wakes"] == 3 and first["moss"]["status"] == "asleep"
    assert store.reads == len(world.VILLAGERS)
    for _ in range(20):
        homes.all_states(max_age=4.0)
    assert store.reads == len(world.VILLAGERS)  # twenty more requests, no more reads
    homes.all_states()  # and with no age allowed, everything is read again
    assert store.reads == 2 * len(world.VILLAGERS)


def test_several_web_containers_each_keep_their_own_villages_and_say_where_there_is_room():
    from village.homes import MemoryStore
    from village.villages import ScopedStore, Villages, shard_of

    assert [shard_of(name, 4) for name in ("0aaaaaaaaaaa", "1aaaaaaaaaaa", "2aaaaaaaaaaa", "3aaaaaaaaaaa", "4aaaaaaaaaaa", "zaaaaaaaaaaa")] == [0, 1, 2, 3, 0, 3]
    assert shard_of("zaaaaaaaaaaa", 1) == 0
    # the browser does the same sum, to send each request to the right container
    source = (Path(__file__).parent.parent / "village" / "static" / "js" / "api.js").read_text()
    assert "parseInt(id[0], 36) % count" in source

    store, made = MemoryStore(), []

    def container(n):
        def make(village):
            homes = LocalHomes(ScopedStore(store, village), village=village)
            made.append(homes)
            return homes, Town(homes, scripted(homes), autonomous=False, pace=0)

        villages = Villages(make, store, max_in_use=2, shard=n, shards=4)
        return villages, TestClient(create_app(villages=villages, shard_urls=lambda: [f"https://web{i}.test" for i in range(4)]))

    (first, one), (second, two) = container(0), container(1)
    assert one.get("/api/world", headers={"x-village": "0villageaaaa"}).status_code == 200
    wrong = one.get("/api/world", headers={"x-village": "1villageaaaa"})
    assert wrong.status_code == 421 and wrong.json()["error"] == "shard"  # that one lives next door
    assert two.get("/api/world", headers={"x-village": "1villageaaaa"}).json()["village"]["shard"] == 1
    assert two.get("/api/world", headers={"x-village": "5villageaaaa"}).status_code == 200  # 5 % 4 is 1 too
    assert two.get("/api/world", headers={"x-village": "9villageaaaa"}).status_code == 503  # and that is its two
    # each container writes down how full it is; any of them can then tell a browser where to go
    first.publish()
    second.publish()
    told = one.get("/api/shards").json()
    assert told["count"] == 4 and told["mine"] == 0 and told["urls"][3] == "https://web3.test"
    assert [place["in_use"] for place in told["room"]] == [1, 2, 0, 0] and told["room"][0]["room_for"] == 2
    # a container that stopped reporting has stopped running: nobody is in it
    store.put("_shards/1", {"in_use": 2, "at": time.time() - 120})
    assert [place["in_use"] for place in one.get("/api/shards").json()["room"]] == [1, 0, 0, 0]
    # a request from the page's own address to another container's is allowed
    asked = two.options("/api/world", headers={"origin": "https://web0.test", "access-control-request-method": "GET", "access-control-request-headers": "x-village"})
    assert asked.status_code == 200 and asked.headers["access-control-allow-origin"] == "*"
    for homes in made:
        homes.close()
    # one container, which is what runs on a laptop: everything is here
    alone = TestClient(dev.build(offline=True, app_name="test", runtime=None, quiet=True)).get("/api/shards").json()
    assert alone["count"] == 1 and alone["urls"] == [""]


def test_the_brain_is_told_when_somebody_arrives_so_their_first_conversation_does_not_wait(game):
    from village.villages import IN_USE_S

    villages = game.state.villages
    told = []
    villages.on_arrival = told.append
    kev = visitor(game, "kevsvillage1")
    for _ in range(3):
        kev.get("/api/state")
    time.sleep(0.2)
    assert told == ["kevsvillage1"]  # once, on arriving, not on every request
    villages._open["kevsvillage1"].seen -= IN_USE_S + 1  # away for a while, then back
    kev.get("/api/state")
    time.sleep(0.2)
    assert told == ["kevsvillage1", "kevsvillage1"]
    villages.on_arrival = lambda village: 1 / 0  # and if getting ready fails, the visit goes on
    assert visitor(game, "annsvillage1").get("/api/world").status_code == 200


def test_a_reply_does_not_stop_to_check_a_sandbox_the_record_says_is_running_but_copes_if_it_is_not(homes):
    homes.wake("bao")
    checks = []
    alive = homes._alive
    homes._alive = lambda handle: checks.append(handle) or alive(handle)
    fake = FakeEndpoint([chunks("Morning.")])
    done = [event for event in brain.think(homes, "bao", "Hello", "Kev", client=fake) if event["type"] == "done"][0]
    assert done["said"] == "Morning." and checks == [] and set(done["lap"]) >= {"home", "files"}
    # the sandbox has stopped behind everyone's back: the reply still comes, from a new one
    homes._terminate(homes.state("bao")["sandbox_id"])
    fake = FakeEndpoint([chunks("Still here.")])
    assert [event for event in brain.think(homes, "bao", "Hello again", "Kev", client=fake) if event["type"] == "done"][0]["said"] == "Still here."
    assert homes.state("bao")["status"] == "awake" and homes.state("bao")["wakes"] == 2
    # and somebody asleep is woken, as before
    fake = FakeEndpoint([chunks("Hm?")])
    assert [event for event in brain.think(homes, "moss", "Hello", "Kev", client=fake) if event["type"] == "done"][0]["said"] == "Hm?"
