// Sandbox Village: the game loop, the two scenes (village and house interior), and the glue
// between what the player does and what happens to the villagers' sandboxes.
//
// The scene is painted on a small canvas (about 320x200) that CSS scales up by a whole number
// with hard edges. Positions and distances in this file are in those chunky pixels.

import { api, talkStream } from './api.js';
import { startChase } from './chase.js';
import * as art from './art.js';
import * as folk from './folk.js';
import * as rooms from './rooms.js';
import * as scenery from './scenery.js';
import * as sound from './sound.js';
import * as ui from './ui.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('labels'); // full-resolution layer, only for text
const text = overlay.getContext('2d');

const WAKE_RADIUS = 46; // walking this close to a dark house's door wakes its villager
const NEAR_RADIUS = 120; // villagers this close count as "with the player" and stay up
const POLL_MS = 1500;
const LAST_CALL_S = 15; // a house's bedtime count shows for its last seconds only (always, under the hood)
const DAY_SECONDS = 260; // one full day and night
const FONT = '"Pixelify Sans", "Trebuchet MS", sans-serif';

const saved = {
  get(name, fallback) {
    try {
      return JSON.parse(localStorage.getItem(name)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(name, value) {
    try {
      localStorage.setItem(name, JSON.stringify(value));
    } catch {
      /* private window: the game works, it just forgets */
    }
  },
};

const game = {
  t: 0,
  started: false,
  scale: 4, // screen pixels per game pixel
  scene: 'village', // 'village' | 'house'
  house: null, // { v, files, things, x, y } while inside a house
  player: { x: art.SPAWN.x, y: art.SPAWN.y, dir: 'down', moving: false, name: saved.get('village-name', ''), look: folk.tidyLook(saved.get('village-look', null)) },
  keys: new Set(),
  target: null,
  villagers: [],
  byId: {},
  trees: [],
  ground: null,
  info: {},
  runtime: '',
  brains: [], // one per model on Modal's Model APIs: { key, label, model, endpoint, color, requests, ... }
  weather: { kind: 'clear', by: null },
  pieces: new Map(), // what stands on the pedestals: id -> { id, slot, name, by, text, image }
  props: [], // bushes, rocks and the like
  markImage: null, // Modal's logo mark, for the flag, the balloon and the containers
  bellUntil: 0, // the watchman's bell is ringing until this game time
  bedtimes: 0, // how many villagers the watchman has put to bed since this page opened
  idle: 75, // seconds of quiet before he does
  talking: null,
  replying: false,
  inventory: saved.get('village-inventory', []),
  placed: saved.get('village-placed-v2', []),
  action: null,
  images: new Map(),
  sprites: new Map(),
  labels: [],
  lastEvent: 0,
  whereabouts: {},
  thinking: new Map(), // villager id -> game time the beam should stop by
  receipts: [], // how long each thought took and its tokens, floating up from whoever had it: { v, text, color, at }
  lastInput: Date.now(),
  xray: false,
  fading: false, // a door is being walked through
  view: { key: '', dx: 0, dy: 0 }, // the camera's leftover glide after a jump
  hints: saved.get('village-hints', { walked: 0, talked: false, hood: false }), // the first minute's pointers
  almanac: saved.get('village-almanac', {}), // which of the things to try are done: { wake: true, ... }
  library: { files: [] }, // what is on the shared shelf (a Modal Volume)
};
window.__village = game; // handy in the browser console
// For filming the game with a script: game.film = { focus: { x, y }, solo: true } points the camera at
// a spot instead of at the visitor, and leaves the visitor out of the picture.

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const seconds = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

// ---- setup ----------------------------------------------------------------------------------

async function boot() {
  let world;
  try {
    world = await api.world();
  } catch (error) {
    ui.toast(error.message || 'The village is not answering.', error.code === 'full' ? 'Full up:' : 'Locked out:', 60000);
    return;
  }
  game.info = world.info;
  game.mine = world.village || {}; // whose village this is: { id, per_visitor, in_use, room_for }
  game.idle = world.idle_s ?? game.idle;
  game.markImage = imageFrom('brand/modal-mark.svg');
  stockLibrary();
  game.runtime = world.runtime;
  game.brains = world.brains || [];
  game.lastEvent = world.last_event || 0;
  game.villagers = world.villagers.map((pub) => {
    const door = { x: pub.house[0], y: pub.house[1] };
    const half = art.houseBox({ ...pub, door }).w / 2; // narrow houses keep their sign and mailbox closer
    return {
      ...pub,
      door,
      spot: { x: door.x + 24, y: door.y + 15 }, // where they stand outside their own house
      guest: { x: door.x - 24, y: door.y + 15 }, // where a visitor stands
      sign: { x: door.x - half - 12, y: door.y + 9 },
      mailbox: { x: door.x + Math.max(half + 8, 46), y: door.y + 4 }, // clear of where they stand, so its card is easy to reach
      plot: pub.tools.includes('plant') ? art.plotOf({ door }) : null, // the gardener's bed
      state: { status: 'asleep', snapshots: [], sandbox_id: null, snapshot_id: null, files: null, wake_ms: null, wakes: 0, mail: 0, exhibit: '' },
      show: 'asleep',
      out: 0, // 0 = indoors, 1 = standing outside
      pos: { ...door },
      place: 'home', // 'home', or the id of the villager they are visiting
      path: null, // points still to walk through
      pace: 60,
      facing: 'down',
      walking: false,
      pending: null,
      working: 0,
      speaking: 0,
      bubble: null, // { text, until }
      fx: null, // { kind: 'wake' | 'snap', at }
      greeted: false,
    };
  });
  game.byId = Object.fromEntries(game.villagers.map((v) => [v.id, v]));
  game.ground = art.makeGround(game.villagers);
  game.trees = art.makeTrees(game.villagers);
  game.props = scenery.makeProps(game.villagers, game.trees);
  renderInventory();
  document.fonts?.load(`16px ${FONT}`).catch(() => {});
  await refreshState(true);
  // ?poll=300 asks the server for news that often, in milliseconds (for filming: a thought's
  // beam then starts and stops within a third of a second of the request it stands for)
  const asked = Number(new URLSearchParams(location.search).get('poll'));
  setInterval(() => refreshState(false), asked >= 200 && asked <= 10000 ? asked : POLL_MS);
  requestAnimationFrame(frame);
}

async function refreshState(first) {
  try {
    const near = game.villagers.filter((v) => (game.scene === 'house' ? game.house.v === v : dist(game.player, v.door) < NEAR_RADIUS)).map((v) => v.id);
    const active = game.started && Date.now() - game.lastInput < 180000;
    const asked = performance.now();
    const data = await api.state(game.lastEvent, near, active);
    game.whereabouts = data.whereabouts || {};
    for (const fresh of data.brains || []) {
      const brain = game.brains.find((other) => other.key === fresh.key);
      if (brain) Object.assign(brain, fresh);
    }
    if (data.weather) game.weather = data.weather;
    syncPieces(data.installations || []);
    for (const v of game.villagers) {
      // (news asked for before this browser's own last change to them landed is already out of date)
      if (!v.pending && !(v.settled > asked) && data.villagers[v.id]) applyState(v, data.villagers[v.id], first);
    }
    for (const event of data.events) {
      if (event.id <= game.lastEvent) continue; // two polls can overlap; hear each thing once
      game.lastEvent = event.id;
      handleEvent(event);
    }
    if (first) {
      for (const v of game.villagers) {
        const where = game.whereabouts[v.id];
        if (where && game.byId[where]) {
          v.place = where;
          v.pos = { ...game.byId[where].guest };
          v.out = 1;
        }
      }
    }
  } catch {
    /* a missed poll is fine */
  }
  renderHood();
  ui.renderStatus(game);
}

// The answer to something this browser did itself (a wake, a bedtime, a dare, a rebuild). News
// can arrive out of order: a poll asked for a moment earlier would otherwise undo it on screen,
// and a house just rebuilt would fall down a second time.
function settle(v, state) {
  applyState(v, state);
  v.settled = performance.now();
}

function applyState(v, state, quiet = false) {
  const before = v.state.status;
  v.state = state;
  v.bedAt = state.sleeps_in == null ? null : game.t + state.sleeps_in;
  if (quiet) return;
  if (before !== 'awake' && state.status === 'awake') {
    v.fx = { kind: 'wake', at: game.t };
    if (before === 'rubble') v.roseAt = game.t; // the house goes back up behind the scan
    if (state.wake_ms && !(game.almanac.quickest <= state.wake_ms)) {
      game.almanac.quickest = state.wake_ms;
      saved.set('village-almanac', game.almanac);
    }
    const how = v.ephemeral ? 'brand new, day one again' : state.woke_from === 'snapshot' ? 'restored from snapshot' : 'first boot';
    ui.feed(`${v.name} ${v.ephemeral ? 'appeared' : 'woke up'}: sandbox ${how} in ${seconds(state.wake_ms ?? 0)}`, 'sandbox');
    if (onScreen(v.door)) {
      sound.jingle('wake');
      const started = v.ephemeral ? 'started from nothing' : state.woke_from === 'snapshot' ? 'started from its snapshot' : 'started for the first time';
      if (dist(game.player, v.door) < NEAR_RADIUS) notice(`${started} in ${seconds(state.wake_ms ?? 0)}`, `${v.name}'s sandbox`);
    }
  }
  if (before === 'awake' && state.status === 'asleep') {
    v.fx = { kind: 'snap', at: game.t };
    v.sleptAt = game.t; // its crystal in the snapshot cellar sparkles for a moment
    if (v.ephemeral) {
      ui.feed(`${v.name} faded away: sandbox terminated with no snapshot. Next time is day one.`, 'sandbox');
    } else {
      ui.feed(`${v.name} went to sleep: home saved as a snapshot, sandbox gone`, 'sandbox');
    }
    if (onScreen(v.door)) {
      sound.jingle('sleep');
      // (the words for this are in the corner commentary, with the hood open)
    }
  }
  if (before !== 'rubble' && state.status === 'rubble') {
    sound.jingle('crash');
    v.fellAt = game.t; // the house comes down (art.drawHouse), and the ground shakes
    if (onScreen(v.door) && !matchMedia('(prefers-reduced-motion: reduce)').matches) game.quake = game.t + 0.8;
    if (v.dared && v.dare_oops) setTimeout(() => v.show === 'rubble' && (v.bubble = { text: v.dare_oops, until: game.t + 6 }), 2400);
    v.fell = ui.toast(v.dared ? 'Only that one sandbox is gone. Every other house is untouched.' : 'Every other house is untouched.', `${v.name}'s house collapsed.`, 8000);
    ui.feed(`${v.name}'s house is rubble. Every other house is untouched.`, 'sandbox');
    if (game.house?.v === v) leaveHouse();
    if (game.talking === v) stopTalking();
  }
  if (state.status === 'asleep' && game.house?.v === v && !v.pending) leaveHouse();
}

// One line at the top of the screen about a sandbox the player can see. With the hood open the
// corner commentary already says it.
function notice(text, strong) {
  if (!game.xray && game.started && !game.guide && !(game.hush > game.t)) ui.toast(text, strong, 4200, 'sandbox');
}

// Is this spot in the part of the village the player can see right now?
function onScreen(point) {
  if (game.scene !== 'village') return false;
  const cam = camera();
  return point.x > cam.x - 20 && point.x < cam.x + cam.w + 20 && point.y > cam.y - 20 && point.y < cam.y + cam.h + 60;
}

// The pedestals hold whatever the tinkerer installed. The list comes with every poll; the
// picture itself (an SVG a program in her sandbox drew) is fetched once per piece.
function syncPieces(list) {
  const wanted = new Set(list.map((piece) => piece.id));
  for (const id of [...game.pieces.keys()]) if (!wanted.has(id)) game.pieces.delete(id);
  for (const piece of list) {
    if (game.pieces.has(piece.id)) continue;
    const mine = { ...piece, text: null, image: null };
    game.pieces.set(piece.id, mine);
    api
      .installation(piece.id)
      .then((full) => {
        mine.text = full.text;
        mine.file = full.file;
        mine.image = imageFrom(URL.createObjectURL(new Blob([full.text], { type: 'image/svg+xml' })));
      })
      .catch(() => game.pieces.delete(piece.id));
  }
}

function renderHood() {
  if (ui.$('hood').hidden || document.activeElement?.tagName === 'SELECT') return;
  ui.renderHood(game, { bed: sendToBed, restore: restoreHome });
}

// ---- what the village is up to (events every browser hears about) ------------------------------

function handleEvent(event) {
  const v = game.byId[event.who];
  const other = game.byId[event.to];
  if (!v) return;
  switch (event.kind) {
    case 'think':
      if (event.phase === 'start') game.thinking.set(v.id, game.t + 20);
      else {
        game.thinking.set(v.id, game.t + 0.5);
        // the receipt for that one request to the model
        const brain = game.brains.find((other) => other.key === beaconOf(v));
        const tokens = (event.tokens_in || 0) + (event.tokens_out || 0);
        if (tokens && game.xray) game.receipts.push({ v, text: `${((event.ms || 0) / 1000).toFixed(1)} s · ${tokens} tokens`, color: brain?.color || '#7fee64', at: game.t });
      }
      break;
    case 'act':
      v.working = game.t + 2.5;
      // the command, shown over the house whose sandbox is running it
      v.command = { text: event.summary.length > 44 ? `${event.summary.slice(0, 43)}…` : event.summary, shell: event.tool === 'bash', until: game.t + 3.2 };
      if (game.xray) ui.feed(`${v.id}@sandbox $ ${event.summary}`, 'shell');
      break;
    case 'say':
      if (game.talking !== v) {
        v.bubble = { text: event.text, until: game.t + (event.dur || 4) + 1.2 };
        v.speaking = game.t + (event.dur || 4);
      }
      ui.feed(`${v.name}${other ? ` to ${other.name}` : ''}: ${event.text}`, 'say');
      break;
    case 'bell':
      // somebody rang it (Mo, or another visitor): the whole village starts at once
      game.bellUntil = game.t + 3;
      game.hush = game.t + 6;
      if (onScreen(art.PLACES.bell) || v) sound.jingle('bell');
      if (v && !game.xray) ui.toast(`${event.count} sandbox${event.count === 1 ? '' : 'es'} started at the same moment, in ${seconds(event.ms)}.`, `${v.name} rang the bell.`, 7000, 'sandbox');
      ui.feed(`${v ? v.name : 'Someone'} rang the bell: ${event.count} sandboxes started at once in ${seconds(event.ms)}`, 'sandbox');
      break;
    case 'walk':
      v.pace = null;
      v.walkFor = event.dur;
      if (game.xray) ui.feed(`${v.name} is walking over to see ${other?.name || 'a neighbour'}`, 'walk');
      // you sent them: say where they are going, so you can follow and listen
      else if (game.sent?.id === v.id && game.t - game.sent.at < 120) ui.toast(`Follow along to hear what they say.`, `${v.name} is off to see ${other?.name || 'a neighbour'}.`, 6000);
      game.sent = null;
      break;
    case 'walk_home':
      v.walkFor = event.dur;
      break;
    case 'weather':
      game.weather = { kind: event.weather, by: v.id };
      sound.jingle('spell');
      ui.toast(event.weather === 'clear' ? 'The sky is clear again, for everyone.' : `It is ${WEATHER_WORDS[event.weather] || event.weather} over the whole village, for everyone.`, `${v.name} changed the weather.`, 5200);
      ui.feed(`${v.name} cast ${event.weather} over the village (a tool only ${v.name} has)`, 'tool');
      break;
    case 'tune': {
      const length = sound.playTune(event.notes || []);
      v.playing = game.t + length + 0.4;
      ui.feed(`${v.name} is playing "${event.title}" (saved as a file in his sandbox)`, 'tool');
      break;
    }
    case 'install':
      sound.jingle('build');
      ui.feed(`${v.name} put "${event.name}" on a pedestal: a picture her program drew, copied out of her sandbox`, 'tool');
      break;
    case 'garden':
      ui.feed(`${v.name} planted something: one more line in garden.txt in her sandbox`, 'tool');
      break;
    case 'gift':
      if (event.shelf) setTimeout(stockLibrary, 1500); // a copy went on the shared shelf
      break;
    case 'slept':
      game.bellUntil = game.t + 2.4;
      game.bedtimes += 1;
      if (onScreen(art.PLACES.bell)) sound.jingle('bell');
      break;
    case 'heard':
      if (game.talking !== v) ui.feed(`${event.player || 'A visitor'} to ${v.name}: ${event.text}`, 'say');
      break;
    default:
      break;
  }
}

const WEATHER_WORDS = { rain: 'raining', storm: 'storming', snow: 'snowing', fog: 'foggy', blossom: 'raining petals' };

// ---- sandboxes: wake, sleep, the dare, restore ------------------------------------------------

async function wake(v) {
  if (v.pending) return;
  v.pending = 'waking';
  renderHood();
  try {
    const state = await api.wake(v.id);
    v.pending = null;
    settle(v, state);
    if (state.status === 'awake' && game.started && game.guide !== v) tick('wake');
  } catch (error) {
    v.pending = null;
    v.retryAt = game.t + 6; // don't hammer a failing wake
    ui.toast(error.message, `${v.name} would not wake:`);
  }
  renderHood();
}

async function sendToBed(v) {
  if (v.pending || v.state.status !== 'awake') return;
  v.pending = 'sleeping';
  renderHood();
  try {
    const state = await api.sleep(v.id);
    v.pending = null;
    settle(v, state);
  } catch (error) {
    v.pending = null;
    ui.toast(error.message, `${v.name} is staying up:`);
  }
  renderHood();
}

// The dare: a villager deletes their own computer. Their line is written (like a greeting); the
// command is real. The server saves the home first, runs it in that one sandbox, and the house
// is rubble until it is rebuilt from the snapshot.
async function dareHome(v) {
  game.replying = true;
  v.dared = true;
  ui.dialogue.setBusy(true);
  ui.dialogue.addYou(game.player.name, v.dare);
  ui.dialogue.appendSay(v.dare_reply);
  const sent = performance.now();
  const asked = api.dare(v.id).then((state) => ({ state }), (error) => ({ error }));
  await ui.dialogue.settled();
  v.working = game.t + 60;
  v.command = { text: v.dare_command, shell: true, until: game.t + 60 };
  ui.dialogue.setStatus(`${v.name} types: ${v.dare_command}`, true);
  if (game.xray) ui.feed(`${v.id}@sandbox $ ${v.dare_command}`, 'shell');
  const [{ state, error }] = await Promise.all([asked, sleep(1600)]); // long enough to read what was typed
  v.working = 0;
  v.command = null;
  ui.dialogue.setStatus('');
  ui.dialogue.setBusy(false);
  game.replying = false;
  if (error) {
    v.dared = false;
    ui.dialogue.error(error.message);
    return;
  }
  if (!(v.settled > sent)) settle(v, state); // unless they have already been rebuilt since
  renderHood();
}

async function restoreHome(v, which) {
  if (v.pending) return;
  v.pending = 'waking';
  renderHood();
  try {
    const state = await api.rebuild(v.id, which === 'fresh' ? null : which);
    v.pending = null;
    v.fell?.remove();
    game.hush = game.t + 3; // one notice about this, not two
    v.bubble = null;
    settle(v, state);
    ui.toast(which === 'fresh' ? 'A new sandbox, started over from an empty image.' : `A new sandbox, started from the snapshot in ${seconds(state.wake_ms ?? 0)}. Everything is where it was.`, `${v.name}'s house is back.`, 7000, 'sandbox');
    if (game.house?.v === v) await loadHouse();
    if (v.dared && v.dare_after) setTimeout(() => (v.bubble = { text: v.dare_after, until: game.t + 5 }), 1800);
    v.dared = false;
    tick('dare');
  } catch (error) {
    v.pending = null;
    ui.toast(error.message, 'Could not restore:');
  }
  renderHood();
}

// ---- houses -----------------------------------------------------------------------------------

function thingSlots() {
  const slots = [];
  for (let i = 0; i < 9; i++) slots.push({ x: 40 + i * 26, y: 40, reach: { x: 40 + i * 26, y: 62 } }); // the long shelf
  for (let i = 0; i < 4; i++) slots.push({ x: 108 + i * 19, y: 98, reach: { x: 108 + i * 19, y: 116 } }); // the table
  for (let i = 0; i < 4; i++) slots.push({ x: 32, y: 84 + i * 22, reach: { x: 44, y: 84 + i * 22 } }); // along the left wall
  return slots;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Going through a door: the screen goes dark, the scene changes behind it, and it comes back.
async function throughDoor(change) {
  if (game.fading) return;
  game.fading = true;
  game.keys.clear();
  game.target = null;
  game.player.moving = false;
  sound.jingle('door');
  ui.$('fade').classList.add('on');
  await sleep(190);
  // stay dark until the other side is ready to be seen (but never for long)
  await Promise.race([Promise.all([change(), sleep(90)]), sleep(1600)]);
  ui.$('fade').classList.remove('on');
  game.fading = false;
}

// A house's file list, asked for as soon as you reach its door, so the shelves are already
// stocked when the door opens. Kept for a few seconds only: the villager may be changing things.
const shelf = { id: null, at: 0, files: null };
function peekShelf(v) {
  if (shelf.id === v.id && performance.now() - shelf.at < 4000) return shelf.files;
  shelf.id = v.id;
  shelf.at = performance.now();
  shelf.files = api.files(v.id);
  shelf.files.catch(() => {
    if (shelf.id === v.id) shelf.id = null; // asleep or gone: ask again next time
  });
  return shelf.files;
}

function enterHouse(v) {
  const listing = peekShelf(v); // on its way while the screen goes dark
  return throughDoor(() => {
    if (v.show !== 'awake') return null; // they went to bed while the door was opening
    game.house = { v, files: [], things: [], x: art.ROOM.door.x, y: art.ROOM.door.y - 12, loading: true };
    game.scene = 'house';
    game.player.dir = 'up';
    return loadHouse(listing);
  });
}

const stepOutside = () => throughDoor(leaveHouse);

function leaveHouse() {
  if (!game.house) return;
  const v = game.house.v;
  game.scene = 'village';
  game.house = null;
  game.target = null;
  game.player.x = v.door.x;
  game.player.y = v.door.y + 7;
  game.player.dir = 'down';
  if (game.talking) stopTalking();
}

// `listing`: a file list already asked for (see `peekShelf`). Resolves once the shelves and the
// pictures on them are ready to draw.
async function loadHouse(listing = null) {
  const house = game.house;
  if (!house) return;
  try {
    const { files } = await (listing || api.files(house.v.id));
    if (game.house !== house) return;
    house.files = files;
    house.loading = false;
    const top = files.filter((entry) => !entry.path.includes('/'));
    const hidden = (entry) => entry.name.startsWith('.');
    top.sort((a, b) => hidden(a) - hidden(b) || (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
    const slots = thingSlots();
    // a book laid out on the table (Mo's glossary) takes the middle of the table, not a place on the shelf
    const open = house.v.book ? top.find((entry) => entry.name === house.v.book) : null;
    const rest = top.filter((entry) => entry !== open);
    const shelf = slots.filter((slot) => !(open && slot.x === 146 && slot.y === 98));
    house.things = rest.slice(0, shelf.length).map((entry, index) => ({ entry, kind: art.kindOf(entry), seed: index, ...shelf[index] }));
    if (open) house.things.push({ entry: open, kind: 'book', seed: 3, open: true, x: 146, y: 98, reach: { x: 146, y: 116 } });
    else if (house.v.book && !house.waited) {
      house.waited = true; // a big book may still be on its way to the shelf just after a wake
      setTimeout(() => game.house === house && loadHouse(), 1800);
    }
    house.v.state.files = files.length;
    await Promise.all(house.things.filter((thing) => thing.kind === 'picture' && thing.entry.size < 200000).map((thing) => loadPicture(house.v, thing.entry)));
  } catch (error) {
    if (game.house !== house) return;
    if (error.code === 'asleep' || error.code === 'rubble') leaveHouse();
    else ui.toast(error.message, 'The shelves are a blur:');
  }
}

function pictureKey(v, entry) {
  return `${v.id}:${entry.path}:${entry.mtime}:${entry.size}`;
}

async function loadPicture(v, entry) {
  const key = pictureKey(v, entry);
  if (game.images.has(key)) return;
  game.images.set(key, null);
  try {
    const file = await api.file(v.id, entry.path);
    const url = ui.dataUrl(file);
    if (!url) return;
    const image = imageFrom(url);
    game.images.set(key, image);
    await image.decode?.().catch(() => {}); // ready to draw by the time this resolves
  } catch {
    game.images.delete(key);
  }
}

function imageFrom(url) {
  const image = new Image();
  image.src = url;
  return image;
}

// A cached pixel sprite made from a picture (a villager's SVG, usually). Null until it has loaded.
function spriteFor(key, image, maxW, maxH, outline) {
  const id = `${key}@${maxW}x${maxH}`;
  if (!game.sprites.has(id)) {
    const sprite = art.spriteFromImage(image, maxW, maxH, outline);
    if (!sprite) return null;
    game.sprites.set(id, sprite);
  }
  return game.sprites.get(id);
}

function itemSprite(item, maxW = 26, maxH = 30) {
  if (!item.mime?.startsWith('image/') || !item.base64) return null;
  if (!game.images.has(item.id)) game.images.set(item.id, imageFrom(ui.dataUrl(item)));
  return spriteFor(item.id, game.images.get(item.id), maxW, maxH, true);
}

async function openEntry(v, entry) {
  const back = entry.path.includes('/') ? [{ label: '< Back', run: () => openEntry(v, parentEntry(entry)) }] : [];
  if (entry.type !== 'dir') tick('file');
  if (entry.type === 'dir') {
    const inside = (game.house?.files || []).filter((other) => other.path.startsWith(entry.path + '/') && !other.path.slice(entry.path.length + 1).includes('/'));
    const list = ui.el(
      'ul',
      { class: 'file-list' },
      ...inside.map((other) =>
        ui.el('li', {}, ui.el('button', { text: other.name + (other.type === 'dir' ? '/' : ''), onclick: () => openEntry(v, other) }), ui.el('span', { class: 'size', text: other.type === 'dir' ? 'folder' : `${other.size} bytes` })),
      ),
    );
    ui.reader.open({ title: `${entry.path}/`, sub: `a folder in ${v.home}`, body: inside.length ? list : ui.el('p', { class: 'muted', text: 'Empty.' }), actions: back });
    return;
  }
  ui.reader.open({ title: entry.path, sub: 'fetching from the sandbox…', body: ui.el('p', { class: 'muted working', text: 'Reading' }), actions: back });
  const shut = () => !ui.reader.isOpen || ui.$('reader-title').textContent !== entry.path; // closed, or on to something else, while it was on its way
  try {
    const file = await api.file(v.id, entry.path);
    if (shut()) return;
    ui.reader.open({ title: entry.path, sub: `${file.size} bytes · ${v.home}/${entry.path}`, body: ui.fileBody(file), actions: back });
  } catch (error) {
    if (!shut()) ui.reader.open({ title: entry.path, sub: '', body: ui.el('p', { class: 'muted', text: error.message }), actions: back });
  }
}

// Modal's GPU Glossary, as it lies on Mo's table: the real pages, read out of his sandbox one at
// a time, with the links between them working. `path` is a page; without one, the contents.
const glossary = { index: null, pages: new Map(), turn: 0 };
async function openGlossary(v, path = null) {
  const sub = `${path || 'gpu-glossary/'} in ${v.name}'s sandbox`;
  const contents = { label: 'Contents', run: () => openGlossary(v) };
  const turn = ++glossary.turn;
  const closed = () => turn !== glossary.turn || !ui.reader.isOpen; // shut, or turned to another page, while this one was on its way
  ui.reader.open({ title: "Modal's GPU Glossary", sub, body: ui.el('p', { class: 'muted working', text: 'Turning to the page' }), actions: path ? [contents] : [] });
  const read = async (file) => {
    if (!glossary.pages.has(file)) glossary.pages.set(file, (await api.file(v.id, file)).text || '');
    return glossary.pages.get(file);
  };
  try {
    if (!glossary.index) glossary.index = JSON.parse(await read('gpu-glossary/index.json'));
    const flat = glossary.index.flatMap((section) => [{ path: section.path, title: section.title, name: section.title }, ...section.pages]);
    const go = (target) => openGlossary(v, target);
    if (closed()) return;
    if (!path) {
      ui.reader.open({
        title: "Modal's GPU Glossary",
        sub,
        body: [
          ui.el('p', { text: `The whole glossary, as Modal publishes it at modal.com/gpu-glossary: ${flat.length - glossary.index.length} pages, every one a file in ${v.name}'s house. The words in each page that are underlined lead to other pages.` }),
          ui.el('p', {}, ui.el('button', { type: 'button', class: 'md-link', text: 'Why Modal wrote it', onclick: () => go('gpu-glossary/readme.md') })),
          ...glossary.index.flatMap((section) => [
            ui.el('h3', {}, ui.el('button', { type: 'button', class: 'md-link', text: section.title, onclick: () => go(section.path) })),
            ui.el('p', { class: 'muted', text: section.intro }),
            ui.el('div', { class: 'md-terms' }, ...section.pages.map((page) => ui.el('button', { type: 'button', text: page.name, onclick: () => go(page.path) }))),
          ]),
          ui.el('p', { class: 'muted small', text: 'Text by Modal Labs, licensed CC BY 4.0. The diagrams load from Modal\'s site.' }),
        ],
      });
      return;
    }
    const text = await read(path);
    if (closed()) return;
    const at = flat.findIndex((page) => page.path === path);
    const beside = (step, label) => (at >= 0 && flat[at + step] ? [{ label: `${label}: ${flat[at + step].name}`, run: () => go(flat[at + step].path) }] : []);
    const title = (/^---[\s\S]*?^title:\s*"?(.+?)"?\s*$/m.exec(text) || [])[1] || flat[at]?.title || path;
    ui.reader.open({ title, sub, body: ui.markdown(text, go), actions: [contents, ...beside(-1, 'Back'), ...beside(1, 'Next')] });
    ui.$('reader-body').scrollTop = 0;
  } catch (error) {
    if (closed()) return;
    ui.reader.open({ title: "Modal's GPU Glossary", sub: '', body: ui.el('p', { class: 'muted', text: `The book is not on the table yet (${error.message}). Give ${v.name} a moment and try again.` }), actions: path ? [contents] : [] });
  }
}

function parentEntry(entry) {
  const path = entry.path.slice(0, entry.path.lastIndexOf('/'));
  return { path, name: path.split('/').pop(), type: 'dir' };
}

// A landmark drawn large for its sign: `draw(c)` paints it with its foot at (0, 0).
function pictureOf(w, h, ox, oy, draw) {
  const picture = art.makeCanvas(w, h);
  picture.className = 'landmark';
  const c = picture.getContext('2d');
  c.imageSmoothingEnabled = false;
  c.translate(ox, oy);
  draw(c);
  return picture;
}

const ORIGIN = { x: 0, y: 0 };
// Where the pennant's pole stands on each kind of roof, from the door's x and the roof's top.
const ROOFTOP = [[-11, '#b9bcc4', 'Erik', 'erik'], [7, '#2b2f3a', 'Akshat', 'akshat']]; // where on the cellar's roof, what they wear, and whose sprite
const PENNANT_AT = { gpu: [38, 10], garage: [-36, 16], tower: [0, 2], mushroom: [-22, 16], caravan: [-34, 12], ruin: [-18, 8], lab: [-30, 30], shop: [-30, 14] };
const towerPicture = (key) => pictureOf(34, 54, 17, 49, (c) => art.drawBeacon(c, ORIGIN, art.BEACON_TONES[key] || art.BEACON_TONES.glm, game.t, false));
function housePicture(v, lit = true) {
  const box = art.houseBox({ ...v, door: ORIGIN });
  const top = art.houseTop({ ...v, door: ORIGIN });
  return pictureOf(box.w + 28, 8 - top, box.w / 2 + 14, 4 - top, (c) => art.drawHouse(c, { ...v, door: ORIGIN, show: lit ? 'awake' : 'asleep', out: 0 }, game.t));
}

// Each tower on the lane is one model on Modal's Model APIs: the brain of the villagers wired to it.
async function openBeacon(key) {
  const known = game.brains.find((brain) => brain.key === key) || {};
  const title = `The ${known.label || 'shared'} tower`;
  const sub = "on Modal's Model APIs";
  ui.reader.open({ title, sub, body: ui.el('p', { class: 'muted working', text: 'Asking' }) });
  try {
    game.brains = await api.brains();
    const brain = game.brains.find((other) => other.key === key) || known;
    ui.reader.open({ title, sub, body: ui.brainBody(brain, game.brains, game.byId, towerPicture(key), offlineNote()) });
  } catch (error) {
    ui.reader.open({ title, sub: '', body: ui.el('p', { class: 'muted', text: error.message }) });
  }
}

// An easter egg for the team: Charles, fishing off the dock.
const ANGLER = { x: art.PLACES.dock.x + 10, y: art.PLACES.dock.y + 1 };
function openAngler() {
  sound.jingle('hello');
  ui.reader.open({
    title: 'Charles',
    sub: 'gone fishing',
    body: [
      ui.el('p', { text: 'He is fishing for cold starts. "They are hard to catch around here," he says. "Everything starts too fast."' }),
      ui.el('p', { class: 'muted', text: 'The mohawk is real.' }),
    ],
  });
}

// The welcome sign, and the "What is this?" button: the whole demo in three pictures.
function openGuide() {
  const bao = game.byId.bao || game.villagers[0];
  const row = (picture, headline, text) => ui.el('div', { class: 'signpost' }, ui.el('div', { class: 'scene' }, picture), ui.el('div', { class: 'says' }, ui.el('h3', { class: 'headline', text: headline }), ui.el('p', { text })));
  ui.reader.open({
    title: 'What is this?',
    sub: 'a small demo of Modal',
    body: [
      row(housePicture(bao), 'Every house is a Modal Sandbox.', 'A sandbox is a small sealed computer that Modal starts in about a second. Each villager lives in one. Ask for something and they write and run real code in there. Go inside: the things on the shelves are its files.'),
      row(housePicture(bao, false), 'A dark house is switched off.', 'Walk away and the house is saved (a snapshot) and its sandbox shuts down. Walk back and a new sandbox starts from the snapshot, with everything where it was.'),
      row(towerPicture('glm'), 'The two towers are Modal Model APIs.', 'The villagers think with two small AI models that Modal hosts. The dots between a tower and a villager are one thought: a question going out and the answer coming back.'),
      row(pictureOf(52, 54, 26, 50, (c) => scenery.drawGate(c, ORIGIN)), 'Nothing gets in or out.', 'No house can reach the internet, and no door is open to it: every sandbox here was made with an empty network allowlist. A villager can break their own house, and only their own.'),
      ui.el('p', { class: 'muted', text: `${TOUCH ? '"Under the hood"' : 'Tab, or "Under the hood",'} shows the real thing: sandbox IDs, commands and timings.` }),
      offlineNote(),
    ],
    actions: [{ label: 'What can I do here?', run: () => openAlmanac() }],
  });
}
ui.$('guide-toggle').addEventListener('click', openGuide);

// ---- the almanac: a few things to try, ticked off as they are done ----------------------------
// `how` is the pointer shown until a thing is done; `modal` is what it turned out to be on Modal,
// shown once it is. With all of them done the card gains a last word and a way out to the docs.
const ALMANAC = [
  { key: 'wake', title: 'Wake a house', how: 'Walk up to a dark one.', modal: 'a Modal Sandbox started, in about a second.' },
  { key: 'made', title: 'Get something made', how: 'Ask a villager to make you something.', modal: 'a model on Model APIs wrote the code. The sandbox ran it.' },
  { key: 'file', title: 'Read a file', how: 'Go into a house and look on its shelves.', modal: 'every sandbox has a filesystem of its own.' },
  { key: 'bell', title: 'Ring the bell', how: 'It stands on the top road.', modal: 'every sleeping sandbox started at the same moment.' },
  { key: 'library', title: 'Visit the library', how: 'The book house with the green roof, by the lane.', modal: 'a Modal Volume: one shelf mounted in every sandbox.' },
  { key: 'maze', title: 'Play the maze', how: "It is on the screen in Mo's house.", modal: 'a sidecar, a second container, draws each maze.' },
  { key: 'dare', title: 'Break a house and bring it back', how: 'Dare Ziggy, the raccoon in the garage.', modal: 'the sandbox wrecked only itself. A new one started from its snapshot.' },
];
const SANDBOX_DOCS = 'https://modal.com/docs/guide/sandboxes';
const almanacDone = () => ALMANAC.filter((entry) => game.almanac[entry.key]).length;

// The chip in the top bar: how many are done, and for a moment after a tick, which one.
let chipTimer = null;
function showAlmanac(just = null) {
  const done = almanacDone();
  const chip = ui.$('almanac-toggle');
  ui.$('almanac-count').textContent = done === ALMANAC.length ? '✓' : `${done}/${ALMANAC.length}`;
  chip.classList.toggle('complete', done === ALMANAC.length);
  if (!just) return;
  ui.$('almanac-just').textContent = `✓ ${just.title}`;
  chip.classList.remove('ticked');
  void chip.offsetWidth; // so the flash plays again for a second tick in a row
  chip.classList.add('ticked');
  clearTimeout(chipTimer);
  chipTimer = setTimeout(() => chip.classList.remove('ticked'), 4200);
}

function tick(key) {
  if (game.almanac[key] || !game.started) return;
  game.almanac[key] = true;
  saved.set('village-almanac', game.almanac);
  sound.jingle('tick');
  showAlmanac(ALMANAC.find((entry) => entry.key === key));
  if (almanacDone() === ALMANAC.length) game.almanacEnding = game.t + 6; // the last word, once the moment has passed
}

function openAlmanac() {
  const done = almanacDone();
  const all = done === ALMANAC.length;
  const rows = ALMANAC.map((entry) => {
    const ticked = !!game.almanac[entry.key];
    const line = ticked ? ui.el('p', {}, ui.el('b', { text: 'On Modal: ' }), entry.modal) : ui.el('p', { text: entry.how });
    return ui.el('li', { class: ticked ? 'done' : '' }, ui.el('span', { class: 'box', text: ticked ? '✓' : '' }), ui.el('div', {}, ui.el('h3', { text: entry.title }), line));
  });
  const started = game.villagers.reduce((sum, v) => sum + (v.state.wakes || 0), 0);
  const quickest = game.almanac.quickest ? `, the quickest in ${seconds(game.almanac.quickest)}` : '';
  const ending = all
    ? ui.el(
        'div',
        { class: 'on-modal ending' },
        ui.el('img', { src: 'brand/modal-mark.svg', alt: '' }),
        ui.el(
          'div',
          {},
          ui.el('p', {}, ui.el('b', { text: 'That is the whole village. ' }), `It has started ${started} sandboxes for you so far${quickest}. Each thing on this list is a few lines of Python on Modal.`),
          ui.el('a', { class: 'cta', href: SANDBOX_DOCS, target: '_blank', rel: 'noopener', text: 'Build with Modal Sandboxes' }),
        ),
      )
    : null;
  ui.reader.open({
    title: 'Almanac',
    sub: all ? `all ${ALMANAC.length} done` : `${done} of ${ALMANAC.length} things to try`,
    body: [ending, ui.el('ul', { class: 'almanac' }, ...rows), all ? null : ui.el('p', { class: 'muted', text: 'Each one ticks itself off when you do it.' })],
    actions: [{ label: all ? 'Keep playing' : 'Off I go', run: () => ui.reader.close() }],
  });
}
ui.$('almanac-toggle').addEventListener('click', openAlmanac);
showAlmanac();

// The card on a villager's mailbox: which model they think with, how their sandbox is run,
// which tools they hold, and the file they keep on show.
function openAbout(v) {
  const brain = game.brains.find((other) => other.key === v.brain) || game.brains[0] || {};
  ui.reader.open({ title: `${v.name} the ${v.role}`, sub: v.blurb, body: ui.aboutBody(v, brain) });
}

const CROPS = ['sunflower', 'tulip', 'pumpkin', 'cabbage', 'carrot', 'mushroom', 'rose', 'bean'];

function gardenCrops(v) {
  return (v.state.exhibit || '').split('\n').map((line) => line.trim().toLowerCase()).filter((line) => CROPS.includes(line)).slice(-8);
}

function openGarden(v) {
  ui.reader.open({
    title: `${v.name}'s garden`,
    sub: `${v.exhibit} in ${v.name}'s sandbox`,
    body: [
      ui.el('p', { text: `This plot is a file. Each plant you see is one line of ${v.exhibit} in ${v.name}'s home directory, and only ${v.name} has the tool that adds a line. Ask her to plant something and watch the bed change.` }),
      ui.el('pre', { text: v.state.exhibit || '(empty: nothing is planted)' }),
      ui.el('p', { class: 'muted small', text: v.state.status === 'awake' ? 'Read from her running sandbox.' : 'She is asleep: this is the copy that was read before her sandbox was snapshotted.' }),
    ],
  });
}

// A line added to the landmark signs when no Modal is behind the game.
function offlineNote() {
  return game.info.mode === 'offline' ? ui.el('p', { class: 'muted small', text: 'You are playing offline: the homes are folders on this machine and no model is called. With Modal behind the game, everything on this sign is literal.' }) : null;
}

function openCellar() {
  const kept = game.villagers.filter((v) => !v.ephemeral && v.state.snapshots.length).length;
  const rows = game.villagers.map((v) => {
    const latest = v.state.snapshots[0];
    const what = v.ephemeral ? 'never saved, on purpose' : latest ? `saved, ${latest.files} files` : 'nothing saved yet';
    return ui.el('li', {}, ui.el('strong', { text: `${v.name}: ` }), what);
  });
  const crystals = game.villagers.map((v) => ({ color: v.color, lit: !v.ephemeral && v.state.snapshots.length > 0, fresh: false }));
  ui.reader.open({
    title: 'The snapshot cellar',
    sub: 'saved houses',
    body: ui.signpost({
      picture: pictureOf(104, 52, 38, 46, (c) => scenery.drawCellar(c, ORIGIN, crystals, game.t)),
      kicker: 'Sandbox snapshots',
      headline: 'Where sleeping houses are kept.',
      plain: ['Each crystal is one sleeping villager\'s whole house: everything on their shelves, saved until they wake.'],
      stat: `${kept} of ${game.villagers.length} houses saved`,
      modal: 'a filesystem snapshot of a sandbox. The sandbox itself is gone; waking a villager starts a new one from the snapshot, usually in about a second.',
      more: [ui.el('ul', { class: 'notes' }, ...rows)],
      note: offlineNote(),
    }),
  });
}

function openBell() {
  ui.reader.open({
    title: 'The watchman\'s bell',
    sub: 'bedtime',
    body: ui.signpost({
      picture: pictureOf(40, 56, 20, 51, (c) => scenery.drawBell(c, ORIGIN, game.t, false)),
      kicker: 'Scale to zero',
      headline: 'Walk away and they go to sleep.',
      plain: [`When nobody has been near a villager for ${Math.round(game.idle)} seconds, the watchman rings this bell and puts them to bed. Walk back and they wake up where they left off.`],
      stat: `Rung ${game.bedtimes} time${game.bedtimes === 1 ? '' : 's'} since you arrived`,
      modal: 'going to bed saves the sandbox as a snapshot and shuts it down, so an empty village runs nothing. A scheduled function makes the same sweep in case the game itself stops.',
      note: offlineNote(),
    }),
    actions: [{ label: 'Ring it: wake the whole village', run: wakeVillage }],
  });
}

// The TV: Cold Start Chase. Every maze is drawn by a program in the villager's sandbox (in a
// sidecar container beside it, where there is one), and the best score is a file on their
// shelf. The chase itself runs here in the page (chase.js).
const STEER = { arrowup: [0, -1], w: [0, -1], arrowdown: [0, 1], s: [0, 1], arrowleft: [-1, 0], a: [-1, 0], arrowright: [1, 0], d: [1, 0] };
async function openArcade(v) {
  const screen = ui.el('canvas', { class: 'tv-game', width: 240, height: 176 });
  const status = ui.el('p', { class: 'tv-status', text: 'Switching on…' });
  const score = ui.el('p', { class: 'tv-score' });
  const shell = ui.el('pre', { class: 'tv-shell', text: '$ …' });
  const again = ui.el('button', { type: 'button', class: 'tv-new', text: 'Play again', hidden: true, onclick: () => newMaze(true) });
  const pad = ui.el('div', { class: 'tv-pad' }, ...[['▲', [0, -1], 'up'], ['◀', [-1, 0], 'left'], ['▶', [1, 0], 'right'], ['▼', [0, 1], 'down']].map(([text, dir, name]) => ui.el('button', { type: 'button', class: name, 'aria-label': name, text, onpointerdown: () => run?.steer(dir) })));
  let run = null;
  let level = 1;
  let points = 0;
  let best = 0;
  let closed = false;
  const showScore = () => (score.textContent = `Score ${points} · maze ${level} · best ${Math.max(best, points)}`);
  const real = /vm/i.test(String(v.state.runtime || v.runtime || ''));
  const how = ui.el('span', { text: `every maze is drawn by a program in ${v.name}'s sandbox.` });
  const explain = (sidecar) => {
    const where = real ? ', which here is a real virtual machine' : '';
    how.textContent = sidecar
      ? `every maze is drawn by ${v.name}'s games console, a sidecar: a second container running beside the main one in the same sandbox${where}. The best score is a file on ${v.name}'s shelf, so it survives sleep. Only the chase is drawn in your browser.`
      : `every maze is drawn by a program in ${v.name}'s sandbox${where}. The best score is a file on ${v.name}'s shelf, so it survives sleep. Only the chase is drawn in your browser.`;
  };
  const noises = { dot: () => sound.blip(660, 'square'), freeze: () => sound.jingle('spell'), warm: () => sound.blip(990, 'square'), caught: () => sound.jingle('crash') };

  async function newMaze(reset) {
    if (reset) {
      level = 1;
      points = 0;
    }
    again.hidden = true;
    status.textContent = 'The console is drawing a maze…';
    shell.textContent = `$ python3 games/tv.py new\n  running in ${v.name}'s sandbox…`;
    let state;
    try {
      state = await api.arcade(v.id, 'new');
    } catch (error) {
      status.textContent = error.message;
      return;
    }
    if (closed) return;
    explain(state.sidecar);
    best = state.best || 0;
    shell.textContent = `$ ${state.command}\n  maze #${state.seed}, drawn by ${state.by === 'console' ? 'the console (a sidecar container)' : `${v.name}'s main container`} in ${seconds(state.ms)}`;
    run?.stop();
    run = startChase(screen, {
      grid: state.grid,
      level,
      sound: (name) => noises[name]?.(),
      onScore: (more) => {
        points += more;
        showScore();
      },
      onEnd: finished,
    });
    game.chase = { run, grid: state.grid }; // the game in play, for a program that plays it
    tick('maze');
    status.textContent = TOUCH
      ? 'Collect every dot. A blue crystal lets you catch the cold starts.'
      : 'Arrow keys or W A S D. Collect every dot. Dodge the cold starts, or take a blue crystal and catch them while they are frozen.';
    showScore();
  }

  async function finished({ won }) {
    if (won) {
      points += 100;
      level += 1;
      showScore();
      sound.jingle('gift');
      status.textContent = 'Maze cleared! The console is drawing the next one…';
      await sleep(900);
      if (!closed) newMaze(false);
      return;
    }
    status.textContent = `Caught by a cold start. You scored ${points}.`;
    again.hidden = false;
    try {
      const state = await api.arcade(v.id, `score:${points}`);
      best = state.best || best;
      shell.textContent = `$ ${state.command}\n  saved to games/scores.json in ${v.name}'s sandbox in ${seconds(state.ms)}`;
      showScore();
    } catch {
      /* the score is only not saved */
    }
  }

  const onKey = (event) => {
    const dir = STEER[event.key.toLowerCase()];
    if (!dir || !run) return;
    event.preventDefault();
    run.steer(dir);
  };
  addEventListener('keydown', onKey);
  ui.reader.open({
    title: v.style === 'gpu' ? `${v.name}'s screen` : `${v.name}'s TV`,
    sub: 'Cold Start Chase',
    body: [
      ui.el('div', { class: 'tv' }, ui.el('div', { class: 'tv-screen' }, screen), ui.el('div', { class: 'tv-side' }, status, score, again, pad, shell)),
      ui.el('div', { class: 'on-modal' }, ui.el('img', { src: 'brand/modal-mark.svg', alt: '' }), ui.el('p', {}, ui.el('b', { text: 'On Modal: ' }), how)),
      offlineNote(),
    ],
    onClose: () => {
      closed = true;
      run?.stop();
      removeEventListener('keydown', onKey);
      if (game.house?.v === v) loadHouse();
    },
  });
  newMaze(true);
}

// Ring the bell: every sleeping villager's sandbox starts at the same moment.
async function wakeVillage() {
  ui.reader.close();
  const asleep = game.villagers.filter((v) => v.state.status === 'asleep' && !v.pending);
  if (!asleep.length) {
    ui.toast('Nobody is asleep.', 'Everyone is already up.');
    return;
  }
  sound.jingle('bell');
  game.bellUntil = game.t + 3;
  game.hush = game.t + 8; // one result card instead of a notice per house
  for (const v of asleep) v.pending = 'waking';
  ui.toast(`Starting ${asleep.length} sandbox${asleep.length === 1 ? '' : 'es'} at the same time…`, 'The bell rings.', 5000, 'sandbox');
  let result = null;
  try {
    result = await api.wakeAll();
  } catch (error) {
    ui.toast(error.message, 'The bell would not ring:');
  }
  for (const v of asleep) v.pending = null;
  await refreshState(false);
  if (!result) return;
  sound.jingle('wake');
  tick('bell');
  const rows = result.woken.map((one) => {
    const v = game.byId[one.id];
    const how = one.error ? 'did not start' : `${seconds(one.ms ?? 0)}, ${v?.ephemeral ? 'from nothing' : one.from === 'snapshot' ? 'from its snapshot' : 'for the first time'}`;
    return ui.el('li', {}, ui.el('strong', { text: `${v?.name || one.id}: ` }), how);
  });
  ui.reader.open({
    title: 'The whole village is up',
    sub: 'all at once',
    body: ui.signpost({
      picture: pictureOf(40, 56, 20, 51, (c) => scenery.drawBell(c, ORIGIN, game.t, true)),
      kicker: 'Scale up',
      headline: `${result.count} sandbox${result.count === 1 ? '' : 'es'} started in ${seconds(result.ms)}.`,
      plain: [
        'Not one after another: all of them at the same moment, each from its own saved house. A moment ago none of them was running.',
        `Walk away and the watchman puts them back to bed in about ${Math.round(game.idle)} seconds. Each house counts down.`,
      ],
      modal: 'every villager is a separate Modal Sandbox, and sandboxes start side by side: the whole village takes about as long as its slowest house.',
      more: [ui.el('ul', { class: 'notes' }, ...rows)],
      note: offlineNote(),
    }),
  });
}

function openGpuPatch() {
  const requests = game.brains.reduce((sum, brain) => sum + (brain.requests || 0), 0);
  ui.reader.open({
    title: 'The GPU patch',
    sub: 'where the thinking happens',
    body: ui.signpost({
      picture: pictureOf(70, 42, 35, 37, (c) => scenery.drawGpuPatch(c, ORIGIN, game.t, false)),
      kicker: 'GPUs',
      headline: 'Nobody here owns a brain.',
      plain: ['When a villager thinks, the words come from an AI model running on machines like these, far from the village. The fans spin whenever somebody is thinking.'],
      stat: `${requests} thought${requests === 1 ? '' : 's'} so far`,
      modal: 'the models run on Modal\'s GPUs, behind the two towers on the lane (Modal Model APIs). The village shares them with everyone else who calls the same endpoints.',
      note: offlineNote(),
    }),
  });
}

function openRegister() {
  const wakes = game.villagers.reduce((sum, v) => sum + (v.state.wakes || 0), 0);
  const rows = game.villagers.map((v) => {
    const st = v.state;
    const where = st.status === 'awake' ? `awake in ${String(st.sandbox_id).slice(0, 16)}…` : st.snapshot_id ? `asleep, saved as ${String(st.snapshot_id).slice(0, 14)}…` : 'asleep, never saved';
    return ui.el('li', {}, ui.el('strong', { text: `${v.name}: ` }), `${where} · woken ${st.wakes || 0} time${st.wakes === 1 ? '' : 's'}`);
  });
  ui.reader.open({
    title: 'The village register',
    sub: 'who is where',
    body: ui.signpost({
      picture: pictureOf(30, 34, 15, 30, (c) => scenery.drawRegister(c, ORIGIN, game.t)),
      kicker: 'Modal Dict',
      headline: 'The village keeps nothing in its head.',
      plain: ['Who is awake, which sandbox each house is running in, and where each house was last saved are all written in this book. The game itself can stop and start again and lose nothing.'],
      stat: `${game.villagers.length} entries · ${wakes} wake${wakes === 1 ? '' : 's'} recorded`,
      modal: 'a Modal Dict: a small key-value store that lives on Modal, not in the game server. Each villager has one entry, holding the ID of their sandbox and of their latest snapshot.',
      more: [ui.el('ul', { class: 'notes' }, ...rows)],
      note: offlineNote(),
    }),
  });
}

// The library: what is on the one shelf every house shares. The list comes straight from the
// Volume, so it is the same whoever is awake.
async function openLibrary() {
  const picture = () => pictureOf(48, 54, 24, 50, (c) => scenery.drawLibrary(c, ORIGIN, game.t, librarySpines(), markSprite(8, 6)));
  const card = (files, where) => {
    const makers = new Set(files.map((file) => file.by)).size;
    const rows = files.map((file) => {
      const v = game.byId[file.by];
      return ui.el('li', {}, ui.el('span', { class: 'dot', style: `background:${v?.color || '#888'}` }), ui.el('button', { text: libraryTitle(file.name), onclick: () => openLibraryFile(file) }), ui.el('span', { class: 'size', text: `by ${v?.name || file.by}` }));
    });
    return [
      ...ui.signpost({
        picture: picture(),
        kicker: 'Modal Volume',
        headline: 'One shelf that every house shares.',
        plain: ['When a villager makes you something, their house puts a copy here. It is the one place in the village that belongs to all of them.'],
        stat: files.length ? `${files.length} thing${files.length === 1 ? '' : 's'} on the shelf, from ${makers} villager${makers === 1 ? '' : 's'}` : 'Nothing on the shelf yet. Ask somebody to make you something.',
        modal: `a Modal Volume, mounted in every villager's sandbox at /library. It belongs to no sandbox and no snapshot, so it is still here when every house is dark.`,
      }),
      files.length ? ui.el('ul', { class: 'file-list shelf' }, ...rows) : null,
      where && game.xray ? ui.el('p', { class: 'muted small', text: `Read just now from ${where}.` }) : null,
      offlineNote(),
    ];
  };
  ui.reader.open({ title: 'The village library', sub: 'the shared shelf', body: card(game.library.files, '') });
  tick('library');
  try {
    const { files, where } = await api.library();
    game.library = { files };
    if (ui.reader.isOpen && ui.$('reader-title').textContent === 'The village library') ui.reader.open({ title: 'The village library', sub: 'the shared shelf', body: card(files, where) });
  } catch {
    // the list already shown stands
  }
}

const libraryTitle = (name) => name.replace(/\.[a-z0-9]+$/, '').replace(/-/g, ' ');

async function openLibraryFile(file) {
  const v = game.byId[file.by];
  const back = [{ label: '< Back', run: openLibrary }];
  const title = libraryTitle(file.name);
  ui.reader.open({ title, sub: 'fetching from the Volume…', body: ui.el('p', { class: 'muted working', text: 'Reading' }), actions: back });
  try {
    const entry = await api.libraryFile(file.by, file.name);
    ui.reader.open({ title, sub: `by ${v?.name || file.by} · /library/${file.by}/${file.name}`, body: itemBody(entry), actions: back });
  } catch (error) {
    ui.reader.open({ title, sub: '', body: ui.el('p', { class: 'muted', text: error.message }), actions: back });
  }
}

function stockLibrary() {
  api.library().then(({ files }) => { game.library = { files }; }).catch(() => {});
}

// One book on the library's shelves for each thing in it, in its maker's colour.
function librarySpines() {
  return game.library.files.slice(0, 27).map((file) => game.byId[file.by]?.color || '#888888');
}

function openYard() {
  ui.reader.open({
    title: 'The image yard',
    sub: 'building kits',
    body: ui.signpost({
      picture: pictureOf(80, 44, 40, 38, (c) => scenery.drawYard(c, ORIGIN, markSprite(12, 9))),
      kicker: 'Container image',
      headline: 'What every house is built from.',
      plain: ['Every house starts as the same kit: a small Linux computer with Python on it. What a villager adds after that is their own.'],
      modal: 'a Modal Image (Debian with Python 3.12). Every sandbox starts from it, and a snapshot is that image plus whatever the villager has changed.',
      note: offlineNote(),
    }),
  });
}

// A small pixel version of Modal's logo mark, once the file has loaded.
function markSprite(w, h) {
  return spriteFor('modal-mark', game.markImage, w, h, false);
}

function openPiece(piece) {
  const maker = game.byId[piece.by];
  ui.reader.open({
    title: piece.name,
    sub: `installed by ${maker?.name || piece.by} · ${piece.file || 'an SVG file'}`,
    body: [
      piece.text ? ui.el('img', { class: 'picture', src: piece.image?.src, alt: piece.name }) : null,
      ui.el('p', { text: `${maker?.name || 'A villager'} wrote a program in her sandbox that drew this, then used her install tool. The town copied the file out of the sandbox and stood it here. This is the file:` }),
      ui.el('pre', { text: piece.text || 'Still fetching…' }),
    ],
  });
}

// ---- items the villagers hand over --------------------------------------------------------------

function renderInventory() {
  ui.renderInventory(game.inventory, openItem, (item) => itemSprite(item, 22, 22)?.toDataURL() || null);
}

function saveItems() {
  saved.set('village-inventory', game.inventory);
  saved.set('village-placed-v2', game.placed);
  renderInventory();
}

function receiveItem(item, v) {
  const mine = { id: `item-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, label: item.label, note: item.note, mime: item.mime, base64: item.base64, text: item.text, name: item.name, from: v.name, shelf: item.shelf || null };
  game.inventory.push(mine);
  saveItems();
  tick('made');
  setTimeout(renderInventory, 300); // once the picture has decoded, the slot shows its sprite
  return mine;
}

// A picture is shown as a picture; the file it is made of is tucked away for the curious.
function itemBody(item) {
  const parts = ui.fileBody(item);
  if (!item.mime?.startsWith('image/') || parts.length < 2) return parts;
  return [parts[0], ui.el('details', { class: 'source' }, ui.el('summary', { text: 'See the file this picture is made of' }), ...parts.slice(1))];
}

// `fresh`: the villager has only just handed it over, so say what it is and where it went.
function openItem(item, fresh = false) {
  const actions = [];
  if (game.scene === 'village') {
    actions.push({
      label: 'Put it down here',
      run: () => {
        game.inventory = game.inventory.filter((other) => other.id !== item.id);
        const side = game.player.dir === 'left' ? -14 : 14;
        game.placed.push({ ...item, x: Math.round(game.player.x + side), y: Math.round(game.player.y + 3) });
        saveItems();
        ui.reader.close();
      },
    });
  }
  actions.push({
    label: 'Throw it away',
    run: () => {
      game.inventory = game.inventory.filter((other) => other.id !== item.id);
      saveItems();
      ui.reader.close();
    },
  });
  ui.reader.open({
    title: fresh ? `${item.from} made you: ${item.label}` : item.label,
    sub: fresh ? '' : `from ${item.from}`,
    body: [
      fresh ? ui.el('p', { text: `${item.from} made this just now, inside their house (which is a sandbox), and gave you a copy. It is in your pocket: bottom left of the screen.${item.shelf ? ' Another copy is on the shelf in the village library.' : ''}` }) : null,
      item.note ? ui.el('p', { class: 'muted', text: item.note }) : null,
      ...itemBody(item),
    ],
    actions,
  });
}

function pickUp(item) {
  game.placed = game.placed.filter((other) => other.id !== item.id);
  const { x, y, ...rest } = item;
  game.inventory.push(rest);
  saveItems();
}

// ---- talking --------------------------------------------------------------------------------

function startTalking(v) {
  game.talking = v;
  game.target = null;
  v.bubble = null;
  sound.jingle('hello');
  ui.dialogue.open(v, v.greeting, game.brains.find((brain) => brain.key === v.brain));
  v.greeted = true;
  if (!game.hints.talked) {
    game.hints.talked = true;
    saved.set('village-hints', game.hints);
  }
}

function stopTalking() {
  game.talking = null;
  ui.dialogue.close();
}

// Each villager's voice: a short blip per few letters, at a pitch of their own.
const VOICES = { mo: [587, 'triangle'], ziggy: [349, 'square'], orlo: [196, 'square'], juniper: [330, 'square'], bao: [165, 'triangle'], dot: [440, 'square'], moss: [247, 'triangle'], fennel: [392, 'square'], wisp: [523, 'sine'] };
ui.dialogue.handlers.blip = (v) => {
  if (!v) return;
  v.speaking = game.t + 0.22; // their mouth moves while the words appear
  const [pitch, wave] = VOICES[v.id] || [300, 'square'];
  sound.blip(pitch, wave);
};

const face = ui.$('dlg-face').getContext('2d');
const PORTRAIT_FEET = {}; // where each sprite's feet go so the face sits in the frame; 35 suits most
function drawPortrait(v) {
  face.setTransform(1, 0, 0, 1, 0, 0);
  face.imageSmoothingEnabled = false;
  face.fillStyle = art.mix(v.color, '#fdf3d7', 0.72);
  face.fillRect(0, 0, 24, 24);
  face.fillStyle = art.mix(v.color, '#fdf3d7', 0.58);
  for (let y = 3; y < 24; y += 4) face.fillRect(0, y, 24, 1);
  folk.drawFolk(face, 12, PORTRAIT_FEET[v.id] || 35, { ...villagerLook(v, 'down', false), bubble: null });
}

ui.dialogue.handlers.close = stopTalking;
ui.dialogue.handlers.send = async (message) => {
  const v = game.talking;
  if (!v || game.replying) return;
  if (v.dare && message === v.dare) return dareHome(v);
  game.replying = true;
  ui.dialogue.setBusy(true);
  ui.dialogue.addYou(game.player.name, message);
  ui.dialogue.setStatus(`${v.name} is thinking`, true);
  let changedFiles = false;
  let commands = 0; // how many times they used their computer this turn
  let handed = null; // something they made and gave to the player this turn
  try {
    for await (const event of talkStream(v.id, message, game.player.name, game.player.look)) {
      if (event.type === 'say_delta') {
        ui.dialogue.setStatus('');
        ui.dialogue.appendSay(event.text);
      } else if (event.type === 'llm') {
        game.thinking.set(v.id, event.phase === 'start' ? game.t + 20 : game.t + 0.4);
      } else if (event.type === 'tool_start') {
        v.working = game.t + 30;
        ui.dialogue.setStatus(`${v.name} is busy at the desk`, true);
      } else if (event.type === 'tool_call') {
        v.working = game.t + 30;
        commands += 1;
        if (event.name === 'visit') game.sent = { id: v.id, at: game.t };
        ui.dialogue.feedCall(event);
      } else if (event.type === 'tool_result') {
        v.working = game.t + 0.6;
        ui.dialogue.feedResult(event);
        changedFiles = true;
        if (game.house?.v === v) loadHouse(); // new files land on the shelves while you watch
      } else if (event.type === 'item') {
        handed = receiveItem(event.item, v);
      } else if (event.type === 'error') {
        ui.dialogue.error(event.message);
      } else if (event.type === 'done') {
        const usage = event.usage || {};
        const brain = game.brains.find((other) => other.key === event.brain);
        const used = commands ? `${commands} command${commands === 1 ? '' : 's'} in ${v.name}'s sandbox · ` : '';
        ui.dialogue.finish(`${used}${usage.calls || 0} call${usage.calls === 1 ? '' : 's'} to ${brain?.label || 'the model'} · ${seconds(event.ms)}`);
      }
    }
  } catch (error) {
    ui.dialogue.error(`The conversation dropped: ${error.message}`);
  }
  v.working = 0;
  game.thinking.delete(v.id);
  ui.dialogue.setStatus('');
  await ui.dialogue.finish(); // waits for the words to finish appearing
  ui.dialogue.setBusy(false);
  game.replying = false;
  if (handed) {
    await sleep(500);
    sound.jingle('gift');
    openItem(handed, true); // show them what they were just given
  }
  await refreshState(false);
  if (changedFiles && game.house?.v === v) loadHouse();
};

// ---- input ----------------------------------------------------------------------------------

const MOVE_KEYS = { arrowup: [0, -1], w: [0, -1], arrowdown: [0, 1], s: [0, 1], arrowleft: [-1, 0], a: [-1, 0], arrowright: [1, 0], d: [1, 0] };
// A held key is remembered by where it is on the keyboard, not by the letter it types: the
// letter changes if Shift, Option or Caps Lock goes down meanwhile, and then its release would
// not match and the player would walk on for ever.
const KEY_AT = { KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd', ArrowUp: 'arrowup', ArrowDown: 'arrowdown', ArrowLeft: 'arrowleft', ArrowRight: 'arrowright' };
const moveKey = (event) => KEY_AT[event.code] || (event.key.toLowerCase() in MOVE_KEYS ? event.key.toLowerCase() : null);
// Let go of everything. The browser does not report a key released while the page is not
// listening: after a click on another window, a right-click menu, or with Cmd held on a Mac.
const releaseKeys = () => {
  game.keys.clear();
  game.player.moving = false;
};
const typing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);

for (const name of ['keydown', 'pointerdown', 'touchstart']) addEventListener(name, () => (game.lastInput = Date.now()), { passive: true });

addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (key === 'escape') {
    if (ui.reader.isOpen) ui.reader.close();
    else if (game.talking) stopTalking();
    else if (!ui.$('hood').hidden) toggleHood(false);
    else if (game.scene === 'house') stepOutside();
    return;
  }
  if (key === 'meta' || event.metaKey) return releaseKeys();
  if (!game.started || typing() || ui.reader.isOpen || game.fading) return;
  if (ui.dialogue.scripted && (key === 'e' || key === 'enter' || key === ' ')) {
    event.preventDefault();
    ui.dialogue.advance(); // Mo's welcome: on to his next line
    return;
  }
  const move = moveKey(event);
  if (move) {
    if (!document.hasFocus()) return;
    game.keys.add(move);
    game.target = null;
    event.preventDefault();
  } else if (key === 'e' || key === 'enter') {
    event.preventDefault();
    if (game.talking && key === 'enter') ui.$('dlg-input').focus();
    else game.action?.run?.();
  } else if (key === 'tab') {
    event.preventDefault();
    toggleHood();
  }
});
addEventListener('keyup', (event) => {
  if (event.key === 'Meta') return releaseKeys();
  game.keys.delete(moveKey(event));
  game.keys.delete(event.key.toLowerCase());
});
for (const name of ['blur', 'pagehide', 'contextmenu']) addEventListener(name, releaseKeys);
document.addEventListener('visibilitychange', () => document.hidden && releaseKeys());

canvas.addEventListener('pointerdown', (event) => {
  if (!game.started || game.fading) return;
  if (typing()) document.activeElement.blur();
  const cam = camera();
  const point = { x: cam.x + event.clientX / game.scale, y: cam.y + event.clientY / game.scale };
  if (game.scene === 'house') {
    const thing = game.house.things.find((other) => Math.abs(other.x - point.x) < 10 && point.y > other.y - 18 && point.y < other.y + 8);
    if (thing && dist(game.house, thing.reach) < 60) return openEntry(game.house.v, thing.entry);
  }
  headFor(point);
});
// a finger kept down and moved steers: the walk follows it
canvas.addEventListener('pointermove', (event) => {
  if (!event.buttons || !game.started || game.fading || !game.target || game.t - game.tapped < 0.12) return;
  const cam = camera();
  headFor({ x: cam.x + event.clientX / game.scale, y: cam.y + event.clientY / game.scale });
});

function toggleHood(show = ui.$('hood').hidden) {
  ui.$('hood').hidden = !show;
  game.xray = show;
  if (show && !game.hints.hood) {
    game.hints.hood = true;
    saved.set('village-hints', game.hints);
  }
  document.body.classList.toggle('xray', show); // the running commentary in the corner only shows with the hood open
  ui.$('hood-toggle').setAttribute('aria-expanded', String(show));
  renderHood();
}
ui.$('hood-toggle').addEventListener('click', () => toggleHood());
ui.$('hood-close').addEventListener('click', () => toggleHood(false));

function showSound() {
  ui.$('sound-toggle').textContent = sound.isMuted() ? 'Sound: off' : 'Sound: on';
  ui.$('sound-toggle').setAttribute('aria-pressed', String(!sound.isMuted()));
}
ui.$('sound-toggle').addEventListener('click', () => {
  sound.unlock();
  sound.setMuted(!sound.isMuted());
  showSound();
  if (!sound.isMuted()) sound.jingle('wake');
});
showSound();

ui.$('welcome-name').value = game.player.name;

// Choose your character: one row of arrows for each part of a look, and a picture of the result
// from the front and from the side.
const LOOK_PARTS = [['skin', 'Skin'], ['hair', 'Hair'], ['hairColor', 'Hair colour'], ['outfit', 'Clothes']];
function showLook() {
  const c = ui.$('look-preview').getContext('2d');
  c.clearRect(0, 0, 48, 36);
  folk.drawFolk(c, 13, 34, { kind: 'player', look: game.player.look, dir: 'down', frame: 0, moving: false, t: 1 });
  folk.drawFolk(c, 35, 34, { kind: 'player', look: game.player.look, dir: 'right', frame: 0, moving: false, t: 1 });
  for (const [part] of LOOK_PARTS) ui.$(`look-${part}`).textContent = folk.LOOKS[part][game.player.look[part]].name;
}
for (const [part, label] of LOOK_PARTS) {
  const turn = (by) => () => {
    const count = folk.LOOKS[part].length;
    game.player.look = { ...game.player.look, [part]: (game.player.look[part] + by + count) % count };
    saved.set('village-look', game.player.look);
    sound.unlock();
    sound.blip(520 + game.player.look[part] * 40, 'square');
    showLook();
  };
  const arrow = (text, by, say) => {
    const button = ui.el('button', { type: 'button', text, 'aria-label': `${say} ${label.toLowerCase()}` });
    button.addEventListener('click', turn(by));
    return button;
  };
  ui.$('look-rows').append(
    ui.el('div', { class: 'look-row' }, arrow('◀', -1, 'Previous'), ui.el('span', { class: 'what' }, ui.el('b', { text: label }), ui.el('span', { id: `look-${part}`, 'aria-live': 'polite' })), arrow('▶', 1, 'Next')),
  );
}
showLook();
ui.$('welcome-form').addEventListener('submit', (event) => {
  event.preventDefault();
  game.player.name = ui.$('welcome-name').value.trim() || 'Visitor';
  saved.set('village-name', game.player.name);
  ui.$('welcome').hidden = true;
  document.body.classList.add('started');
  sound.unlock();
  sound.jingle('wake');
  game.started = true;
  // Mo comes over to say hello every time you walk in (a script filming the game switches this off)
  if (game.hints.intro !== false) setTimeout(greet, 700);
  game.lastInput = Date.now();
  document.activeElement?.blur();
});

// ---- simulation -----------------------------------------------------------------------------

function blockedVillage(x, y) {
  if (x < 8 || y < 30 || x > art.WORLD.w - 8 || y > art.WORLD.h - 4) return true;
  for (const v of game.villagers) {
    const box = art.houseBox(v);
    if (x > box.x - 4 && x < box.x + box.w + 4 && y > box.y - 2 && y < box.y + box.h) return true;
  }
  const onDock = x > art.PLACES.dock.x - 20 && x < art.PLACES.dock.x + 24 && y > art.PLACES.dock.y - 6 && y < art.PLACES.dock.y + 3;
  if (!onDock && ((x - art.POND.x) / (art.POND.rx + 5)) ** 2 + ((y - art.POND.y) / (art.POND.ry + 4)) ** 2 < 1) return true;
  const P = art.PLACES;
  const within = (at, left, right, above, below) => x > at.x - left && x < at.x + right && y > at.y - above && y < at.y + below;
  if (within(P.cellar, 26, 56, 30, 2) || within(P.bell, 14, 14, 11, 2) || within(P.gpu, 35, 35, 35, 2) || within(P.yard, 34, 44, 15, 2)) return true;
  if (within({ x: P.gate.x - 19, y: P.gate.y }, 5, 5, 6, 2) || within({ x: P.gate.x + 18, y: P.gate.y }, 5, 5, 6, 2) || within(P.flag, 5, 5, 6, 2)) return true;
  if (art.LAMPS.some((lamp) => within(lamp, 5, 5, 6, 2))) return true;
  if (game.props.some((prop) => prop.solid && (prop.x - x) ** 2 + (prop.y - 2 - y) ** 2 < 6 ** 2)) return true;
  for (const at of Object.values(art.BEACONS)) {
    if (((x - at.x) / 16) ** 2 + ((y - at.y + 3) / 7) ** 2 < 1) return true;
  }
  for (const at of art.PEDESTALS) {
    if (Math.abs(x - at.x) < 11 && y > at.y - 7 && y < at.y + 3) return true;
  }
  for (const v of game.villagers) {
    if (v.plot && x > v.plot.x - 5 && x < v.plot.x + v.plot.w + 5 && y > v.plot.y - 4 && y < v.plot.y + v.plot.h + 3) return true;
  }
  return game.trees.some((tree) => (tree.x - x) ** 2 + (tree.y - 2 - y) ** 2 < 7 ** 2);
}

function blockedHouse(x, y) {
  const room = art.ROOM;
  if (x < room.left || x > room.right || y < room.top || y > room.bottom) return true;
  if (game.house.v.tv && x > room.tv.x - 17 && y > room.tv.y - 24) return true;
  return room.blocks.some(([bx, by, bw, bh]) => x > bx - 5 && x < bx + bw + 5 && y > by - 2 && y < by + bh + 4);
}

// ---- a way round things, for a tap -----------------------------------------------------------
// A tap (or a click) names a spot; the visitor walks there round whatever is in the way. The
// ground is cut into small squares, the squares reachable from where they stand are found by
// spreading out from it, and the walk goes to the reachable one nearest the tap: so a tap on a
// house, or on the far side of one, still gets you as close as feet can.
const CELL = 6;
const grids = new Map(); // which squares can be stood in, per scene (the village never changes)

function groundOf(blocked, w, h, key) {
  if (key && grids.has(key)) return grids.get(key);
  const cols = Math.ceil(w / CELL);
  const rows = Math.ceil(h / CELL);
  const free = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * CELL + CELL / 2;
      const y = row * CELL + CELL / 2;
      // a little room to spare on every side, so the walk does not graze a corner
      free[row * cols + col] = !blocked(x, y) && !blocked(x - 2, y) && !blocked(x + 2, y) && !blocked(x, y - 2) && !blocked(x, y + 2) ? 1 : 0;
    }
  }
  const ground = { cols, rows, free };
  if (key) grids.set(key, ground);
  return ground;
}

function clearLine(a, b, blocked) {
  const steps = Math.ceil(dist(a, b) / 2);
  for (let i = 1; i < steps; i++) {
    if (blocked(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps)) return false;
  }
  return true;
}

// The points to walk through from `from` to as near `to` as can be reached, or null if there
// is nowhere to go.
function routeTo(from, to, blocked, w, h, key = null) {
  if (!blocked(to.x, to.y) && clearLine(from, to, blocked)) return [{ ...to }];
  const { cols, rows, free } = groundOf(blocked, w, h, key);
  const clamp = (value, top) => Math.max(0, Math.min(top - 1, value));
  const cellOf = (p) => clamp(Math.floor(p.y / CELL), rows) * cols + clamp(Math.floor(p.x / CELL), cols);
  const centre = (cell) => ({ x: (cell % cols) * CELL + CELL / 2, y: Math.floor(cell / cols) * CELL + CELL / 2 });
  let start = cellOf(from);
  if (!free[start]) {
    // standing right against something: start from the nearest square with room in it
    let best = -1;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const col = (start % cols) + dc;
        const row = Math.floor(start / cols) + dr;
        if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
        const cell = row * cols + col;
        if (free[cell] && (best < 0 || dist(centre(cell), from) < dist(centre(best), from))) best = cell;
      }
    }
    if (best < 0) return null;
    start = best;
  }
  const came = new Int32Array(cols * rows).fill(-1);
  const queue = new Int32Array(cols * rows);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  came[start] = start;
  let nearest = start;
  let nearestGap = dist(centre(start), to);
  while (head < tail) {
    const cell = queue[head++];
    const gap = dist(centre(cell), to);
    if (gap < nearestGap) [nearest, nearestGap] = [cell, gap];
    if (gap < CELL / 2 + 0.01) break; // the square the tap is in
    const col = cell % cols;
    const row = (cell - col) / cols;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const c = col + dc;
      const r = row + dr;
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
      const next = r * cols + c;
      if (!free[next] || came[next] >= 0) continue;
      if (dc && dr && (!free[row * cols + c] || !free[r * cols + col])) continue; // no squeezing past a corner
      came[next] = cell;
      queue[tail++] = next;
    }
  }
  const points = [];
  for (let cell = nearest; cell !== start; cell = came[cell]) points.push(centre(cell));
  points.push(centre(start), { x: from.x, y: from.y });
  points.reverse();
  if (!blocked(to.x, to.y) && nearestGap < CELL) points.push({ ...to }); // the exact spot, when feet can stand on it
  // straighten it: from each point, on to the furthest one that can be walked to directly
  const route = [];
  for (let i = 0; i < points.length - 1; ) {
    let j = points.length - 1;
    while (j > i + 1 && !clearLine(points[i], points[j], blocked)) j--;
    route.push(points[j]);
    i = j;
  }
  return route.length ? route : null;
}

// Set off for a spot that was tapped.
function headFor(point) {
  const indoors = game.scene === 'house';
  const body = indoors ? game.house : game.player;
  const route = indoors ? routeTo(body, point, blockedHouse, art.ROOM.w, art.ROOM.h) : routeTo(body, point, blockedVillage, art.WORLD.w, art.WORLD.h, 'village');
  game.route = route;
  game.target = route ? route[route.length - 1] : point;
  game.tapped = game.t;
}

function walk(dt) {
  const body = game.scene === 'house' ? game.house : game.player;
  const blocked = game.scene === 'house' ? blockedHouse : blockedVillage;
  let dx = 0;
  let dy = 0;
  if (game.keys.size && !document.hasFocus()) releaseKeys(); // the page is not the one being typed into
  if (!typing()) {
    for (const key of game.keys) {
      dx += MOVE_KEYS[key][0];
      dy += MOVE_KEYS[key][1];
    }
  }
  if (!game.target || dx || dy) game.route = null; // arrived, called off, or the keys took over
  if (!dx && !dy && game.target) {
    // a tap: along its route a point at a time, or straight there if there is none
    while (game.route?.length > 1 && dist(body, game.route[0]) < 3) game.route.shift();
    const next = game.route?.[0] || game.target;
    const gap = dist(body, next);
    if (gap < 2) game.target = null;
    else {
      dx = (next.x - body.x) / gap;
      dy = (next.y - body.y) / gap;
    }
  }
  const length = Math.hypot(dx, dy);
  game.player.moving = length > 0;
  if (!length) return;
  const speed = (game.scene === 'house' ? 70 : 84) * dt;
  const nx = body.x + (dx / length) * speed;
  const ny = body.y + (dy / length) * speed;
  const before = { x: body.x, y: body.y };
  if (!blocked(nx, ny)) [body.x, body.y] = [nx, ny];
  else if (!blocked(nx, body.y)) body.x = nx;
  else if (!blocked(body.x, ny)) body.y = ny;
  game.player.dir = Math.abs(dx) > Math.abs(dy) * 1.1 ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down';
  if (game.target && dist(before, body) < speed * 0.2) game.target = null; // walked into something
}

// The way a villager walks from one front door to another: out to their street, along it (and
// along an avenue if the other house is on a different street), and up to the door.
function routeBetween(from, fromDoor, to, toDoor) {
  const a = art.streetOf(fromDoor);
  const b = art.streetOf(toDoor);
  const points = [{ x: fromDoor.x, y: a }];
  if (a !== b) {
    const avenue = art.AVENUES.reduce((best, x) => (Math.abs(fromDoor.x - x) + Math.abs(toDoor.x - x) < Math.abs(fromDoor.x - best) + Math.abs(toDoor.x - best) ? x : best));
    points.push({ x: avenue, y: a }, { x: avenue, y: b });
  }
  points.push({ x: toDoor.x, y: b }, { ...to });
  let length = 0;
  let last = from;
  for (const point of points) {
    length += dist(last, point);
    last = point;
  }
  return { points, length };
}

function updateVillager(v, dt) {
  v.show = v.pending === 'waking' ? 'waking' : v.state.status;
  const wanted = game.whereabouts[v.id] && game.byId[game.whereabouts[v.id]] ? game.whereabouts[v.id] : 'home';

  if (v.led) return leadStep(v, dt); // being walked somewhere by the game itself (Mo's welcome)
  if (wanted !== v.place && !v.path) {
    // Setting off: to a neighbour's door, or back to their own.
    const goingHome = wanted === 'home';
    const host = goingHome ? v : game.byId[wanted];
    const fromDoor = v.place === 'home' ? v.door : game.byId[v.place].door;
    v.out = 1;
    const route = routeBetween(v.pos, fromDoor, goingHome ? v.spot : host.guest, host.door);
    v.path = route.points;
    v.pace = Math.max(45, Math.min(150, route.length / Math.max(1.5, (v.walkFor || 5) - 0.4)));
    v.place = wanted;
  }

  if (v.path) {
    let step = v.pace * dt;
    v.walking = true;
    while (v.path && step > 0) {
      const next = v.path[0];
      const gap = dist(v.pos, next);
      if (gap <= step) {
        v.pos = { ...next };
        v.path.shift();
        step -= gap;
        if (!v.path.length) v.path = null;
      } else {
        const dx = next.x - v.pos.x;
        const dy = next.y - v.pos.y;
        v.pos.x += (dx / gap) * step;
        v.pos.y += (dy / gap) * step;
        v.facing = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down';
        step = 0;
      }
    }
    return;
  }

  v.walking = false;
  if (v.place === 'home') {
    // (somebody whose house has fallen down stands beside what is left of it)
    const goal = (v.show === 'awake' && v.pending !== 'sleeping') || v.state.status === 'rubble' ? 1 : 0;
    const before = v.out;
    v.out += Math.sign(goal - v.out) * Math.min(Math.abs(goal - v.out), dt * 1.6);
    v.walking = v.out !== before && v.out > 0.02 && v.out < 0.98;
    const ease = v.out * v.out * (3 - 2 * v.out);
    v.pos.x = v.door.x + (v.spot.x - v.door.x) * ease;
    v.pos.y = v.door.y + 3 + (v.spot.y - v.door.y - 3) * ease;
    if (v.walking) v.facing = 'down';
  }
}

// A villager the game is walking somewhere: along `led.path`, then `led.then()`.
function leadStep(v, dt) {
  const led = v.led;
  let step = led.pace * dt;
  v.walking = led.path.length > 0;
  while (led.path.length && step > 0) {
    const next = led.path[0];
    const gap = dist(v.pos, next);
    if (gap <= step) {
      v.pos = { ...next };
      led.path.shift();
      step -= gap;
    } else {
      const dx = next.x - v.pos.x;
      const dy = next.y - v.pos.y;
      v.pos.x += (dx / gap) * step;
      v.pos.y += (dy / gap) * step;
      v.facing = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down';
      step = 0;
    }
  }
  if (!led.path.length && led.then) {
    const then = led.then;
    led.then = null;
    v.walking = false;
    then();
  }
}

// The way between a house and a spot in the village, along the roads: down the path to the
// house's street, along it to the nearest avenue, down that, and across to the spot.
function wayTo(v, spot) {
  const street = art.STREETS.reduce((best, y) => (Math.abs(y - (v.door.y + 48)) < Math.abs(best - (v.door.y + 48)) ? y : best));
  const cross = art.STREETS.reduce((best, y) => (Math.abs(y - spot.y) < Math.abs(best - spot.y) ? y : best));
  const avenue = art.AVENUES.reduce((best, x) => (Math.abs(x - spot.x) + Math.abs(x - v.door.x) < Math.abs(best - spot.x) + Math.abs(best - v.door.x) ? x : best));
  const points = [{ x: v.door.x, y: street }];
  if (cross !== street) points.push({ x: avenue, y: street }, { x: avenue, y: cross });
  points.push({ x: spot.x, y: cross }, spot);
  return points;
}

// Each time you walk in: Mo wakes, walks over to wherever you are, says what the village is in
// four lines (one, if you have heard them), and walks home. Nothing here goes through a model: the lines are written below.
async function greet() {
  const mo = game.byId.mo;
  const done = () => {
    game.hints.met = true;
    saved.set('village-hints', game.hints);
  };
  if (!mo || game.guide) return;
  game.guide = mo;
  try {
    if (mo.state.status !== 'awake') await wake(mo);
    if (mo.state.status !== 'awake') throw new Error('Mo would not wake');
    for (let i = 0; i < 40 && mo.out < 0.9; i++) await sleep(100); // out of his front door first
    const meet = () => ({ x: game.player.x + (game.player.x > mo.door.x ? -20 : 20), y: game.player.y + 2 });
    await new Promise((arrived) => {
      mo.led = { pace: 130, path: wayTo(mo, meet()), then: arrived };
    });
    if (game.scene !== 'village' || dist(mo.pos, game.player) > 70) {
      // you had wandered off, or gone indoors: he says it another time
      game.guide = null;
      return goHome(mo);
    }
    mo.facing = facing(mo.pos, game.player);
    game.talking = mo;
    game.target = null;
    sound.jingle('hello');
    const name = game.player.name && game.player.name !== 'Visitor' ? `, ${game.player.name}` : '';
    // the whole introduction the first time; one line for somebody who has heard it
    await ui.dialogue.script(mo, game.hints.met ? [`Welcome back${name}! I'm Mo. Find me at the GPU-shaped house if you need anything.`] : [
      `Hi${name}! I'm Mo. Welcome to Sandbox Village.${game.mine.per_visitor ? ' This one is yours: nobody else is in it.' : ''}`,
      'Every house here is a Modal Sandbox: a small computer of its own. Walk up to a dark one and it starts.',
      `The yellow arrow points at the next thing to try. Your almanac, ${TOUCH ? 'at the top' : 'top right'}, has all seven.`,
    ]);
    done();
  } catch {
    done();
    openAlmanac(); // no Mo today: the things to try, as a card
  }
  if (game.talking === mo) stopTalking();
  game.guide = null;
  goHome(mo);
}

function goHome(v) {
  if (!v.led) v.led = { pace: 110, path: [], then: null };
  const back = wayTo(v, { x: v.pos.x, y: v.pos.y }).reverse().slice(1);
  v.led = {
    pace: 110,
    path: [...back, { x: v.door.x, y: v.door.y + 26 }, { ...v.spot }],
    then: () => {
      v.led = null; // home again: back to being an ordinary villager
      v.place = 'home';
      v.out = 1;
    },
  };
}

function update(dt) {
  game.t += dt;
  for (const v of game.villagers) updateVillager(v, dt);
  glide(dt);
  if (!game.started) return;
  if (!ui.reader.isOpen && !game.fading) {
    const before = { x: game.player.x, y: game.player.y };
    walk(dt);
    if (game.hints.walked < 60) game.hints.walked += dist(before, game.player);
  }

  for (const v of game.villagers) {
    const near = game.scene === 'house' ? (game.house.v === v ? 0 : Infinity) : dist(game.player, v.door);
    if (v.state.status === 'asleep' && !v.pending && near < WAKE_RADIUS && !(v.retryAt > game.t)) wake(v);
  }

  // Walking away ends a conversation.
  if (game.talking && !game.replying) {
    const v = game.talking;
    const gap = game.scene === 'house' ? dist(game.house, art.ROOM.desk) : dist(game.player, v.pos);
    if (gap > 60 || v.state.status !== 'awake') stopTalking();
  }

  if (game.almanacEnding && game.t > game.almanacEnding && !game.talking && !game.guide && !ui.reader.isOpen && !game.fading && game.scene === 'village') {
    game.almanacEnding = 0;
    openAlmanac();
  }

  game.action = game.fading ? null : findAction();
  game.goal = nextGoal();
  if (game.talking) drawPortrait(game.talking);
  const quiet = game.talking || ui.reader.isOpen || game.fading;
  const hint = quiet || game.action ? '' : hintText();
  ui.setPrompt(quiet ? '' : game.action?.label || hint, game.action?.run, !game.action, TOUCH);
}

const TOUCH = matchMedia('(pointer: coarse)').matches; // a phone or tablet: no keyboard to point at

// The first minute: one pointer at a time, each gone for good once it has been followed.
// ---- what to do next ---------------------------------------------------------------------------
// The first thing in the almanac that is not done yet, said in a line at the bottom of the
// screen and pointed at by a yellow arrow beside the visitor. Nobody is left standing in a field
// wondering what the place is for; once all seven are done it goes away.
function nextGoal() {
  if (!game.started || game.guide || game.film) return null;
  const entry = ALMANAC.find((one) => !game.almanac[one.key]);
  if (!entry) return null;
  const me = game.player;
  const nearest = (list, spot) => list.slice().sort((a, b) => dist(me, spot(a)) - dist(me, spot(b)))[0];
  const step = (v) => ({ x: v.door.x, y: v.door.y + 12 }); // just outside a front door
  const asleep = game.villagers.filter((v) => v.state.status === 'asleep');
  const up = game.villagers.filter((v) => v.state.status === 'awake' && v.place === 'home' && !v.led && !v.path);
  const inside = game.scene === 'house' ? game.house.v : null;
  const wakeOne = (then) => {
    const v = nearest(asleep, step);
    return v ? { at: step(v), text: `Walk up to a dark house${then}` } : null;
  };
  let goal = null;
  if (entry.key === 'wake') goal = wakeOne('. Whoever lives there wakes up');
  else if (entry.key === 'made') {
    const v = nearest(up, (one) => one.pos);
    goal = v ? { at: v.pos, text: `Ask ${v.name} to make you something`, over: folk.heightOf(v.id) + 6 } : wakeOne(', then ask for something');
  } else if (entry.key === 'file') {
    if (inside) goal = { text: 'Walk up to something on a shelf and read it' };
    else {
      const v = nearest(up, step);
      goal = v ? { at: { x: v.door.x, y: v.door.y + 5 }, text: `Go into ${v.name}'s house and read a file on the shelf` } : wakeOne(', then go inside');
    }
  } else if (entry.key === 'bell') goal = { at: { x: art.PLACES.bell.x, y: art.PLACES.bell.y + 8 }, text: 'Ring the bell on the top road', over: 58 };
  else if (entry.key === 'library') goal = { at: { x: art.PLACES.library.x, y: art.PLACES.library.y + 8 }, text: 'Look in the library', over: 56 };
  else if (entry.key === 'maze') {
    const mo = game.byId.mo;
    if (inside?.tv) goal = { text: 'Walk up to the screen and play' };
    else if (mo) goal = { at: mo.state.status === 'awake' ? { x: mo.door.x, y: mo.door.y + 5 } : step(mo), text: "Play the maze on the screen in Mo's house" };
  } else if (entry.key === 'dare') {
    const ziggy = game.byId.ziggy;
    if (ziggy?.state.status === 'rubble') goal = { at: step(ziggy), text: `Walk up to the rubble to bring ${ziggy.name}'s house back` };
    else if (ziggy) goal = { at: ziggy.state.status === 'awake' && isOutside(ziggy) ? ziggy.pos : step(ziggy), text: 'Dare Ziggy, the raccoon, to delete his computer' };
  }
  if (!goal) return null;
  if (inside && goal.at) return { ...goal, at: null, text: `${goal.text} (the door is at the bottom)` };
  return goal;
}

// The arrow: beside the visitor, pointing at the goal, until they are nearly there; and a marker
// over the goal itself once it is in sight, unless the yellow button's own marker is there.
function drawGuide() {
  const goal = game.goal;
  if (!goal?.at || game.scene !== 'village' || game.talking || ui.reader.isOpen || game.fading) return;
  const me = game.player;
  const gap = dist(me, goal.at);
  if (gap > 46) {
    // it points along the way feet can go (round a house, not through it), found a few times a second
    if (!(game.goalWay?.until > game.t) || dist(game.goalWay.to, goal.at) > 10) {
      game.goalWay = { to: { ...goal.at }, until: game.t + 0.3, points: routeTo(me, goal.at, blockedVillage, art.WORLD.w, art.WORLD.h, 'village') || [goal.at] };
    }
    const next = game.goalWay.points.find((point) => dist(me, point) > 14) || goal.at;
    const angle = Math.atan2(next.y - me.y, next.x - me.x);
    const reach = 21 + Math.sin(game.t * 4) * 1.5;
    art.drawPointer(ctx, Math.round(me.x + Math.cos(angle) * reach), Math.round(me.y - 13 + Math.sin(angle) * reach), angle);
  }
  if (gap > 20 && !game.action?.at) {
    const x = Math.round(goal.at.x);
    const y = Math.round(goal.at.y - (goal.over || 44) + 4 + Math.sin(game.t * 6) * 1.5);
    art.drawChevron(ctx, x, y); // the same small mark the yellow button hangs over things
  }
}

function hintText() {
  const hints = game.hints;
  const goal = game.goal;
  if (game.scene !== 'village') return goal && !goal.at ? `Next: ${goal.text}` : '';
  const fallen = game.villagers.find((v) => v.dared && v.show === 'rubble');
  if (fallen) return `Walk up to the rubble to bring ${fallen.name}'s house back`;
  if (hints.walked < 60) return `${TOUCH ? 'Tap where you want to go' : 'Walk with W A S D or the arrow keys'}${goal?.at ? '. Follow the yellow arrow' : ''}`;
  if (game.villagers.some((v) => v.show === 'waking' && dist(game.player, v.door) < 90)) return 'A sandbox is starting: someone is waking up';
  return goal ? `Next: ${goal.text}` : '';
}

function findAction() {
  const options = [];
  if (game.scene === 'house') {
    const { v, things } = game.house;
    const me = game.house;
    const home = v.place === 'home' && !v.path;
    if (dist(me, art.ROOM.door) < 16) options.push({ gap: dist(me, art.ROOM.door), label: 'Go back outside', run: stepOutside });
    if (home && dist(me, art.ROOM.desk) < 30) options.push({ gap: dist(me, art.ROOM.desk) - 6, label: `Talk to ${v.name}`, run: () => startTalking(v), at: { x: art.ROOM.desk.x, y: art.ROOM.desk.y - folk.heightOf(v.id) + 3 } });
    if (v.tv) {
      const gap = dist(me, art.ROOM.tv.reach);
      if (gap < 24) options.push({ gap: gap - 8, tv: true, label: v.style === 'gpu' ? `Play Cold Start Chase on ${v.name}'s screen` : `Play on ${v.name}'s TV`, run: () => openArcade(v), at: { x: art.ROOM.tv.x, y: art.ROOM.tv.y - 46 } });
    }
    for (const thing of things) {
      const gap = dist(me, thing.reach);
      if (gap < 15) options.push({ gap: thing.open ? gap - 4 : gap, thing, label: thing.open ? 'Read the GPU Glossary on the table' : thing.entry.type === 'dir' ? `Look in ${thing.entry.name}/` : `Read ${thing.entry.name}`, run: () => (thing.open ? openGlossary(v) : openEntry(v, thing.entry)) });
    }
  } else {
    const me = game.player;
    for (const v of game.villagers) {
      const atDoor = dist(me, { x: v.door.x, y: v.door.y + 5 });
      const outside = v.place !== 'home' || v.out > 0.9;
      if (v.state.status === 'awake' && outside && !v.path && !v.led && dist(me, v.pos) < 24) options.push({ gap: dist(me, v.pos) - 5, label: `Talk to ${v.name}`, run: () => startTalking(v), at: { x: v.pos.x, y: v.pos.y - folk.heightOf(v.id) + 3 }, over: v });
      if (v.show === 'rubble' && atDoor < 46 && !v.pending) options.push({ gap: atDoor - 20, label: v.state.snapshot_id ? `Rebuild ${v.name}'s house from its snapshot` : `Rebuild ${v.name}'s house`, run: () => restoreHome(v, v.state.snapshot_id ? 'latest' : 'fresh'), at: { x: v.door.x, y: v.door.y - 34 } });
      else if (atDoor < 13) {
        if (v.show === 'awake') {
          peekShelf(v);
          options.push({ gap: atDoor, label: `Go into ${v.name}'s house`, run: () => enterHouse(v), at: { x: v.door.x, y: v.door.y - 31 } });
        }
        else options.push({ gap: atDoor, label: `${v.name} is waking up…` });
      }
      if (v.show !== 'rubble' && dist(me, v.mailbox) < 15) options.push({ gap: dist(me, v.mailbox) + 2, label: `About ${v.name}: brain, sandbox and tools`, run: () => openAbout(v), at: { x: v.mailbox.x, y: v.mailbox.y - 22 } });
      if (v.plot) {
        const bed = { x: v.plot.x + v.plot.w / 2, y: v.plot.y + v.plot.h + 6 };
        if (dist(me, bed) < 30) options.push({ gap: dist(me, bed) - 10, label: `Look at ${v.name}'s garden (a file in her sandbox)`, run: () => openGarden(v) });
      }
    }
    for (const brain of game.brains) {
      const at = art.BEACONS[brain.key];
      if (at && dist(me, at) < 30) options.push({ gap: dist(me, at) - 8, label: `Look at the ${brain.label} tower (Modal Model APIs)`, run: () => openBeacon(brain.key), at: { x: at.x, y: at.y - 62 } });
    }
    for (const [key, reach, text, run] of [
      ['cellar', 20, 'Look into the snapshot cellar', openCellar],
      ['bell', 18, 'Look at the watchman\'s bell (you can ring it)', openBell],
      ['gpu', 28, 'Look at the GPU patch', openGpuPatch],
      ['yard', 30, 'Look at the image yard', openYard],
      ['gate', 26, 'Read the welcome sign: what is this?', openGuide],
      ['register', 18, 'Look at the village register', openRegister],
      ['library', 24, 'Look in the village library', openLibrary],
    ]) {
      const gap = dist(me, { x: art.PLACES[key].x, y: art.PLACES[key].y + 6 });
      if (gap < reach) options.push({ gap: gap - 4, label: text, run });
    }
    if (dist(me, ANGLER) < 24) options.push({ gap: dist(me, ANGLER) - 4, label: 'Say hello', run: openAngler });
    art.PEDESTALS.forEach((at, slot) => {
      const gap = dist(me, { x: at.x, y: at.y + 6 });
      if (gap > 16) return;
      const piece = [...game.pieces.values()].find((other) => other.slot === slot);
      if (piece) options.push({ gap, label: `Look at "${piece.name}"`, run: () => openPiece(piece) });
      else options.push({ gap: gap + 6, label: 'An empty pedestal. Juniper can install things here.' });
    });
    for (const item of game.placed) {
      if (dist(me, item) < 15) options.push({ gap: dist(me, item), label: `Pick up ${item.label}`, run: () => pickUp(item), at: { x: item.x, y: item.y - 22 } });
    }
  }
  options.sort((a, b) => a.gap - b.gap);
  return options[0] || null;
}

// ---- drawing --------------------------------------------------------------------------------

function resize() {
  // Whole-number scale: big enough that about 300x190 game pixels fill the window.
  // ?scale=2 in the URL overrides it (a small number shows more of the village at once).
  const forced = Number(new URLSearchParams(location.search).get('scale'));
  game.scale = forced >= 1 && forced <= 8 ? Math.round(forced) : Math.max(2, Math.min(8, Math.floor(Math.min(innerWidth / 300, innerHeight / 190))));
  // one spare game pixel each way, so the canvas can slide by part of a pixel (see `camera`)
  canvas.width = Math.ceil(innerWidth / game.scale) + 1;
  canvas.height = Math.ceil(innerHeight / game.scale) + 1;
  canvas.style.width = `${canvas.width * game.scale}px`;
  canvas.style.height = `${canvas.height * game.scale}px`;
  const ratio = Math.min(devicePixelRatio || 1, 2);
  overlay.width = Math.round(innerWidth * ratio);
  overlay.height = Math.round(innerHeight * ratio);
}
addEventListener('resize', resize);
resize();

// A phone's keyboard slides up over the bottom of the page without telling the layout, and the
// talk box lives at the bottom. `--keyboard` is how much of the page it covers, so the box can
// stand on top of it (style.css, body.keyboard), and the page is not left scrolled part-way.
const glass = window.visualViewport;
function keyboardRoom() {
  const covered = glass ? Math.max(0, innerHeight - glass.height - glass.offsetTop) : 0;
  const up = covered > 80 && typing();
  document.documentElement.style.setProperty('--keyboard', up ? `${Math.round(covered)}px` : '0px');
  document.body.classList.toggle('keyboard', up);
  if (!up && (scrollX || scrollY)) scrollTo(0, 0);
}
glass?.addEventListener('resize', keyboardRoom);
glass?.addEventListener('scroll', keyboardRoom);
addEventListener('focusin', () => setTimeout(keyboardRoom, 60));
addEventListener('focusout', () => setTimeout(keyboardRoom, 60));

// Where the camera wants to be: on the player (or the room), leaving space for the talk box.
function cameraTarget() {
  const viewW = innerWidth / game.scale;
  const viewH = innerHeight / game.scale;
  const panel = game.talking ? Math.min(ui.$('dialogue').offsetHeight + 20, innerHeight * 0.6) / game.scale : 0;
  const clamp = (value, size, limit) => (size >= limit ? (limit - size) / 2 : Math.max(0, Math.min(limit - size, value)));
  if (game.scene === 'house') {
    const usable = viewH - panel;
    const focus = game.talking ? art.ROOM.desk.y - 18 : game.house.y - 20;
    return { x: clamp(game.house.x - viewW / 2, viewW, art.ROOM.w), y: clamp(focus - usable / 2, usable, art.ROOM.h), w: viewW, h: viewH };
  }
  // before "Walk in", the title screen drifts slowly over the village
  const focus = game.film?.focus || (game.started ? game.player : { x: art.WORLD.w / 2 + Math.sin(game.t * 0.04) * 220, y: art.WORLD.h / 2 + Math.sin(game.t * 0.066) * 90 });
  return { x: clamp(focus.x - viewW / 2, viewW, art.WORLD.w), y: clamp(focus.y - (viewH - panel) / 2, viewH, art.WORLD.h + panel), w: viewW, h: viewH };
}

// The camera is locked to its target while you walk (no swimming), and glides only when the
// target jumps: a conversation opening or closing, or the walk in from the title screen.
function camera() {
  const target = cameraTarget();
  const view = game.view;
  const key = `${game.scene}|${game.talking ? game.talking.id : ''}|${game.started}`;
  if (key !== view.key) {
    const cut = view.key === '' || key.split('|')[0] !== view.key.split('|')[0]; // through a door: no glide
    view.dx = cut ? 0 : view.x - target.x;
    view.dy = cut ? 0 : view.y - target.y;
    view.key = key;
  }
  view.x = target.x + view.dx;
  view.y = target.y + view.dy;
  // The scene is drawn at whole game pixels. While the camera moves on its own (the title
  // screen's drift, a glide), the part of a pixel left over is made up by sliding the canvas
  // itself, so slow movement is smooth instead of jumping a game pixel at a time.
  const sliding = !game.started || !!game.film?.focus || view.dx !== 0 || view.dy !== 0;
  const quake = game.quake > game.t ? Math.round(Math.sin(game.t * 60) * 2 * Math.min(1, (game.quake - game.t) / 0.5)) : 0; // a house just fell
  const x = (sliding ? Math.floor(view.x) : Math.round(view.x)) + quake;
  const y = (sliding ? Math.floor(view.y) : Math.round(view.y)) + (quake ? Math.round(Math.cos(game.t * 47)) : 0);
  return { x, y, w: target.w, h: target.h, fx: sliding ? view.x - x : 0, fy: sliding ? view.y - y : 0 };
}

function glide(dt) {
  const keep = Math.exp(-dt * 7);
  const view = game.view;
  view.dx = Math.abs(view.dx) < 0.5 ? 0 : view.dx * keep;
  view.dy = Math.abs(view.dy) < 0.5 ? 0 : view.dy * keep;
}

function label(x, y, content, options = {}) {
  game.labels.push({ x, y, content: String(content).replace(/f(?=[fil])/g, 'f‌'), ...options });
}

function walkFrame() {
  return Math.floor(game.t * 8) % 4;
}

function playerLook(dir = game.player.dir) {
  return { kind: 'player', look: game.player.look, color: '#22252b', accent: '#7fee64', dir, frame: walkFrame(), moving: game.player.moving, blink: game.t % 4.3 < 0.12, t: game.t };
}

function villagerLook(v, dir, moving) {
  const thinking = game.thinking.get(v.id) > game.t;
  return {
    kind: v.id,
    color: v.color,
    accent: v.accent,
    dir,
    frame: walkFrame(),
    moving,
    talking: v.speaking > game.t && Math.floor(game.t * 8) % 2 === 0,
    blink: (game.t + v.door.x * 0.01) % 3.7 < 0.12,
    bubble: v.working > game.t ? 'working' : thinking && v.speaking <= game.t ? 'dots' : null,
    t: game.t,
  };
}

function facing(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down';
}

// How dark it is: 0 through the day, rising to 1 at night.
function darkness() {
  const phase = (game.t / DAY_SECONDS + 0.12) % 1;
  const ramp = (a, b, x) => Math.max(0, Math.min(1, (x - a) / (b - a)));
  return ramp(0.52, 0.64, phase) * (1 - ramp(0.9, 0.99, phase));
}

function draw() {
  const cam = camera();
  game.labels.length = 0;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = game.scene === 'house' ? '#1d1830' : '#6cb85c'; // past the village's edge: more grass
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(1, 0, 0, 1, -cam.x, -cam.y);
  if (game.scene === 'house') drawHouseScene();
  else drawVillageScene(cam);
  const slide = cam.fx || cam.fy ? `translate(${(-cam.fx * game.scale).toFixed(2)}px, ${(-cam.fy * game.scale).toFixed(2)}px)` : '';
  if (canvas.style.transform !== slide) canvas.style.transform = slide;
  if (!game.started) game.labels.length = 0; // nothing written over the title screen
  drawLabels({ ...cam, x: cam.x + cam.fx, y: cam.y + cam.fy });
}

function isOutside(v) {
  return v.path || v.place !== 'home' || v.out > 0.03;
}

// Where a villager's thoughts arrive: above their head if they are out, else at their roof.
function headOf(v) {
  return isOutside(v) ? { x: v.pos.x, y: v.pos.y - 28 } : { x: v.door.x, y: art.houseTop(v) + 18 };
}

function drawVillageScene(cam) {
  ctx.drawImage(game.ground, 0, 0);
  art.drawWater(ctx, game.t);
  const dark = darkness();
  const lights = [];
  const busy = new Set(); // which brains somebody is thinking with right now
  for (const [id, until] of game.thinking) if (until > game.t && game.byId[id]) busy.add(beaconOf(game.byId[id]));

  const layers = [];
  for (const tree of game.trees) layers.push({ y: tree.y, draw: () => art.drawTree(ctx, tree) });
  for (const [key, at] of Object.entries(art.BEACONS)) {
    const tone = art.BEACON_TONES[key];
    layers.push({
      y: at.y,
      draw: () => {
        art.drawBeacon(ctx, at, tone, game.t, busy.has(key));
        // Modal's mark on the base: whose tower this is
        const mark = markSprite(9, 6);
        ctx.fillStyle = '#181818';
        ctx.fillRect(at.x - 6, at.y - 5, 13, 7);
        if (mark) ctx.drawImage(mark, at.x - Math.floor(mark.width / 2), at.y - 5 + Math.floor((7 - mark.height) / 2));
      },
    });
    lights.push({ x: at.x, y: at.y - 34, radius: 46, color: tone[2] }, { x: at.x, y: at.y - 34, radius: 20, color: tone[3] });
  }

  // The landmarks that stand for a piece of Modal.
  const P = art.PLACES;
  const awake = game.villagers.filter((v) => v.state.status === 'awake').length;
  const crystals = game.villagers.map((v) => ({ color: v.color, lit: !v.ephemeral && v.state.snapshots.length > 0, fresh: !v.ephemeral && v.sleptAt != null && game.t - v.sleptAt < 3 }));
  layers.push({ y: P.cellar.y, draw: () => scenery.drawCellar(ctx, P.cellar, crystals, game.t) });
  // Erik and Akshat, who started Modal, sitting up on the cellar's turf roof watching the
  // village. There to be seen, not spoken to.
  layers.push({
    y: P.cellar.y + 0.5,
    draw: () => {
      ROOFTOP.forEach(([dx, color, name, kind], index) => {
        const x = P.cellar.x + dx;
        const y = P.cellar.y - 30;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x - 10, y - 40, 20, 35); // seated: everything below the lap is out of sight
        ctx.clip();
        folk.drawFolk(ctx, x, y, { kind, color, accent: '#7fee64', dir: 'down', frame: 0, moving: false, blink: (game.t + index * 1.7) % 4.6 < 0.12, t: game.t });
        ctx.restore();
        // legs over the edge, swinging a little
        const swing = Math.floor(game.t * 1.5 + index) % 2;
        ctx.fillStyle = '#2a2238';
        ctx.fillRect(x - 5, y - 5, 4, 5 + swing);
        ctx.fillRect(x + 1, y - 5, 4, 6 - swing);
        if (dist(game.player, P.cellar) < 70) label(x, y - 33, name, { small: true });
      });
      scenery.drawShiba(ctx, P.cellar.x + 22, P.cellar.y - 35, game.t); // Akshat's dog came too
    },
  });
  layers.push({ y: P.bell.y, draw: () => scenery.drawBell(ctx, P.bell, game.t, game.bellUntil > game.t) });
  layers.push({ y: P.gpu.y, draw: () => scenery.drawGpuPatch(ctx, P.gpu, game.t, busy.size > 0) });
  layers.push({ y: P.yard.y, draw: () => scenery.drawYard(ctx, P.yard, markSprite(12, 9)) });
  layers.push({ y: P.gate.y, draw: () => scenery.drawGate(ctx, P.gate) });
  layers.push({ y: P.register.y, draw: () => scenery.drawRegister(ctx, P.register, game.t) });
  layers.push({ y: P.library.y, draw: () => scenery.drawLibrary(ctx, P.library, game.t, librarySpines(), markSprite(8, 6)) });
  layers.push({ y: P.flag.y, draw: () => scenery.drawFlag(ctx, P.flag, game.t, markSprite(16, 11)) });
  layers.push({ y: P.dock.y - 8, draw: () => scenery.drawDock(ctx, P.dock, game.t) });
  layers.push({
    y: ANGLER.y,
    draw: () => {
      // an easter egg: somebody with a green mohawk, fishing
      folk.drawFolk(ctx, ANGLER.x, ANGLER.y, { kind: 'angler', color: '#5b83c9', accent: '#7fee64', dir: 'left', frame: 0, moving: false, blink: (game.t + 1.3) % 4.1 < 0.12, t: game.t });
      const bob = Math.floor(game.t * 1.2) % 2;
      ctx.fillStyle = '#5b3a29';
      for (let i = 0; i < 12; i++) ctx.fillRect(ANGLER.x - 7 - i, ANGLER.y - 11 - Math.round(i * 0.9), 1, 1); // the rod
      ctx.fillStyle = '#fdfaf0';
      for (let i = 0; i < 12; i += 2) ctx.fillRect(ANGLER.x - 19, ANGLER.y - 20 + i, 1, 1); // the line
      ctx.fillStyle = '#e0483e';
      ctx.fillRect(ANGLER.x - 20, ANGLER.y - 7 + bob, 3, 2);
    },
  });
  label(P.gate.x, P.gate.y - 35, 'SANDBOX VILLAGE', { plate: true });
  label(P.gate.x, P.gate.y - 21, `${awake} of ${game.villagers.length} awake · scales to zero`, { small: true, mono: true, bg: '#7fee64' });
  for (const [key, up, text] of [['cellar', -9, 'saved houses (snapshots)'], ['bell', 51, 'bedtime bell (scale to zero)'], ['gpu', 41, 'GPUs: where thinking happens'], ['yard', 34, 'building kits (images)'], ['register', 36, 'the village register (a Dict)'], ['library', 56, 'the library (a Volume)']]) {
    if (game.xray || dist(game.player, P[key]) < 84) label(P[key].x, P[key].y - up, text, { small: true, mono: true, bg: '#d6ffc9' });
  }
  if (dark > 0.25) {
    lights.push({ x: P.gate.x - 19, y: P.gate.y - 46, radius: 22, color: '#ffd27a' }, { x: P.gate.x + 18, y: P.gate.y - 46, radius: 22, color: '#ffd27a' });
    lights.push({ x: P.cellar.x, y: P.cellar.y - 10, radius: 20, color: '#9fe2ff' });
  }
  for (const lamp of art.LAMPS) {
    layers.push({ y: lamp.y, draw: () => scenery.drawLamp(ctx, lamp, dark > 0.25) });
    if (dark > 0.25) lights.push({ x: lamp.x, y: lamp.y - 31, radius: 30, color: '#ffd27a' });
  }
  for (const prop of game.props) layers.push({ y: prop.y, draw: () => scenery.drawProp(ctx, prop, game.t) });

  art.PEDESTALS.forEach((at, slot) => {
    const piece = [...game.pieces.values()].find((other) => other.slot === slot);
    const sprite = piece?.image ? spriteFor(`piece:${piece.id}`, piece.image, 20, 22, true) : null;
    layers.push({ y: at.y, draw: () => art.drawPedestal(ctx, at.x, at.y, sprite) });
  });

  for (const v of game.villagers) {
    layers.push({
      y: v.door.y - 1,
      draw: () => {
        art.drawHouse(ctx, v, game.t);
        if (v.fx) {
          const age = game.t - v.fx.at;
          if (age > 1.2) v.fx = null;
          else if (v.fx.kind === 'wake') art.drawWakeFx(ctx, v, age);
          else art.drawSnapFx(ctx, v, age);
        }
      },
    });
    if (v.show !== 'rubble') layers.push({ y: v.mailbox.y, draw: () => art.drawMailbox(ctx, v.mailbox.x, v.mailbox.y, v.state.mail > 0, game.t) });
    if (v.plot) {
      layers.push({ y: v.plot.y + v.plot.h, draw: () => art.drawGarden(ctx, v.plot, gardenCrops(v), game.t) });
      if (game.xray || dist(game.player, { x: v.plot.x + v.plot.w / 2, y: v.plot.y + v.plot.h }) < 50) label(v.plot.x + v.plot.w / 2, v.plot.y + v.plot.h + 8, v.exhibit, { small: true, mono: true, bg: '#d6ffc9' });
    }

    if (v.show === 'awake') layers.push({ y: v.door.y - 1, draw: () => scenery.drawPennant(ctx, v.door.x + (PENNANT_AT[v.style]?.[0] ?? -30), art.houseTop(v) + (PENNANT_AT[v.style]?.[1] ?? 14), game.t + v.door.x) });

    const tall = folk.heightOf(v.id); // hats and ears
    if (isOutside(v)) {
      const still = !v.path && !v.walking;
      let dir = v.facing;
      if (still) {
        const partner = v.place !== 'home' ? game.byId[v.place] : game.villagers.find((other) => other.place === v.id && !other.path);
        if (game.talking === v || dist(game.player, v.pos) < 36) dir = facing(v.pos, game.player);
        else if (partner) dir = facing(v.pos, partner.pos);
        else dir = 'down';
      }
      layers.push({ y: v.pos.y, draw: () => folk.drawFolk(ctx, v.pos.x, v.pos.y, villagerLook(v, dir, !still)) });
      if (v.state.status === 'rubble' && still) layers.push({ y: v.pos.y + 1, draw: () => art.drawDaze(ctx, Math.round(v.pos.x), Math.round(v.pos.y) - tall + 4, game.t) });
      if (v.bubble && v.bubble.until > game.t) label(v.pos.x, v.pos.y - tall, v.bubble.text, { bubble: true });
      else if (still) label(v.pos.x, v.pos.y + 6, v.name, { small: true });
    }

    const top = art.houseTop(v);
    if (v.show === 'rubble') {
      // the picture says it fell; up close, the words say what is left of it on Modal
      if (dist(game.player, v.door) < NEAR_RADIUS && !game.xray) label(v.door.x, v.door.y - 60, v.state.snapshot_id ? 'no sandbox · its snapshot is safe' : 'no sandbox · nothing saved', { bg: '#c3cbdc', small: true, mono: true });
    } else label(v.door.x, art.plateY(v), v.name, { plate: true, small: v.style === 'tower' || v.style === 'ruin' });
    // What the sandbox is doing goes on the doorstep and under the villager, where it is in
    // view from the street: lifecycle on the step, the running command under their name.
    if (v.show === 'waking') label(v.door.x, v.door.y - 10, 'starting sandbox…', { bg: '#b9efc4' });
    if (v.command && v.command.until > game.t && v.show === 'awake' && game.xray) {
      const out = isOutside(v);
      label(out ? v.pos.x : v.door.x, (out ? v.pos.y : v.door.y) + (out ? 17 : 22), `${v.command.shell ? '$' : '>'} ${v.command.text}`, { bg: '#1c2130', fg: '#9be8a8', small: true, mono: true });
    }
    const close = dist(game.player, v.door) < NEAR_RADIUS;
    if (!game.xray && v.show !== 'waking' && v.show !== 'rubble' && close) {
      // close enough to care: what this house is, in Modal's words
      const up = v.show === 'awake';
      label(v.door.x, art.plateY(v) - 11, up ? 'Modal Sandbox · running' : v.ephemeral ? 'no sandbox · nothing saved' : 'no sandbox · saved as a snapshot', { bg: up ? '#7fee64' : '#c3cbdc', small: true, mono: true });
    } else if (v.show === 'awake' && v.bedAt != null && !close && (game.xray || v.bedAt - game.t < LAST_CALL_S)) {
      // nobody near, and the watchman is nearly here: the count, so you can see scale-to-zero coming
      const left = Math.ceil(v.bedAt - game.t);
      label(v.door.x, art.plateY(v) - (game.xray ? 22 : 11), left > 0 ? `sleeps in ${left} s` : 'going to sleep…', { bg: '#d6ffc9', small: true, mono: true });
    }
    if (game.xray && v.show !== 'waking') {
      const st = v.state;
      const runs = String(st.runtime || '').split(' ')[0];
      const tag =
        st.status === 'awake'
          ? `sandbox ${String(st.sandbox_id).slice(0, 14)}… ${runs}`
          : st.status === 'rubble'
            ? 'no sandbox (rubble)'
            : v.ephemeral
              ? 'no sandbox, no snapshot'
              : st.snapshot_id
                ? `snapshot ${String(st.snapshot_id).slice(0, 12)}…`
                : 'never started';
      label(v.door.x, art.plateY(v) - 11, tag, { bg: st.status === 'awake' ? '#7fee64' : st.status === 'rubble' ? '#f0a39a' : '#c3cbdc', small: true, mono: true });
    }

    if (v.show === 'awake' || v.show === 'waking') {
      if (v.style === 'ruin') lights.push({ x: v.door.x, y: v.door.y - 34, radius: 34, color: '#9fe2ff' });
      else lights.push({ x: v.door.x - 24, y: v.door.y - 28, radius: 26, color: '#ffd27a' }, { x: v.door.x + 24, y: v.door.y - 28, radius: 26, color: '#ffd27a' });
    }
  }

  for (const item of game.placed) layers.push({ y: item.y, draw: () => art.drawGift(ctx, item.x, item.y, itemSprite(item)) });
  if (!game.film?.solo) layers.push({ y: game.player.y, draw: () => folk.drawFolk(ctx, game.player.x, game.player.y, playerLook()) });
  layers.sort((a, b) => a.y - b.y);
  for (const layer of layers) layer.draw();
  drawGuide();
  drawTarget();
  drawMarker();

  for (const v of game.villagers) {
    if (v.playing > game.t) {
      const at = headOf(v);
      art.drawNotes(ctx, at.x, at.y + 28, game.t);
    }
  }
  if (dark < 0.6) scenery.drawButterflies(ctx, game.t);
  // a balloon that drifts across, a few minutes from one side to the other
  const span = art.WORLD.w + 300;
  scenery.drawBalloon(ctx, ((game.t * 5 + 420) % span) - 150, 92 + Math.sin(game.t * 0.11) * 24, game.t, markSprite(16, 11));
  art.drawWeather(ctx, cam, game.weather.kind, game.t);
  art.drawNight(ctx, cam, dark, lights, game.t);
  scenery.drawFireflies(ctx, game.t, dark);

  // Above everything, and above the dark: thoughts going to and from each villager's brain.
  for (const [id, until] of game.thinking) {
    const v = game.byId[id];
    if (until <= game.t) game.thinking.delete(id);
    else if (v) {
      const key = beaconOf(v);
      art.drawBeam(ctx, art.BEACONS[key], art.BEACON_TONES[key], headOf(v), game.t);
    }
  }
  game.receipts = game.receipts.filter((receipt) => game.t - receipt.at < 2.6);
  for (const receipt of game.receipts) {
    const at = headOf(receipt.v);
    label(at.x + 26, at.y + 4 - (game.t - receipt.at) * 7, receipt.text, { small: true, mono: true, bg: receipt.color });
  }
  for (const brain of game.brains) {
    const at = art.BEACONS[brain.key];
    if (!at) continue;
    label(at.x, at.y + 9, `Modal Model APIs · ${brain.label}`, { small: true, bg: brain.color, mono: true });
    if (game.xray) label(at.x, at.y + 19, `endpoint ${brain.endpoint}`, { small: true, bg: '#fdfaf0', mono: true });
  }
}

// Which beacon a villager's thoughts go to: their own brain's, or the first one if that
// endpoint is not set up (the server falls back the same way).
function beaconOf(v) {
  const brain = game.brains.find((other) => other.key === v.brain && other.available !== false);
  return art.BEACONS[brain?.key] ? brain.key : Object.keys(art.BEACONS)[0];
}

function drawHouseScene() {
  const { v, things, loading } = game.house;
  const nearest = game.action?.thing;
  const bare = !loading && !things.some((thing) => !thing.entry.name.startsWith('.'));
  const working = v.working > game.t;
  art.drawRoom(ctx, { ...v, working }, game.t, bare);
  if (!bare) rooms.drawDecor(ctx, v, game.t);
  rooms.drawDesk(ctx, { ...v, working }, game.t);
  if (bare) label(144, 70, 'The shelves are bare. Everything is gone.', { bg: '#f0a39a' });

  const layers = things.map((thing) => ({
    y: thing.y,
    draw: () => {
      let sprite = null;
      if (thing.kind === 'picture') sprite = spriteFor(pictureKey(v, thing.entry), game.images.get(pictureKey(v, thing.entry)), 12, 12, false);
      art.drawThing(ctx, thing.x, thing.y, thing.kind, { sprite, seed: thing.seed, highlight: thing === nearest, t: game.t });
      if (thing === nearest) label(thing.x, thing.y - 24, thing.entry.name + (thing.entry.type === 'dir' ? '/' : ''), { small: true });
    },
  }));
  if (v.tv) layers.push({ y: art.ROOM.tv.y, draw: () => (v.style === 'gpu' ? scenery.drawArcade : scenery.drawTv)(ctx, art.ROOM.tv, game.t, !!game.action?.tv) });
  const desk = art.ROOM.desk;
  if (v.place === 'home' && !v.path) {
    const dir = game.talking === v || dist(game.house, desk) < 44 ? facing(desk, game.house) : working ? 'up' : 'down';
    layers.push({ y: desk.y, draw: () => folk.drawFolk(ctx, desk.x, desk.y, villagerLook(v, dir, false)) });
    if (v.bubble && v.bubble.until > game.t) label(desk.x, desk.y - folk.heightOf(v.id) - 2, v.bubble.text, { bubble: true });
    else label(desk.x, desk.y + 6, v.name, { small: true });
  } else {
    label(desk.x, desk.y - 8, `${v.name} is out visiting`, { small: true });
  }
  layers.push({ y: game.house.y, draw: () => folk.drawFolk(ctx, game.house.x, game.house.y, playerLook()) });
  layers.sort((a, b) => a.y - b.y);
  for (const layer of layers) layer.draw();
  drawTarget();
  drawMarker();
}

// A small bobbing arrow over whatever E would act on.
// Where a tap is taking you: four small corners on the ground, closing in as you get there.
function drawTarget() {
  const at = game.target;
  if (!at || game.talking || game.film) return;
  const x = Math.round(at.x);
  const y = Math.round(at.y);
  const open = 3 + (Math.floor(game.t * 5) % 2);
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    ctx.fillStyle = '#2a2238';
    ctx.fillRect(x + sx * open - 1, y + sy * (open - 1) - 1, 3, 3);
    ctx.fillStyle = '#ffdf70';
    ctx.fillRect(x + sx * open, y + sy * (open - 1), 1, 1);
  }
}

function drawMarker() {
  const at = game.action?.at;
  if (!at || !game.action.run || game.talking || ui.reader.isOpen) return;
  const over = game.action.over;
  if (over?.bubble && over.bubble.until > game.t) return; // they are mid-sentence: the bubble is there
  const x = Math.round(at.x);
  const y = Math.round(at.y + Math.sin(game.t * 6) * 1.5);
  art.drawChevron(ctx, x, y);
}

function wrap(content, measure, maxWidth, maxLines) {
  const lines = [];
  let line = '';
  for (const word of content.replace(/\s+/g, ' ').trim().split(' ')) {
    const trial = line ? `${line} ${word}` : word;
    if (measure(trial) <= maxWidth || !line) line = trial;
    else {
      lines.push(line);
      line = word;
    }
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  else if (line && lines.length === maxLines) lines[maxLines - 1] = lines[maxLines - 1].replace(/.{0,3}$/, '…');
  return lines;
}

// Text is the one thing drawn at full screen resolution, in a pixel font, so it stays sharp at
// any scale. Boxes are still made of whole game pixels.
function drawLabels(cam) {
  const ratio = overlay.width / innerWidth;
  const unit = game.scale * ratio; // one game pixel, in overlay pixels
  text.setTransform(1, 0, 0, 1, 0, 0);
  text.clearRect(0, 0, overlay.width, overlay.height);
  text.textAlign = 'center';
  text.textBaseline = 'middle';
  const bubbles = game.labels.filter((item) => item.bubble);
  for (const item of [...game.labels.filter((item) => !item.bubble), ...bubbles]) {
    const size = Math.max(10 * ratio, Math.round(unit * (item.bubble ? 5.5 : item.small ? 4.5 : 5.5)));
    text.font = `${item.plate ? 700 : 400} ${size}px ${item.mono ? '"VT323", monospace' : FONT}`;
    if (item.bubble) {
      // nobody in view to be saying it: the feed still carries the line
      const sx = item.x - cam.x;
      const sy = item.y - cam.y;
      if (sx < -10 || sx > cam.w + 10 || sy < 6 || sy > cam.h + 30) continue;
    }
    const lines = item.bubble ? wrap(item.content, (value) => text.measureText(value).width, unit * 122, 6) : [item.content];
    const widest = Math.max(...lines.map((line) => text.measureText(line).width));
    const lineHeight = size * 1.12;
    const width = Math.ceil((widest + unit * (item.bubble ? 6 : 4)) / unit) * unit;
    const height = Math.ceil((lineHeight * lines.length + unit * (item.bubble ? 4 : 2.2)) / unit) * unit;
    let x = Math.round((item.x - cam.x) * unit - width / 2);
    let y = Math.round((item.y - cam.y) * unit - (item.bubble ? height : height / 2));
    if (item.bubble) {
      x = Math.max(unit * 2, Math.min(overlay.width - width - unit * 2, x));
      y = Math.max(unit * 14, y);
    }
    text.fillStyle = '#2a2238';
    text.fillRect(x + unit, y, width - unit * 2, height);
    text.fillRect(x, y + unit, width, height - unit * 2);
    text.fillStyle = item.bg || (item.plate ? '#e0b67e' : '#fdfaf0');
    text.fillRect(x + unit, y + unit, width - unit * 2, height - unit * 2);
    if (item.bubble) {
      // the little tail that points at whoever is speaking
      const tx = Math.round(Math.max(x + unit * 3, Math.min(x + width - unit * 6, (item.x - cam.x) * unit - unit)));
      text.fillStyle = '#2a2238';
      text.fillRect(tx - unit, y + height - unit, unit * 5, unit * 2);
      text.fillRect(tx, y + height + unit, unit * 3, unit);
      text.fillStyle = '#fdfaf0';
      text.fillRect(tx, y + height - unit, unit * 3, unit * 2);
      text.fillRect(tx + unit, y + height + unit, unit, unit);
    }
    text.fillStyle = item.fg || '#2a2238';
    lines.forEach((line, index) => text.fillText(line, x + width / 2, y + height / 2 + (index - (lines.length - 1) / 2) * lineHeight + size * 0.04));
  }
}

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(frame);
}

boot();
