// 16-bit style pixel art, drawn in code. Everything here paints onto a low-resolution canvas
// with whole-pixel rectangles (no curves, no anti-aliasing); the browser then scales that canvas
// up with hard edges. One unit everywhere in this file is one of those chunky pixels.

export const WORLD = { w: 980, h: 570 };
export const STREETS = [216, 312, 496]; // top street, the lane across the middle, bottom street (y)
export const AVENUES = [250, 490, 730]; // the north-south avenues (x)
export const STREET_X = [70, 910];
export const LANE_X = [196, 884]; // from the dock on the pond to the ruin
export const BACK_ROAD = 552; // the road along the bottom, past the welcome board and the image yard
export const GREENS = [{ x: 370, y: 312, r: 27 }, { x: 610, y: 312, r: 27 }]; // one little green per beacon
// The models (on Modal's Model APIs), as landmarks: one beacon per brain.
export const BEACONS = { glm: { x: 370, y: 306 }, deepseek: { x: 610, y: 306 } };
export const BEACON_TONES = {
  glm: ['#09af58', '#62de61', '#7fee64', '#d6ffc9'],
  deepseek: ['#1f5fa8', '#4f9be0', '#6fc3ff', '#d9f0ff'],
};
export const POND = { x: 125, y: 308, rx: 58, ry: 25 };
export const SPAWN = { x: 370, y: 346 };
// Where the tinkerer's installed pieces stand, along the lane.
export const PEDESTALS = [[300, 297], [540, 297], [680, 297], [790, 297], [300, 334], [440, 334], [540, 334], [680, 334]].map(([x, y]) => ({ x, y }));
// Landmarks that stand for a piece of Modal. Each has a short path to the nearest road.
export const PLACES = {
  cellar: { x: 250, y: 198 }, // where snapshots are kept
  bell: { x: 490, y: 200 }, // the watchman who puts idle villagers to bed
  gpu: { x: 730, y: 200 }, // what the beacons' models run on
  yard: { x: 650, y: 541 }, // container images
  gate: { x: 540, y: 535 }, // the welcome board beside the road into the village
  register: { x: 592, y: 541 }, // the book where the village's state is written (a Modal Dict)
  flag: { x: 446, y: 535 },
  dock: { x: 176, y: 311 }, // where Charles fishes
  library: { x: 440, y: 292 }, // the one shelf every house shares (a Modal Volume)
};
export const LAMPS = [[310, 232], [550, 232], [800, 232], [190, 482], [430, 482], [670, 482], [790, 482], [212, 298]].map(([x, y]) => ({ x, y }));
export const ROOM = {
  w: 288,
  h: 192,
  left: 22,
  right: 266,
  top: 58,
  bottom: 176,
  door: { x: 144, y: 176 },
  desk: { x: 242, y: 118 }, // where the villager stands indoors
  blocks: [[96, 86, 80, 24], [220, 80, 44, 24], [20, 158, 26, 18], [246, 158, 22, 18]], // table, desk, and the two corners where things stand
  tv: { x: 253, y: 172, reach: { x: 230, y: 170 } }, // the screen, in the houses that have one: in the corner, played from its left
};

const HALF_ROAD = 10;
const MODAL_GREEN = '#7fee64';

const C = {
  ink: '#2a2238',
  shade: 'rgba(26, 20, 44, .30)',
  grass: ['#4c9446', '#5aa650', '#6cb85c', '#7cc76a', '#93d67e'],
  path: ['#b8975e', '#d9bf88', '#ead7a8'],
  sand: ['#cbb277', '#e7d49c'],
  water: ['#2f6fb0', '#3f8fd0', '#62b0e8', '#b4e2f8'],
  wood: ['#5b3a29', '#84563a', '#a8754b', '#c99862', '#e0b67e'],
  wall: ['#cbb691', '#eedfbb', '#fbf2d8'],
  stone: ['#77748a', '#a3a0ae', '#cdcad3'],
  steel: ['#5d6878', '#8793a4', '#b9c3cf', '#e2e8ee'],
  leaf: ['#2c6a41', '#3d8a4b', '#57a857', '#7fc86b'],
  leafBlue: ['#28645a', '#35857a', '#4ea48c', '#78c7a0'],
  skin: ['#dba57c', '#f8dcb6'],
  brick: ['#8f4f3d', '#b56a50', '#cf8a6a'],
  glow: '#ffdf70',
  glowHi: '#fff7c8',
  night: ['#2e3857', '#46557e'],
  white: '#fdfaf0',
  floor: ['#a8794a', '#c99a61', '#d6aa72'],
  gold: '#e8b33a',
  modal: ['#09af58', '#62de61', MODAL_GREEN, '#d6ffc9'],
};

// ---- pixel primitives -----------------------------------------------------------------------

function makeCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function R(c, x, y, w, h, color) {
  c.fillStyle = color;
  c.fillRect(Math.round(x), Math.round(y), w, h);
}

// A filled ellipse made of one-pixel-high rows: hard edges, no anti-aliasing.
function E(c, cx, cy, rx, ry, color) {
  c.fillStyle = color;
  cx = Math.round(cx);
  cy = Math.round(cy);
  for (let dy = -ry; dy <= ry; dy++) {
    const half = Math.floor(rx * Math.sqrt(Math.max(0, 1 - (dy * dy) / ((ry + 0.5) * (ry + 0.5)))) + 0.5);
    c.fillRect(cx - half, cy + dy, half * 2 + 1, 1);
  }
}

function EO(c, cx, cy, rx, ry, fill, outline = C.ink) {
  E(c, cx, cy, rx + 1, ry + 1, outline);
  E(c, cx, cy, rx, ry, fill);
}

// A box with a one-pixel outline and the four corner pixels knocked off.
function box(c, x, y, w, h, fill, outline = C.ink) {
  R(c, x + 1, y, w - 2, h, outline);
  R(c, x, y + 1, w, h - 2, outline);
  R(c, x + 1, y + 1, w - 2, h - 2, fill);
}

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(hex, other, t) {
  const a = rgb(hex);
  const b = rgb(other);
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

// [shadow, base, highlight] for any colour the server hands us.
export function ramp(hex) {
  return [mix(hex, C.ink, 0.38), hex, mix(hex, '#fff6d8', 0.32)];
}

function hash(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function noise(x, y, cell) {
  const gx = Math.floor(x / cell);
  const gy = Math.floor(y / cell);
  const fx = x / cell - gx;
  const fy = y / cell - gy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(gx, gy);
  const b = hash(gx + 1, gy);
  const c2 = hash(gx, gy + 1);
  const d = hash(gx + 1, gy + 1);
  return a + (b - a) * sx + (c2 - a) * sy + (a - b - c2 + d) * sx * sy;
}

export function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- the map --------------------------------------------------------------------------------

// Which street a front door opens onto.
export function streetOf(door) {
  if (door.y > 250 && door.y < STREETS[1]) return STREETS[1];
  return door.y < 300 ? STREETS[0] : STREETS[2];
}

const HALF_WIDTH = { tower: 30, mushroom: 34, ruin: 26, gpu: 46, garage: 48 };
const WALL_HEIGHT = { ruin: 30, caravan: 44, gpu: 60, garage: 42 };

// The part of a house you cannot walk through.
export function houseBox(v) {
  const half = HALF_WIDTH[v.style] || 42;
  const tall = WALL_HEIGHT[v.style] || 50;
  return { x: v.door.x - half, y: v.door.y - tall, w: half * 2, h: tall + 2 };
}

// How far above the door the name plate hangs, per kind of building.
export function plateY(v) {
  return v.door.y - ({ tower: 30, lab: 62, mushroom: 36, caravan: 46, ruin: 50, gpu: 66, garage: 46 }[v.style] || 39);
}

// The gardener's plot, beside her house.
export function plotOf(v) {
  return { x: v.door.x + 62, y: v.door.y - 24, w: 46, h: 26 };
}

function lanes(villagers) {
  const out = [
    [STREET_X[0], STREETS[0], STREET_X[1], STREETS[0]],
    [STREET_X[0], STREETS[2], STREET_X[1], STREETS[2]],
    [LANE_X[0], STREETS[1], LANE_X[1], STREETS[1]],
  ];
  for (const x of AVENUES) out.push([x, STREETS[0], x, STREETS[2]]);
  for (const key of ['cellar', 'bell', 'gpu']) out.push([PLACES[key].x, PLACES[key].y + 2, PLACES[key].x, STREETS[0]]);
  for (const x of [AVENUES[0], AVENUES[2]]) out.push([x, STREETS[2], x, BACK_ROAD]);
  out.push([AVENUES[0], BACK_ROAD, AVENUES[2], BACK_ROAD]);
  out.push([AVENUES[1], STREETS[2], AVENUES[1], WORLD.h + 12]); // the road in
  for (const v of villagers) out.push([v.door.x, v.door.y + 3, v.door.x, streetOf(v.door)]);
  return out;
}

function segmentDistance(x, y, [x1, y1, x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - x1 - dx * t, y - y1 - dy * t);
}

// How far a point is from the nearest bit of road (used for the ground and to keep trees off it).
export function roadDistance(x, y, villagers) {
  let best = Infinity;
  for (const green of GREENS) best = Math.min(best, Math.hypot(x - green.x, y - green.y) - (green.r - HALF_ROAD));
  for (const lane of lanes(villagers)) best = Math.min(best, segmentDistance(x, y, lane));
  return best;
}

// The ground is decided pixel by pixel (grass, road, sand or water) and painted once.
export function makeGround(villagers) {
  const { w, h } = WORLD;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(w, h);
  const kind = new Uint8Array(w * h); // 0 grass, 1 road, 2 sand, 3 water
  const roads = lanes(villagers);
  const colors = {};
  const put = (index, hex) => {
    const value = colors[hex] || (colors[hex] = rgb(hex));
    image.data[index * 4] = value[0];
    image.data[index * 4 + 1] = value[1];
    image.data[index * 4 + 2] = value[2];
    image.data[index * 4 + 3] = 255;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const index = y * w + x;
      const jitter = hash(x >> 1, y >> 1) - 0.5;
      const pond = ((x - POND.x) / POND.rx) ** 2 + ((y - POND.y) / POND.ry) ** 2 + jitter * 0.07;
      let road = Infinity;
      for (const green of GREENS) road = Math.min(road, Math.hypot(x - green.x, y - green.y) - (green.r - HALF_ROAD));
      for (const lane of roads) road = Math.min(road, segmentDistance(x, y, lane));
      road += jitter * 1.8;
      const speck = hash(x, y);
      if (pond < 1) {
        kind[index] = 3;
        put(index, pond > 0.9 ? C.water[2] : pond < 0.42 ? C.water[0] : hash(x >> 2, y) < 0.05 ? C.water[2] : C.water[1]);
      } else if (pond < 1.26) {
        kind[index] = 2;
        put(index, pond > 1.18 ? C.sand[0] : speck < 0.06 ? C.sand[0] : C.sand[1]);
      } else if (road < HALF_ROAD) {
        kind[index] = 1;
        put(index, road > HALF_ROAD - 1.6 ? C.path[0] : speck < 0.05 ? C.path[2] : speck < 0.1 ? C.path[0] : C.path[1]);
      } else {
        const patch = noise(x, y, 30) * 0.65 + noise(x + 99, y + 57, 12) * 0.35;
        let color = patch > 0.6 ? C.grass[3] : patch < 0.4 ? C.grass[1] : C.grass[2];
        if (road < HALF_ROAD + 1.4) color = C.grass[0];
        else if (speck < 0.02) color = C.grass[4];
        else if (speck > 0.985) color = C.grass[0];
        put(index, color);
      }
    }
  }
  ctx.putImageData(image, 0, 0);

  // Paving on each green: a ring of lighter stones around where a beacon stands.
  for (const green of GREENS) {
    for (let i = 0; i < 28; i++) {
      const angle = (i / 28) * Math.PI * 2;
      const x = Math.round(green.x + Math.cos(angle) * (green.r - 6));
      const y = Math.round(green.y + Math.sin(angle) * (green.r - 6) * 0.72);
      R(ctx, x - 1, y, 3, 2, i % 2 ? C.path[2] : C.stone[2]);
      R(ctx, x - 1, y + 2, 3, 1, C.path[0]);
    }
  }

  // Tufts, flowers and pebbles, scattered the same way on every visit.
  const rand = seeded(11);
  const at = (x, y) => (x < 2 || y < 2 || x >= w - 2 || y >= h - 2 ? -1 : kind[y * w + x]);
  for (let i = 0; i < 980; i++) {
    const x = Math.floor(rand() * w);
    const y = Math.floor(rand() * h);
    const pick = rand();
    if (at(x, y) === 0 && at(x + 2, y) === 0 && at(x - 2, y) === 0) {
      if (pick < 0.62) {
        R(ctx, x - 1, y - 1, 1, 2, C.grass[0]);
        R(ctx, x + 1, y - 1, 1, 2, C.grass[0]);
        R(ctx, x, y, 1, 1, C.grass[0]);
        R(ctx, x, y - 2, 1, 1, C.grass[4]);
      } else if (pick < 0.9) {
        const petal = ['#fff6e0', '#ffc2d4', '#ffe27a', '#d6c2ff'][Math.floor(rand() * 4)];
        R(ctx, x, y + 1, 1, 2, C.leaf[1]);
        R(ctx, x - 1, y, 3, 1, petal);
        R(ctx, x, y - 1, 1, 3, petal);
        R(ctx, x, y, 1, 1, '#e8912d');
      } else {
        R(ctx, x - 1, y, 3, 2, C.stone[1]);
        R(ctx, x - 1, y, 2, 1, C.stone[2]);
        R(ctx, x - 1, y + 2, 3, 1, C.grass[0]);
      }
    } else if (at(x, y) === 1 && pick < 0.3) {
      R(ctx, x, y, 2, 1, C.path[2]);
      R(ctx, x, y + 1, 2, 1, C.path[0]);
    }
  }

  // Reeds on the shore and lily pads on the water.
  for (const [dx, dy] of [[-52, -10], [-55, 4], [53, -7], [48, 12], [-34, 20], [20, 23]]) {
    const x = POND.x + dx;
    const y = POND.y + dy;
    for (const [ox, height] of [[0, 9], [2, 7], [-2, 6]]) {
      R(ctx, x + ox, y - height, 1, height, C.leaf[0]);
      R(ctx, x + ox, y - height - 2, 1, 3, C.wood[1]);
    }
  }
  for (const [dx, dy] of [[24, 5], [-28, 7], [8, -10], [-10, 12]]) {
    E(ctx, POND.x + dx, POND.y + dy, 4, 2, C.leaf[0]);
    E(ctx, POND.x + dx, POND.y + dy - 1, 3, 1, C.leaf[2]);
    R(ctx, POND.x + dx + 2, POND.y + dy - 1, 2, 1, C.water[1]);
  }
  return canvas;
}

export function drawWater(c, t) {
  const beat = Math.floor(t * 2.5);
  for (let i = 0; i < 9; i++) {
    if ((beat + i * 3) % 5 > 1) continue;
    const x = POND.x - 40 + ((i * 29) % 80) + ((beat + i) % 3);
    const y = POND.y - 15 + ((i * 13) % 30);
    if (((x - POND.x) / (POND.rx - 8)) ** 2 + ((y - POND.y) / (POND.ry - 5)) ** 2 < 1) R(c, x, y, 4 + (i % 2) * 2, 1, C.water[3]);
  }
  // the duck
  const dx = POND.x + 14 + Math.round(Math.sin(t * 0.25) * 16);
  const dy = POND.y - 4 + Math.round(Math.cos(t * 0.19) * 5);
  const flip = Math.cos(t * 0.25) > 0 ? 1 : -1;
  R(c, dx - 3, dy + 2, 7, 1, C.water[3]);
  box(c, dx - 3, dy - 2, 7, 5, C.white);
  box(c, dx + (flip > 0 ? 1 : -3), dy - 5, 5, 5, C.white);
  R(c, dx + (flip > 0 ? 5 : -5), dy - 3, 2, 1, '#e8912d');
  R(c, dx + (flip > 0 ? 3 : -2), dy - 4, 1, 1, C.ink);
}

// ---- trees ----------------------------------------------------------------------------------

const treeSprites = new Map();

function treeSprite(variant) {
  if (treeSprites.has(variant)) return treeSprites.get(variant);
  const canvas = makeCanvas(40, 48);
  const c = canvas.getContext('2d');
  const leaf = variant % 2 ? C.leafBlue : C.leaf;
  const big = variant < 2;
  const cx = 20;
  const top = big ? 17 : 21;
  E(c, cx, 44, big ? 12 : 10, 3, C.shade);
  box(c, cx - 3, 31, 7, 14, C.wood[1]);
  R(c, cx - 2, 32, 2, 12, C.wood[2]);
  R(c, cx - 5, 43, 3, 2, C.ink);
  R(c, cx + 3, 43, 3, 2, C.ink);
  R(c, cx - 4, 43, 2, 1, C.wood[1]);
  R(c, cx + 3, 43, 2, 1, C.wood[1]);
  const blobs = big ? [[cx, top, 14, 12], [cx - 9, top + 9, 9, 8], [cx + 9, top + 9, 9, 8]] : [[cx, top, 11, 10], [cx - 7, top + 8, 7, 6], [cx + 7, top + 8, 7, 6]];
  for (const [x, y, rx, ry] of blobs) E(c, x, y, rx + 1, ry + 1, C.ink);
  for (const [x, y, rx, ry] of blobs) E(c, x, y, rx, ry, leaf[1]);
  E(c, cx + 6, top + 11, big ? 8 : 6, big ? 5 : 4, leaf[0]);
  E(c, cx - 4, top - 3, big ? 8 : 6, big ? 6 : 5, leaf[2]);
  E(c, cx - 10, top + 6, big ? 4 : 3, 3, leaf[2]);
  const rand = seeded(variant + 5);
  for (let i = 0; i < 26; i++) {
    const x = cx - 13 + Math.floor(rand() * 27);
    const y = top - 10 + Math.floor(rand() * 26);
    const pixel = c.getImageData(x, y, 1, 1).data;
    if (pixel[3] < 255 || (pixel[0] === 42 && pixel[1] === 34)) continue; // off the canopy, or on the outline
    R(c, x, y, 2, 1, y < top + 2 ? leaf[3] : leaf[0]);
  }
  treeSprites.set(variant, canvas);
  return canvas;
}

// Room kept clear of trees around each landmark: [place, left, right, above, below].
const CLEARINGS = [
  ['cellar', 44, 70, 70, 20],
  ['bell', 34, 34, 76, 20],
  ['gpu', 50, 50, 64, 20],
  ['yard', 48, 52, 36, 14],
  ['gate', 44, 44, 44, 14],
  ['register', 14, 14, 30, 14],
  ['flag', 14, 40, 44, 14],
  ['dock', 40, 40, 30, 30],
  ['library', 30, 30, 56, 16],
];

export function makeTrees(villagers) {
  const rand = seeded(42);
  const trees = [];
  const blocked = (x, y) => {
    if (x < 14 || y < 44 || x > WORLD.w - 14 || y > WORLD.h - 4) return true;
    if (roadDistance(x, y, villagers) < 26) return true;
    if (GREENS.some((green) => Math.hypot(x - green.x, y - green.y) < 70)) return true;
    if (PEDESTALS.some((spot) => Math.hypot(x - spot.x, y - spot.y) < 26)) return true;
    if (LAMPS.some((spot) => Math.hypot(x - spot.x, y - spot.y) < 20)) return true;
    for (const [key, left, right, above, below] of CLEARINGS) {
      const at = PLACES[key];
      if (x > at.x - left && x < at.x + right && y > at.y - above && y < at.y + below) return true;
    }
    if (((x - POND.x) / (POND.rx + 24)) ** 2 + ((y - POND.y) / (POND.ry + 26)) ** 2 < 1) return true;
    for (const v of villagers) {
      const reach = v.style === 'mushroom' ? 124 : 68; // leave room for the garden plot
      if (x > v.door.x - 68 && x < v.door.x + reach && y > v.door.y - 132 && y < v.door.y + 40) return true;
    }
    return trees.some((tree) => (tree.x - x) ** 2 + ((tree.y - y) * 1.3) ** 2 < 27 ** 2);
  };
  for (let i = 0; i < 3600 && trees.length < 72; i++) {
    const edge = rand() < 0.5;
    const x = Math.round(edge ? (rand() < 0.5 ? 14 + rand() * 56 : WORLD.w - 70 + rand() * 56) : rand() * WORLD.w);
    const y = Math.round(44 + rand() * (WORLD.h - 48));
    if (!blocked(x, y)) trees.push({ x, y, variant: Math.floor(rand() * 4) });
  }
  return trees;
}

export function drawTree(c, tree) {
  c.drawImage(treeSprite(tree.variant), tree.x - 20, tree.y - 45);
}

// ---- houses ---------------------------------------------------------------------------------
// Each house is drawn once into its own little canvas (124 x 150, door step at 62,140) for the
// lights-on and lights-off states. Smoke, flags and blinking lights are drawn live on top.

const MID = 62;
const GROUND = 140;
const houseSprites = new Map();

function squareWindow(c, x, y, lit, size = 15) {
  R(c, x - 1, y - 1, size + 2, size + 2, C.ink);
  R(c, x, y, size, size, C.wood[2]);
  R(c, x + 1, y + 1, size - 2, size - 2, lit ? C.glow : C.night[0]);
  if (lit) {
    R(c, x + 1, y + 1, Math.floor(size / 2) - 1, Math.floor(size / 2) - 2, C.glowHi);
    R(c, x + Math.floor(size / 2) + 1, y + Math.floor(size / 2) + 1, Math.floor(size / 2) - 2, Math.floor(size / 2) - 2, '#f6c552');
  } else {
    R(c, x + 2, y + 3, 1, 1, C.night[1]);
    R(c, x + 3, y + 2, 1, 1, C.night[1]);
  }
  R(c, x + Math.floor(size / 2), y + 1, 1, size - 2, C.wood[1]);
  R(c, x + 1, y + Math.floor(size / 2), size - 2, 1, C.wood[1]);
}

function sill(c, x, y, w, flowers = true) {
  R(c, x - 2, y, w + 4, 3, C.ink);
  R(c, x - 1, y, w + 2, 2, C.wood[3]);
  if (flowers) {
    for (let i = 0; i < 4; i++) {
      R(c, x + 1 + i * 4, y - 2, 2, 2, ['#e0607a', '#ffe27a', '#e0607a', '#ffc2d4'][i]);
      R(c, x + 1 + i * 4, y - 1, 1, 1, C.leaf[2]);
    }
  }
}

function roundWindow(c, cx, cy, r, lit, rim = C.wood[2], glow = C.glow) {
  E(c, cx, cy, r + 2, r + 2, C.ink);
  E(c, cx, cy, r + 1, r + 1, rim);
  E(c, cx, cy, r, r, lit ? glow : C.night[0]);
  if (lit) R(c, cx - r + 1, cy - r + 1, Math.max(2, r - 1), Math.max(2, r - 2), C.glowHi);
  else R(c, cx - 1, cy - 2, 1, 1, C.night[1]);
}

// A door with a rounded top. When the villager is awake it stands open, swung to the left.
function door(c, x, w, h, lit, tone = C.wood) {
  const top = GROUND - h;
  R(c, x + 1, top, w - 2, h + 1, C.ink);
  R(c, x, top + 2, w, h - 1, C.ink);
  if (lit) {
    R(c, x + 2, top + 1, w - 4, h - 1, '#1d1830');
    R(c, x + 1, top + 3, w - 2, h - 3, '#1d1830');
    R(c, x + 3, GROUND - 8, w - 6, 8, '#4a3a2a');
    R(c, x - 8, top + 3, 9, h - 2, C.ink);
    R(c, x - 7, top + 4, 7, h - 4, tone[2]);
    R(c, x - 5, top + 4, 1, h - 4, tone[1]);
    R(c, x - 6, top + Math.floor(h / 2), 1, 2, C.glow);
  } else {
    R(c, x + 2, top + 1, w - 4, h - 1, tone[2]);
    R(c, x + 1, top + 3, w - 2, h - 3, tone[2]);
    R(c, x + 2, top + 1, w - 4, 1, tone[3] || tone[2]);
    for (let dx = 5; dx < w - 2; dx += 5) R(c, x + dx, top + 2, 1, h - 2, tone[1]);
    R(c, x + w - 5, top + Math.floor(h / 2), 2, 2, C.glow);
  }
  R(c, x - 3, GROUND, w + 6, 4, C.ink);
  R(c, x - 2, GROUND, w + 4, 3, C.stone[2]);
  R(c, x - 2, GROUND + 2, w + 4, 1, C.stone[1]);
}

// Rows of shingles, widening from `halfTop` to `halfBottom`.
function shingles(c, top, rows, halfTop, halfBottom, tone) {
  for (let row = 0; row < rows; row++) {
    const half = halfTop + Math.round((row * (halfBottom - halfTop)) / (rows - 1));
    const y = top + row;
    R(c, MID - half - 1, y, half * 2 + 3, 1, C.ink);
    const band = row % 8;
    R(c, MID - half, y, half * 2 + 1, 1, band === 0 ? tone[0] : band === 1 ? tone[2] : tone[1]);
    if (band > 1) {
      const offset = Math.floor(row / 8) % 2 ? 4 : 0;
      for (let x = MID - half + ((offset + (half % 8) + 8) % 8); x <= MID + half; x += 8) R(c, x, y, 1, 1, tone[0]);
    }
  }
  R(c, MID - halfTop - 1, top - 1, halfTop * 2 + 3, 1, C.ink);
  R(c, MID - halfBottom - 2, top + rows, halfBottom * 2 + 5, 2, C.ink);
  R(c, MID - halfBottom - 1, top + rows, halfBottom * 2 + 3, 1, tone[0]);
}

function plasterWalls(c, x, y, w, h, tone = C.wall, timber = true) {
  R(c, x - 1, y - 1, w + 2, h + 2, C.ink);
  R(c, x, y, w, h, tone[1]);
  for (let yy = y + 8; yy < y + h - 8; yy += 7) R(c, x, yy, w, 1, tone[0]);
  R(c, x, y, w, 4, tone[0]);
  R(c, x, y + h - 7, w, 7, C.stone[1]);
  R(c, x, y + h - 7, w, 1, C.stone[2]);
  for (let xx = x + 7; xx < x + w; xx += 10) R(c, xx, y + h - 6, 1, 6, C.stone[0]);
  if (timber) {
    for (const xx of [x, x + w - 4]) {
      R(c, xx, y, 4, h - 7, C.wood[1]);
      R(c, xx, y, 1, h - 7, C.wood[2]);
    }
  }
}

function brickChimney(c, x, y, h = 24) {
  R(c, x, y, 14, h, C.ink);
  R(c, x + 1, y + 1, 12, h - 2, C.brick[1]);
  R(c, x + 1, y + 1, 3, h - 2, C.brick[2]);
  for (let yy = y + 5; yy < y + h - 2; yy += 4) R(c, x + 1, yy, 12, 1, C.brick[0]);
  R(c, x - 1, y - 1, 16, 3, C.ink);
  R(c, x, y, 14, 1, C.stone[2]);
}

const BUILD = {
  // Mo: a graphics card stood on its edge. Two fans, heat pipes, gold fingers, a green light.
  gpu(c, v, lit) {
    const SHROUD = ['#16181d', '#23262d', '#343842', '#4a505c'];
    // the slot bracket down the left side, with its ports
    R(c, 11, 78, 8, 62, C.ink);
    R(c, 12, 79, 6, 60, C.steel[2]);
    R(c, 12, 79, 2, 60, C.steel[3]);
    for (const y of [90, 101, 112]) {
      R(c, 14, y, 3, 7, C.ink);
      R(c, 15, y + 1, 1, 5, C.night[1]);
    }
    // heat pipes and a fin stack above the shroud
    for (const x of [28, 36, 44]) {
      R(c, x, 68, 6, 14, C.ink);
      R(c, x + 1, 69, 4, 13, '#c98a4b');
      R(c, x + 1, 69, 1, 13, '#f0c08a');
    }
    R(c, 27, 66, 24, 4, C.ink);
    R(c, 28, 67, 22, 2, '#e0a868');
    R(c, 64, 70, 38, 12, C.ink);
    for (let i = 0; i < 12; i++) R(c, 65 + i * 3, 71, 2, 11, i % 2 ? C.steel[2] : C.steel[3]);
    // the shroud
    R(c, 18, 80, 90, 56, C.ink);
    R(c, 19, 81, 88, 54, SHROUD[1]);
    R(c, 19, 81, 88, 2, SHROUD[3]);
    R(c, 19, 129, 88, 6, SHROUD[0]);
    R(c, 104, 83, 3, 50, SHROUD[0]);
    for (const [x, y] of [[21, 83], [103, 83], [21, 131], [103, 131]]) R(c, x, y, 2, 2, C.steel[1]); // screws
    // the light strip: Modal green when the house is up
    R(c, 23, 86, 80, 3, C.ink);
    R(c, 24, 87, 78, 1, lit ? '#7fee64' : '#2d4327');
    if (lit) for (let x = 26; x < 100; x += 9) R(c, x, 87, 3, 1, '#d6ffc9');
    // two fans (the blades are drawn live, so they can spin)
    for (const fx of [36, 88]) {
      E(c, fx, 110, 16, 16, C.ink);
      E(c, fx, 110, 15, 15, SHROUD[2]);
      E(c, fx, 110, 13, 13, SHROUD[0]);
      E(c, fx, 110, 4, 4, C.ink);
      E(c, fx, 110, 3, 3, lit ? '#7fee64' : SHROUD[3]);
    }
    door(c, 54, 16, 24, lit, [SHROUD[0], SHROUD[2], SHROUD[3], C.steel[1]]);
    // gold fingers: the edge connector, for a doorstep
    R(c, 24, 135, 28, 6, C.ink);
    R(c, 72, 135, 30, 6, C.ink);
    for (let x = 25; x < 51; x += 4) R(c, x, 136, 3, 4, C.gold);
    for (let x = 73; x < 101; x += 4) R(c, x, 136, 3, 4, C.gold);
  },

  // Ziggy: a garage with its roll-up door half open, bunting, a dish and a whiteboard outside.
  garage(c, v, lit) {
    const trim = ramp(v.accent);
    plasterWalls(c, 16, 98, 92, 42, C.wall, false);
    // a low roof slab with a gutter
    R(c, 11, 87, 102, 13, C.ink);
    R(c, 12, 88, 100, 11, '#6f7684');
    R(c, 12, 88, 100, 3, '#8f97a6');
    R(c, 12, 96, 100, 3, '#525866');
    // a dish and a small aerial: very connected
    R(c, 86, 74, 2, 14, C.ink);
    for (let row = 0; row < 7; row++) {
      R(c, 87 - (2 + row) - 1, 68 + row, (2 + row) * 2 + 3, 1, C.ink);
      R(c, 87 - (2 + row), 68 + row, (2 + row) * 2 + 1, 1, row < 2 ? C.steel[3] : C.steel[2]);
    }
    R(c, 100, 72, 1, 16, C.ink);
    R(c, 99, 71, 3, 2, trim[1]);
    // the roll-up door
    R(c, 19, 105, 32, 36, C.ink);
    if (lit) {
      R(c, 20, 106, 30, 34, '#ffe9a6');
      R(c, 20, 106, 30, 12, C.steel[1]);
      for (let y = 106; y < 118; y += 3) R(c, 20, y, 30, 2, C.steel[2]);
      R(c, 20, 117, 30, 1, C.ink);
      R(c, 33, 115, 4, 2, C.ink); // the handle
      // inside: a desk with a screen, and a beanbag
      R(c, 36, 130, 12, 2, C.wood[1]);
      R(c, 37, 132, 1, 8, C.wood[0]);
      R(c, 46, 132, 1, 8, C.wood[0]);
      R(c, 38, 122, 8, 7, C.ink);
      R(c, 39, 123, 6, 5, '#1c2130');
      R(c, 40, 124, 3, 1, '#7fee64');
      R(c, 40, 126, 4, 1, '#62b0e8');
      E(c, 27, 136, 5, 4, C.ink);
      E(c, 27, 136, 4, 3, '#e0685c');
    } else {
      for (let y = 106; y < 140; y += 3) {
        R(c, 20, y, 30, 2, C.steel[2]);
        R(c, 20, y + 2, 30, 1, C.steel[1]);
      }
      R(c, 33, 135, 4, 2, C.ink);
    }
    squareWindow(c, 80, 108, lit);
    sill(c, 80, 124, 15, false);
    // bunting across the front
    R(c, 17, 100, 90, 1, C.ink);
    for (let i = 0; i < 10; i++) {
      const color = ['#e0685c', trim[1], '#62b0e8', '#7fee64'][i % 4];
      R(c, 19 + i * 9, 101, 5, 2, color);
      R(c, 20 + i * 9, 103, 3, 1, color);
      R(c, 21 + i * 9, 104, 1, 1, color);
    }
    door(c, 54, 16, 26, lit);
    // a whiteboard leaning outside, covered in arrows
    R(c, 109, GROUND - 3, 1, 4, C.ink);
    R(c, 119, GROUND - 3, 1, 4, C.ink);
    box(c, 107, GROUND - 20, 15, 17, C.white);
    R(c, 109, GROUND - 17, 5, 1, '#e0685c');
    R(c, 109, GROUND - 14, 8, 1, '#4d7ea8');
    R(c, 116, GROUND - 16, 3, 3, '#58a858');
    R(c, 110, GROUND - 11, 3, 3, '#e8a82d');
    R(c, 113, GROUND - 10, 5, 1, C.ink);
    R(c, 117, GROUND - 11, 1, 3, C.ink);
    R(c, 109, GROUND - 7, 10, 1, '#b9b3c6');
  },

  // Juniper: a timber workshop with a big gear on the gable and a stovepipe.
  workshop(c, v, lit) {
    const roof = ramp(v.accent);
    R(c, 84, 36, 8, 30, C.ink);
    R(c, 85, 37, 6, 28, C.steel[1]);
    R(c, 85, 37, 2, 28, C.steel[2]);
    R(c, 82, 34, 12, 4, C.ink);
    R(c, 83, 35, 10, 2, C.steel[0]);
    plasterWalls(c, 22, 94, 80, 46, [C.wood[1], C.wood[3], C.wood[4]], false);
    for (let x = 30; x < 100; x += 9) R(c, x, 94, 1, 39, C.wood[2]);
    shingles(c, 57, 41, 31, 49, roof);
    // the gear
    const gx = MID;
    const gy = 76;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      box(c, Math.round(gx + Math.cos(a) * 10) - 2, Math.round(gy + Math.sin(a) * 10) - 2, 5, 5, C.steel[1]);
    }
    EO(c, gx, gy, 8, 8, C.steel[2]);
    E(c, gx, gy, 5, 5, C.steel[1]);
    EO(c, gx, gy, 2, 2, roof[1]);
    squareWindow(c, 29, 104, lit);
    squareWindow(c, 80, 104, lit);
    sill(c, 29, 120, 15, false);
    sill(c, 80, 120, 15, false);
    door(c, 54, 16, 26, lit);
    // sawhorse and plank
    R(c, 6, GROUND - 9, 14, 3, C.ink);
    R(c, 7, GROUND - 8, 12, 1, C.wood[4]);
    R(c, 8, GROUND - 6, 2, 7, C.ink);
    R(c, 16, GROUND - 6, 2, 7, C.ink);
  },

  // Bao: the corner shop, with a striped awning and a hanging sign.
  shop(c, v, lit) {
    const roof = ramp(v.accent);
    brickChimney(c, 78, 46);
    plasterWalls(c, 22, 94, 80, 46);
    shingles(c, 57, 41, 31, 49, roof);
    // shop window with goods
    R(c, 26, 103, 24, 20, C.ink);
    R(c, 27, 104, 22, 18, lit ? C.glow : C.night[0]);
    if (lit) R(c, 27, 104, 8, 6, C.glowHi);
    for (const [x, color] of [[29, '#d6553f'], [35, '#e8a82d'], [41, '#4d7ea8']]) box(c, x, 115, 5, 7, color);
    R(c, 27, 113, 22, 1, C.wood[1]);
    squareWindow(c, 80, 104, lit);
    sill(c, 80, 120, 15);
    // awning
    for (let i = 0; i < 9; i++) {
      R(c, 22 + i * 4, 96, 4, 7, i % 2 ? C.white : roof[1]);
      R(c, 22 + i * 4, 103, 4, 2, i % 2 ? '#d9d4c6' : roof[0]);
    }
    R(c, 21, 95, 38, 1, C.ink);
    R(c, 21, 105, 38, 1, C.ink);
    R(c, 21, 95, 1, 11, C.ink);
    R(c, 58, 95, 1, 11, C.ink);
    door(c, 60, 16, 26, lit);
    // hanging sign with a coin
    R(c, 100, 100, 9, 1, C.ink);
    R(c, 106, 101, 1, 3, C.ink);
    box(c, 101, 104, 11, 11, C.wood[4]);
    EO(c, 106, 109, 2, 2, C.gold);
    // a barrel outside
    box(c, 6, GROUND - 13, 13, 14, C.wood[2]);
    R(c, 7, GROUND - 9, 11, 1, C.steel[0]);
    R(c, 7, GROUND - 4, 11, 1, C.steel[0]);
  },

  // Orlo: a crooked stone tower with a pointed, starry roof and a crystal-ball window.
  tower(c, v, lit) {
    const roof = ramp(v.accent);
    R(c, 35, 58, 54, 83, C.ink);
    R(c, 36, 59, 52, 81, C.stone[1]);
    R(c, 36, 59, 6, 81, C.stone[2]);
    R(c, 80, 59, 8, 81, C.stone[0]);
    for (let row = 0; row < 10; row++) {
      const y = 62 + row * 8;
      R(c, 36, y, 52, 1, C.stone[0]);
      for (let x = 40 + (row % 2) * 6; x < 86; x += 12) R(c, x, y + 1, 1, 7, C.stone[0]);
    }
    // ivy
    for (const [x, y] of [[38, 120], [40, 112], [37, 104], [42, 126], [39, 96]]) {
      R(c, x, y, 3, 3, C.leaf[1]);
      R(c, x + 1, y, 1, 1, C.leaf[3]);
    }
    // cone roof, bent a little at the tip
    for (let row = 0; row < 50; row++) {
      const half = 2 + Math.round((row * 31) / 49);
      const lean = row < 14 ? 3 - Math.floor(row / 5) : 0;
      const y = 10 + row;
      R(c, MID + lean - half - 1, y, half * 2 + 3, 1, C.ink);
      R(c, MID + lean - half, y, half * 2 + 1, 1, row % 9 === 0 ? roof[0] : roof[1]);
      R(c, MID + lean - half, y, Math.max(1, Math.floor(half / 3)), 1, roof[2]);
    }
    R(c, MID - 35, 60, 71, 2, C.ink);
    R(c, MID - 34, 60, 69, 1, roof[0]);
    for (const [x, y] of [[58, 32], [70, 44], [50, 48], [64, 54], [76, 56]]) {
      R(c, x, y, 1, 3, C.glow);
      R(c, x - 1, y + 1, 3, 1, C.glow);
    }
    // crescent on top
    EO(c, MID + 3, 6, 3, 3, C.gold);
    E(c, MID + 5, 5, 2, 2, C.ink);
    roundWindow(c, MID, 84, 7, lit, C.gold, '#b9a2ff');
    if (lit) {
      R(c, MID - 2, 83, 5, 3, '#e9defF'.toLowerCase());
      R(c, MID - 5, 80, 2, 2, C.white);
    }
    R(c, 44, 104, 7, 10, C.ink);
    R(c, 45, 105, 5, 8, lit ? C.glow : C.night[0]);
    R(c, 74, 100, 7, 10, C.ink);
    R(c, 75, 101, 5, 8, lit ? C.glow : C.night[0]);
    door(c, 54, 16, 24, lit, [C.wood[0], C.wood[1], '#6d3f7a', '#8a55a0']);
  },

  // Dot: a tidy metal lab with a dish, an aerial and a hazard stripe.
  lab(c, v, lit) {
    const trim = ramp(v.accent);
    R(c, 21, 87, 82, 54, C.ink);
    R(c, 22, 88, 80, 52, C.steel[2]);
    for (let x = 22; x < 102; x += 16) {
      R(c, x, 88, 1, 52, C.steel[1]);
      R(c, x + 3, 92, 1, 1, C.steel[0]);
      R(c, x + 3, 134, 1, 1, C.steel[0]);
    }
    R(c, 22, 88, 80, 3, C.steel[3]);
    R(c, 22, 133, 80, 7, C.steel[0]);
    // flat roof with a hazard stripe
    R(c, 17, 76, 90, 13, C.ink);
    R(c, 18, 77, 88, 5, C.steel[1]);
    R(c, 18, 77, 88, 1, C.steel[3]);
    for (let i = 0; i < 22; i++) R(c, 18 + i * 4, 82, 4, 6, i % 2 ? C.ink : trim[1]);
    // dish
    R(c, 33, 62, 2, 15, C.ink);
    for (let row = 0; row < 9; row++) {
      const half = 3 + row;
      R(c, 34 - half - 1, 50 + row, half * 2 + 3, 1, C.ink);
      R(c, 34 - half, 50 + row, half * 2 + 1, 1, row < 2 ? C.steel[3] : C.steel[2]);
    }
    R(c, 33, 46, 3, 5, C.ink);
    R(c, 34, 44, 1, 3, trim[1]);
    // aerial (its lamp is drawn live)
    R(c, 86, 46, 1, 31, C.ink);
    R(c, 83, 56, 7, 1, C.ink);
    R(c, 84, 64, 5, 1, C.ink);
    // slit windows
    for (const x of [28, 76]) {
      R(c, x, 100, 20, 9, C.ink);
      R(c, x + 1, 101, 18, 7, lit ? '#8ef0e6' : C.night[0]);
      if (lit) R(c, x + 1, 101, 6, 3, C.white);
      R(c, x + 7, 101, 1, 7, C.ink);
      R(c, x + 13, 101, 1, 7, C.ink);
    }
    // vent
    for (let i = 0; i < 4; i++) R(c, 30, 116 + i * 3, 12, 1, C.steel[0]);
    door(c, 54, 16, 24, lit, [C.steel[0], C.steel[1], C.steel[2], C.steel[3]]);
    EO(c, MID, 124, 2, 2, lit ? '#8ef0e6' : C.night[1]);
    // a little solar panel
    box(c, 106, GROUND - 12, 14, 9, '#2f4f7a');
    R(c, 112, GROUND - 11, 1, 7, C.steel[2]);
    R(c, 107, GROUND - 8, 12, 1, C.steel[2]);
    R(c, 112, GROUND - 3, 2, 4, C.ink);
  },

  // Moss: a house grown from a mushroom, with a spotted cap for a roof.
  mushroom(c, v, lit) {
    const cap = ramp(v.accent);
    // a little bent flue poking out of the cap
    R(c, 82, 42, 9, 16, C.ink);
    R(c, 83, 43, 7, 14, C.stone[1]);
    R(c, 83, 43, 2, 14, C.stone[2]);
    R(c, 80, 40, 13, 4, C.ink);
    R(c, 81, 41, 11, 2, C.stone[2]);
    // stem walls
    R(c, 33, 90, 58, 51, C.ink);
    R(c, 34, 91, 56, 49, '#f3e6c8');
    R(c, 34, 91, 5, 49, C.white);
    R(c, 78, 91, 12, 49, '#dcc9a3');
    R(c, 34, 132, 56, 8, '#cdb98f');
    for (const [x, y] of [[42, 104], [70, 110], [50, 126], [80, 122]]) R(c, x, y, 3, 1, '#dcc9a3');
    // the cap: a dome, with gills underneath
    for (let row = 0; row < 46; row++) {
      const t = row / 45;
      const half = Math.round(56 * Math.sqrt(1 - (1 - t) * (1 - t)));
      const y = 46 + row;
      R(c, MID - half - 1, y, half * 2 + 3, 1, C.ink);
      R(c, MID - half, y, half * 2 + 1, 1, row > 38 ? cap[0] : cap[1]);
      R(c, MID - half, y, Math.max(2, Math.floor(half / 3)), 1, cap[2]);
    }
    R(c, MID - 57, 92, 115, 5, C.ink);
    R(c, MID - 56, 92, 113, 4, '#ead9b6');
    for (let x = MID - 54; x < MID + 56; x += 5) R(c, x, 92, 1, 4, '#bfa878');
    for (const [x, y, rx, ry] of [[36, 74, 7, 5], [62, 58, 8, 6], [88, 76, 6, 4], [52, 82, 4, 3], [76, 62, 4, 3], [102, 86, 3, 2], [20, 86, 3, 2]]) {
      E(c, x, y, rx, ry, C.white);
      E(c, x + 1, y + 1, Math.max(1, rx - 2), Math.max(1, ry - 2), '#f3ead8');
    }
    roundWindow(c, 44, 112, 5, lit);
    roundWindow(c, 80, 112, 5, lit);
    door(c, 54, 16, 24, lit, [C.leaf[0], C.leaf[1], C.leaf[2], C.leaf[3]]);
    // small mushrooms by the step
    for (const [x, h] of [[24, 7], [16, 5], [98, 6]]) {
      R(c, x, GROUND - h, 3, h, C.white);
      box(c, x - 3, GROUND - h - 4, 9, 5, cap[1]);
      R(c, x - 1, GROUND - h - 3, 2, 1, C.white);
    }
  },

  // Fennel: the caravan he arrived in, wheels and all.
  caravan(c, v, lit) {
    const paint = ramp(v.color);
    const trim = ramp(v.accent);
    // stovepipe
    R(c, 90, 52, 7, 16, C.ink);
    R(c, 91, 53, 5, 14, C.steel[1]);
    R(c, 88, 50, 11, 4, C.ink);
    R(c, 89, 51, 9, 2, C.steel[2]);
    // body
    R(c, 13, 83, 98, 47, C.ink);
    R(c, 14, 84, 96, 45, paint[1]);
    R(c, 14, 84, 96, 3, trim[1]);
    R(c, 14, 122, 96, 7, paint[0]);
    R(c, 14, 122, 96, 1, trim[1]);
    for (let x = 22; x < 110; x += 11) R(c, x, 88, 1, 33, paint[0]);
    R(c, 14, 87, 3, 35, paint[2]);
    // barrel roof in stripes
    for (let row = 0; row < 24; row++) {
      const t = row / 23;
      const half = Math.round(54 * Math.sqrt(1 - (1 - t) * (1 - t)));
      const y = 60 + row;
      R(c, MID - half - 1, y, half * 2 + 3, 1, C.ink);
      for (let x = MID - half; x <= MID + half; x++) R(c, x, y, 1, 1, Math.floor((x + 200) / 9) % 2 ? trim[1] : C.white);
      R(c, MID - half, y, Math.max(1, Math.floor(half / 5)), 1, trim[2]);
    }
    R(c, MID - 56, 83, 113, 2, C.ink);
    R(c, MID - 55, 83, 111, 1, trim[0]);
    // bunting
    for (let i = 0; i < 9; i++) {
      const x = 18 + i * 10;
      const color = ['#4d7ea8', '#58a858', '#e8a82d'][i % 3];
      R(c, x, 87, 5, 2, color);
      R(c, x + 1, 89, 3, 1, color);
      R(c, x + 2, 90, 1, 1, color);
    }
    squareWindow(c, 22, 96, lit, 13);
    squareWindow(c, 89, 96, lit, 13);
    // wheels
    for (const x of [30, 94]) {
      E(c, x, 130, 11, 11, C.ink);
      E(c, x, 130, 10, 10, C.wood[2]);
      E(c, x, 130, 7, 7, C.ink);
      E(c, x, 130, 6, 6, '#6fae5a');
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI;
        R(c, Math.round(x + Math.cos(a) * 6), Math.round(130 + Math.sin(a) * 6), 1, 1, C.wood[3]);
        R(c, Math.round(x - Math.cos(a) * 6), Math.round(130 - Math.sin(a) * 6), 1, 1, C.wood[3]);
        R(c, Math.round(x + Math.cos(a) * 3), Math.round(130 + Math.sin(a) * 3), 1, 1, C.wood[3]);
        R(c, Math.round(x - Math.cos(a) * 3), Math.round(130 - Math.sin(a) * 3), 1, 1, C.wood[3]);
      }
      EO(c, x, 130, 2, 2, trim[1]);
    }
    door(c, 54, 16, 28, lit, [C.wood[0], C.wood[1], trim[1], trim[2]]);
    // wooden steps down from the door
    R(c, 49, GROUND - 6, 26, 4, C.ink);
    R(c, 50, GROUND - 5, 24, 2, C.wood[3]);
    R(c, 46, GROUND - 1, 32, 5, C.ink);
    R(c, 47, GROUND, 30, 3, C.wood[2]);
    // a lantern on a hook
    R(c, 110, 92, 5, 1, C.ink);
    box(c, 112, 93, 7, 9, lit ? C.glow : C.night[0]);
  },

  // Wisp: what is left of an old chapel. An arch, two stumps of wall and a lantern.
  ruin(c, v, lit) {
    const stones = (x, y, w, h, seed) => {
      R(c, x - 1, y - 1, w + 2, h + 2, C.ink);
      R(c, x, y, w, h, C.stone[1]);
      R(c, x, y, 2, h, C.stone[2]);
      R(c, x + w - 2, y, 2, h, C.stone[0]);
      for (let yy = y + 5 + (seed % 3); yy < y + h; yy += 7) {
        R(c, x, yy, w, 1, C.stone[0]);
        R(c, x + 3 + ((yy + seed) % 5), yy - 6, 1, 6, C.stone[0]);
      }
    };
    // crumbled walls either side
    stones(14, 120, 22, 20, 1);
    stones(88, 126, 20, 14, 2);
    R(c, 13, 117, 8, 4, C.ink);
    R(c, 14, 118, 6, 3, C.stone[1]);
    R(c, 100, 122, 6, 5, C.ink);
    R(c, 101, 123, 4, 4, C.stone[2]);
    // the pillars of the arch; the right one is broken short
    stones(36, 84, 13, 56, 3);
    stones(75, 100, 13, 40, 4);
    R(c, 74, 96, 8, 5, C.ink);
    R(c, 75, 97, 6, 4, C.stone[1]);
    // the arch itself, ending in mid-air
    for (let i = 0; i < 9; i++) {
      const a = Math.PI - (i / 12) * Math.PI;
      const x = Math.round(62 + Math.cos(a) * 20);
      const y = Math.round(86 - Math.sin(a) * 14);
      box(c, x - 4, y - 4, 9, 9, i % 2 ? C.stone[1] : C.stone[2]);
    }
    if (lit) {
      // a pale glow where a door would be
      for (let y = 92; y < 138; y += 2) R(c, 50 + ((y / 2) % 2), y, 24, 1, 'rgba(159, 226, 255, .28)');
    }
    // ivy and moss
    for (const [x, y] of [[37, 96], [40, 108], [36, 122], [78, 112], [84, 104], [16, 124], [94, 130], [44, 88]]) {
      R(c, x, y, 3, 3, C.leaf[1]);
      R(c, x + 1, y, 1, 1, C.leaf[3]);
    }
    // the lantern hanging from the arch
    R(c, 62, 76, 1, 8, C.ink);
    box(c, 58, 84, 9, 11, lit ? '#9fe2ff' : C.night[0]);
    if (lit) R(c, 61, 87, 3, 4, C.white);
    R(c, 57, 83, 11, 2, C.ink);
    // threshold stone
    R(c, 46, GROUND - 1, 32, 5, C.ink);
    R(c, 47, GROUND, 30, 3, C.stone[2]);
    R(c, 47, GROUND + 2, 30, 1, C.stone[1]);
  },
};

function houseSprite(v, lit) {
  const key = `${v.id}:${lit}`;
  if (houseSprites.has(key)) return houseSprites.get(key);
  const canvas = makeCanvas(124, 150);
  const c = canvas.getContext('2d');
  E(c, MID, GROUND + 1, HALF_WIDTH[v.style] ? HALF_WIDTH[v.style] + 4 : 48, 4, C.shade);
  (BUILD[v.style] || BUILD.shop)(c, v, lit);
  houseSprites.set(key, canvas);
  return canvas;
}

// A fallen house is made of that house. Its walls still stand at the foot, broken off low in
// the middle and higher at the corners; the rest lies in a heap in front, in pieces cut from its
// own roof and walls. Drawn in the same frame as the house, so it sits exactly where it stood.
const rubbleSprites = new Map();
const FRAME_W = 124;
const FRAME_H = 150;

// Where a house's sprite is solid, as rows of booleans, and the box it fills (shadow left out).
function solidOf(sprite) {
  const data = sprite.getContext('2d').getImageData(0, 0, FRAME_W, FRAME_H).data;
  const solid = (x, y) => x >= 0 && y >= 0 && x < FRAME_W && y < FRAME_H && data[(y * FRAME_W + x) * 4 + 3] === 255;
  let left = FRAME_W;
  let right = 0;
  let top = FRAME_H;
  for (let y = 0; y < GROUND; y++) {
    for (let x = 0; x < FRAME_W; x++) {
      if (!solid(x, y)) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
    }
  }
  return { solid, left, right, top };
}

function rubbleSprite(v) {
  if (rubbleSprites.has(v.id)) return rubbleSprites.get(v.id);
  const house = houseSprite(v, false);
  const { solid, left, right, top } = solidOf(house);
  const canvas = makeCanvas(FRAME_W, FRAME_H);
  const c = canvas.getContext('2d');
  const rand = seeded(v.name.length * 131 + v.door.x);
  const span = right - left;
  const tall = GROUND - top;

  // the ground it fell on: a shadow, and a spread of dust wider than the house was
  E(c, MID, GROUND + 3, span / 2 + 12, 7, C.shade);
  E(c, MID, GROUND + 1, span / 2 + 7, 6, C.stone[0]);
  E(c, MID, GROUND, span / 2 + 3, 4, C.stone[1]);

  // what still stands: the foot of the walls, broken off low in the middle and high at the corners
  const stand = [];
  let height = 0;
  for (let x = left; x <= right; x++) {
    const edge = Math.abs((x - left) / span - 0.5) * 2; // 0 in the middle, 1 at a corner
    if ((x - left) % 3 === 0) height = Math.round(Math.min(tall * 0.5, 5 + edge * edge * edge * 40 + rand() * 8));
    stand[x] = Math.max(3, height);
  }
  const kept = (x, y) => solid(x, y) && x >= left && x <= right && y >= GROUND - stand[x];
  for (let x = left; x <= right; x++) {
    for (let y = GROUND - stand[x]; y < FRAME_H; y++) {
      if (!kept(x, y)) continue;
      // where the wall carried on before it broke, the edge is drawn in
      const broken = (solid(x, y - 1) && !kept(x, y - 1)) || (solid(x - 1, y) && !kept(x - 1, y)) || (solid(x + 1, y) && !kept(x + 1, y));
      if (broken) R(c, x, y, 1, 1, C.ink);
      else c.drawImage(house, x, y, 1, 1, x, y, 1, 1);
    }
  }

  // a piece of the house, cut out with an ink edge all round, laid flat or on its side
  const piece = (sx, sy, w, h, dx, dy, turned) => {
    const part = makeCanvas(turned ? h : w, turned ? w : h);
    const p = part.getContext('2d');
    if (turned) {
      p.translate(h, 0);
      p.rotate(Math.PI / 2);
    }
    p.drawImage(house, sx, sy, w, h, 0, 0, w, h);
    R(c, dx - 1, dy - 1, part.width + 2, part.height + 2, C.ink);
    R(c, dx, dy, part.width, part.height, C.stone[0]);
    c.drawImage(part, dx, dy);
    R(c, dx, dy + part.height - 1, part.width, 1, 'rgba(26, 20, 44, .35)');
  };
  // somewhere solid in the part of the house that came down
  const from = (w, h) => {
    for (let tries = 0; tries < 30; tries++) {
      const sx = left + Math.floor(rand() * Math.max(1, span - w));
      const sy = top + Math.floor(rand() * Math.max(1, tall * 0.85 - h));
      if (solid(sx, sy) && solid(sx + w - 1, sy + h - 1) && solid(sx + w - 1, sy) && solid(sx, sy + h - 1)) return [sx, sy];
    }
    return [MID - (w >> 1), GROUND - 12 - h];
  };

  // the heap: small pieces at the back, bigger ones on top and in front
  const pieces = [];
  for (let i = 0; i < 30; i++) {
    const big = i % 3 === 0;
    const w = big ? 12 + Math.floor(rand() * 10) : 6 + Math.floor(rand() * 6);
    const h = big ? 6 + Math.floor(rand() * 5) : 4 + Math.floor(rand() * 3);
    const turned = rand() < 0.3;
    const spread = (rand() + rand() + rand()) / 3 - 0.5; // bunched towards the middle
    const dx = Math.round(MID + spread * (span + 14) - w / 2);
    const lift = Math.round((1 - Math.min(1, Math.abs(spread) * 2.4)) * 22 * rand()); // higher in the middle
    const dy = GROUND - 9 - lift + Math.floor(rand() * 12);
    pieces.push({ w, h, turned, dx, dy });
  }
  pieces.sort((a, b) => a.dy + (a.turned ? a.w : a.h) - (b.dy + (b.turned ? b.w : b.h)));
  for (const one of pieces) piece(...from(one.w, one.h), one.w, one.h, one.dx, one.dy, one.turned);

  // the roof came down in one long piece, across the top of the heap, tipped to one side
  const roofW = Math.min(46, Math.round(span * 0.5));
  const [rx, ry] = [MID - (roofW >> 1) + Math.round((rand() - 0.5) * 8), top + Math.round(tall * 0.12)];
  const slab = makeCanvas(roofW + 2, 30);
  const s = slab.getContext('2d');
  const lean = v.door.x % 2 ? 1 : -1;
  for (let i = 0; i < roofW; i++) {
    const drop = Math.floor((lean > 0 ? i : roofW - 1 - i) * 0.3);
    R(s, i, drop, 3, 11, C.ink);
  }
  for (let i = 0; i < roofW; i++) {
    const drop = Math.floor((lean > 0 ? i : roofW - 1 - i) * 0.3);
    R(s, i + 1, drop + 1, 1, 9, C.stone[0]);
    s.drawImage(house, rx + i, ry, 1, 9, i + 1, drop + 1, 1, 9);
  }
  c.drawImage(slab, MID - (roofW >> 1) - 1 + lean * 4, GROUND - 38);

  rubbleSprites.set(v.id, canvas);
  return canvas;
}

// The shape the house had, in dots of Modal's green: its snapshot, waiting to be rebuilt from.
const ghostSprites = new Map();
function ghostSprite(v) {
  if (ghostSprites.has(v.id)) return ghostSprites.get(v.id);
  const { solid } = solidOf(houseSprite(v, false));
  const canvas = makeCanvas(FRAME_W, FRAME_H);
  const c = canvas.getContext('2d');
  for (let y = 0; y <= GROUND; y++) {
    for (let x = 0; x < FRAME_W; x++) {
      if (solid(x, y) || (x + y) % 4 > 1) continue; // dashes: two on, two off
      if (solid(x + 1, y) || solid(x - 1, y) || solid(x, y + 1) || solid(x, y - 1)) R(c, x, y, 1, 1, '#f1ffe9');
    }
  }
  ghostSprites.set(v.id, canvas);
  return canvas;
}

// Dust thrown up as a house comes down, and the wisps that hang about after.
function dust(c, x, y, half, age) {
  if (age < 2.6) {
    const grow = Math.min(1, age / 0.9);
    const thin = age < 1.2 ? 1 : Math.max(0, 1 - (age - 1.2) / 1.4);
    for (let i = 0; i < 9; i++) {
      const side = i / 8 - 0.5;
      const r = Math.round((4 + ((i * 5) % 4) * 2) * (0.5 + grow * 0.9) * thin);
      if (r < 1) continue;
      puff(c, x + side * (half * 2 + 30 * grow), y - 4 - Math.round(grow * (6 + (i % 3) * 7)) - Math.round(Math.max(0, age - 0.9) * 9), r, i % 2 ? '#e4dfe6' : '#cfc8d2');
    }
  }
  for (let i = 0; i < 3; i++) {
    const phase = (age * 0.3 + i / 3) % 1;
    if (phase < 0.7) puff(c, x - half * 0.5 + i * half * 0.5, y - 26 - Math.round(phase * 18), 1 + Math.round(phase * 3), '#cfc8d2');
  }
}

// Small stars going round the head of somebody whose house has just fallen on them.
// A small yellow arrow with an ink edge, pointing along `angle` (0 is right, a quarter turn is
// down). Made a pixel at a time for eight directions, so it stays crisp whichever way it points
// (at this size the ones in between come out as blobs). Small on purpose: it is a hint.
const pointers = new Map();
export function drawPointer(c, x, y, angle) {
  const turn = (((Math.round((angle / (Math.PI * 2)) * 8) * 2) % 16) + 16) % 16;
  if (!pointers.has(turn)) {
    const size = 13;
    const mid = 6;
    const canvas = makeCanvas(size, size);
    const p = canvas.getContext('2d');
    const a = (turn / 16) * Math.PI * 2;
    const inside = (px, py) => {
      const u = (px - mid) * Math.cos(a) + (py - mid) * Math.sin(a); // along the arrow
      const w = Math.abs(-(px - mid) * Math.sin(a) + (py - mid) * Math.cos(a)); // across it
      return (u >= 0.5 && u <= 4.6 && w <= (4.6 - u) * 0.9 + 0.3) || (u >= -3.6 && u < 0.5 && w <= 1.2);
    };
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        if (inside(px, py)) R(p, px, py, 1, 1, '#ffdf70');
        else if (inside(px + 1, py) || inside(px - 1, py) || inside(px, py + 1) || inside(px, py - 1)) R(p, px, py, 1, 1, C.ink);
      }
    }
    pointers.set(turn, canvas);
  }
  c.drawImage(pointers.get(turn), Math.round(x) - 6, Math.round(y) - 6);
}

// The small yellow chevron that hangs over whatever the yellow button, or the next thing to try,
// is about.
export function drawChevron(c, x, y) {
  R(c, x - 4, y - 5, 9, 4, C.ink);
  R(c, x - 3, y - 1, 7, 1, C.ink);
  R(c, x - 2, y, 5, 1, C.ink);
  R(c, x - 1, y + 1, 3, 1, C.ink);
  R(c, x - 3, y - 4, 7, 2, '#ffdf70');
  R(c, x - 2, y - 2, 5, 1, '#ffdf70');
  R(c, x - 1, y - 1, 3, 1, '#ffdf70');
  R(c, x, y, 1, 1, '#ffdf70');
  R(c, x - 3, y - 4, 7, 1, '#fff6c4');
}

export function drawDaze(c, x, y, t) {
  for (let i = 0; i < 3; i++) {
    const turn = t * 4 + (i * Math.PI * 2) / 3;
    const sx = Math.round(x + Math.cos(turn) * 8);
    const sy = Math.round(y + Math.sin(turn) * 2.5);
    const front = Math.sin(turn) > 0;
    R(c, sx - 1, sy, 3, 1, front ? '#ffe27a' : '#c9a23c');
    R(c, sx, sy - 1, 1, 3, front ? '#ffe27a' : '#c9a23c');
  }
}

function puff(c, x, y, r, tone) {
  E(c, x, y, r, r, tone);
  if (r > 1) R(c, x - 1, y - r, 2, 1, C.white);
}

function letterZ(c, x, y, size) {
  R(c, x, y, size, 1, C.ink);
  R(c, x, y + size - 1, size, 1, C.ink);
  for (let i = 1; i < size - 1; i++) R(c, x + size - 1 - i, y + i, 1, 1, C.ink);
}

// Where smoke (or its local equivalent) rises from, relative to the door.
const VENT = { workshop: [26, -106], shop: [23, -96], tower: [3, -134], lab: [24, -96], mushroom: [24, -100], caravan: [29, -86], ruin: [0, -44] };

export function houseTop(v) {
  return v.door.y - ({ tower: 138, mushroom: 98, caravan: 82, ruin: 66, gpu: 74, garage: 72 }[v.style] || 88);
}

const FALL_S = 0.9; // how long a house takes to come down
const RISE_S = 0.9; // and to go back up from its snapshot (the wake scan climbs in the same time)

// `v.fellAt` and `v.roseAt` are the game times its house last fell and was last rebuilt.
export function drawHouse(c, v, t) {
  const { x, y } = v.door;
  const half = HALF_WIDTH[v.style] || 48;
  const saved = !!v.state?.snapshot_id;
  const ghost = (alpha) => {
    c.globalAlpha = alpha;
    c.drawImage(ghostSprite(v), x - MID, y - GROUND);
    c.globalAlpha = 1;
  };
  if (v.show === 'rubble') {
    const age = v.fellAt == null ? 99 : t - v.fellAt;
    if (age < FALL_S) {
      // coming down: a shudder, then it drops into its own dust as the heap comes up
      const drop = Math.max(0, (age - 0.25) / (FALL_S - 0.25));
      const sink = Math.round(drop * drop * (y - houseTop(v) + 10));
      const shake = Math.round(Math.sin(age * 70) * (age < 0.25 ? 2 : 1));
      const heap = Math.round(drop * 60);
      if (heap > 0) c.drawImage(rubbleSprite(v), 0, GROUND + 12 - heap, FRAME_W, heap, x - MID, y + 12 - heap, FRAME_W, heap);
      if (GROUND + 3 - sink > 0) c.drawImage(houseSprite(v, false), 0, 0, FRAME_W, GROUND + 3 - sink, x - MID + shake, y - GROUND + sink, FRAME_W, GROUND + 3 - sink);
    } else {
      c.drawImage(rubbleSprite(v), x - MID, y - GROUND);
      if (saved) ghost(0.8 + 0.2 * Math.sin(t * 2.2));
    }
    dust(c, x, y, half, age);
    return;
  }
  const rising = v.roseAt == null ? 99 : t - v.roseAt;
  if (rising < RISE_S) {
    // going back up: the house fills in from the ground behind the scan line, and what is
    // still to come is its outline
    const line = Math.round(y - (y - houseTop(v)) * (rising / RISE_S));
    ghost(1);
    c.save();
    c.beginPath();
    c.rect(x - 80, line, 160, y + 20 - line);
    c.clip();
    standingHouse(c, v, t);
    c.restore();
    return;
  }
  standingHouse(c, v, t);
}

function standingHouse(c, v, t) {
  const { x, y } = v.door;
  const lit = v.show === 'awake' || v.show === 'waking';
  c.drawImage(houseSprite(v, lit), x - MID, y - GROUND);
  const [vx, vy] = VENT[v.style] || VENT.shop;

  if (v.style === 'gpu') {
    // the fans: spinning while the sandbox runs, still when it does not
    const turn = lit ? t * 9 : 0.5;
    for (const cx of [x - 26, x + 26]) {
      for (let blade = 0; blade < 3; blade++) {
        const angle = turn + (blade * Math.PI * 2) / 3;
        for (let r = 4; r <= 12; r += 2) {
          const bend = angle + (r - 4) * 0.07;
          R(c, cx + Math.round(Math.cos(bend) * r) - 1, y - 30 + Math.round(Math.sin(bend) * r) - 1, 3, 3, lit ? '#8793a4' : '#5d6878');
        }
      }
      R(c, cx - 1, y - 31, 3, 3, lit ? '#7fee64' : '#4a505c');
    }
  }
  if (v.style === 'lab') {
    const on = lit ? Math.floor(t * 2) % 2 === 0 : false;
    box(c, x + 22, y - 98, 5, 5, on ? '#ff6b5e' : '#6d2b33');
    if (on) R(c, x + 23, y - 97, 1, 1, C.white);
  }

  if (lit) {
    if (v.style === 'tower') {
      for (let i = 0; i < 5; i++) {
        const phase = (t * 0.5 + i / 5) % 1;
        const sx = x + vx + Math.round(Math.sin(phase * 7 + i * 2) * 9);
        const sy = y + vy + 14 - Math.round(phase * 26);
        R(c, sx, sy, 1, 3, i % 2 ? '#d9c2ff' : C.glow);
        R(c, sx - 1, sy + 1, 3, 1, i % 2 ? '#d9c2ff' : C.glow);
      }
    } else if (v.style === 'ruin') {
      // nothing burns here: pale wisps drift up through the arch instead
      for (let i = 0; i < 4; i++) {
        const phase = (t * 0.35 + i / 4) % 1;
        const sx = x + Math.round(Math.sin(phase * 6 + i * 1.7) * 10);
        R(c, sx, y - 20 - Math.round(phase * 34), 2, 2, phase < 0.6 ? '#bfeaff' : '#7fb6d6');
        R(c, sx + 1, y - 18 - Math.round(phase * 34), 1, 2, '#e9f8ff');
      }
    } else if (v.style !== 'lab' && v.style !== 'gpu' && v.style !== 'garage') {
      for (let i = 0; i < 3; i++) {
        const phase = (t * 0.4 + i / 3) % 1;
        const drift = Math.round(Math.sin(phase * 5 + i) * 3);
        puff(c, x + vx + drift, y + vy - Math.round(phase * 22), 2 + Math.round(phase * 3), phase > 0.66 ? '#d9d4de' : '#f4f1ea');
      }
    }
  } else {
    for (let i = 0; i < 3; i++) {
      const phase = (t * 0.33 + i / 3) % 1;
      if (phase > 0.85) continue;
      letterZ(c, x + 30 + Math.round(phase * 12), houseTop(v) + 14 - Math.round(phase * 22), 3 + Math.round(phase * 3));
    }
  }
}

// A mailbox by the house. The flag is up while letters are waiting for a sleeping villager.
export function drawMailbox(c, x, y, waiting, t) {
  R(c, x - 1, y - 9, 3, 10, C.ink);
  R(c, x, y - 8, 1, 8, C.wood[2]);
  box(c, x - 5, y - 16, 11, 8, waiting ? C.white : C.steel[2]);
  R(c, x - 4, y - 15, 9, 1, C.steel[3]);
  if (waiting) {
    const up = Math.floor(t * 3) % 2;
    R(c, x + 6, y - 20 - up, 1, 8, C.ink);
    R(c, x + 7, y - 20 - up, 4, 3, '#e0483e');
    R(c, x - 3, y - 13, 7, 1, C.ink);
    R(c, x - 3, y - 13, 1, 3, C.ink);
    R(c, x + 3, y - 13, 1, 3, C.ink);
  }
}

// ---- the beacon: the shared model endpoint, as something you can walk up to ----------------

export function drawBeacon(c, at, tone, t, busy) {
  const { x, y } = at;
  const M = tone; // [dark, mid, bright, pale]
  E(c, x, y + 1, 15, 4, C.shade);
  // stone base
  box(c, x - 13, y - 5, 27, 7, C.stone[1]);
  R(c, x - 12, y - 4, 25, 1, C.stone[2]);
  box(c, x - 9, y - 11, 19, 7, C.stone[2]);
  R(c, x - 8, y - 10, 17, 1, C.white);
  R(c, x - 4, y - 8, 9, 1, M[0]);
  // column
  R(c, x - 4, y - 24, 9, 14, C.ink);
  R(c, x - 3, y - 23, 7, 12, C.stone[1]);
  R(c, x - 3, y - 23, 2, 12, C.stone[2]);
  R(c, x + 2, y - 23, 2, 12, C.stone[0]);
  R(c, x - 3, y - 19, 7, 1, C.stone[0]);
  R(c, x - 3, y - 14, 7, 1, C.stone[0]);
  // gallery
  R(c, x - 8, y - 28, 17, 5, C.ink);
  R(c, x - 7, y - 27, 15, 3, C.stone[2]);
  R(c, x - 7, y - 27, 15, 1, C.white);
  // lantern room: glass around a green light
  const flash = busy ? Math.floor(t * 8) % 2 : 0;
  R(c, x - 7, y - 42, 15, 15, C.ink);
  R(c, x - 6, y - 41, 13, 13, flash ? M[3] : M[2]);
  R(c, x - 6, y - 41, 4, 13, M[3]);
  R(c, x + 3, y - 41, 4, 13, M[1]);
  R(c, x - 2, y - 41, 1, 13, C.ink);
  R(c, x + 2, y - 41, 1, 13, C.ink);
  R(c, x - 6, y - 35, 13, 1, C.ink);
  R(c, x - 1, y - 39, 3, 3, C.white);
  // roof and finial
  R(c, x - 9, y - 45, 19, 4, C.ink);
  R(c, x - 8, y - 44, 17, 2, C.stone[1]);
  for (let row = 0; row < 6; row++) {
    const half = 6 - row;
    R(c, x - half - 1, y - 46 - row, half * 2 + 3, 1, C.ink);
    R(c, x - half, y - 46 - row, half * 2 + 1, 1, row % 2 ? mix(M[0], C.ink, 0.3) : M[0]);
  }
  R(c, x, y - 55, 1, 4, C.ink);
  R(c, x - 1, y - 57, 3, 3, C.gold);
  // light sweeping round: slow when idle, fast and long when someone is thinking
  const rays = busy ? 6 : 3;
  for (let i = 0; i < rays; i++) {
    const angle = t * (busy ? 2.6 : 0.5) + (i / rays) * Math.PI * 2;
    for (let r = 10; r <= (busy ? 24 : 15); r += 3) {
      R(c, Math.round(x + Math.cos(angle) * r), Math.round(y - 35 + Math.sin(angle) * r * 0.7), 1, 1, r % 2 ? M[2] : M[3]);
    }
  }
  for (let i = 0; i < 4; i++) {
    const phase = (t * 0.45 + i / 4) % 1;
    R(c, x - 9 + i * 6 + Math.round(Math.sin(phase * 6 + i) * 2), y - 48 - Math.round(phase * 22), 1, 1, phase < 0.7 ? M[2] : M[0]);
  }
}

// A stream of bright dots from the beacon to a thinking villager: a request to the shared
// endpoint going out, and tokens coming back.
export function drawBeam(c, at, tone, to, t) {
  const from = { x: at.x, y: at.y - 35 };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 4) return;
  const lift = Math.min(26, length * 0.16);
  const steps = Math.floor(length / 2);
  const glow = rgb(tone[2]);
  const spot = (f) => ({ x: Math.round(from.x + dx * f), y: Math.round(from.y + dy * f - Math.sin(f * Math.PI) * lift) });
  // the line itself, in the endpoint's colour, so it is plain which tower a thought goes to
  for (let i = 0; i <= steps; i++) {
    const { x, y } = spot(i / steps);
    R(c, x, y + 1, 2, 1, 'rgba(26, 20, 44, .35)');
    R(c, x, y, 2, 1, `rgba(${glow[0]}, ${glow[1]}, ${glow[2]}, .8)`);
  }
  // the request going out to the endpoint (three bright packets), and the words coming back (white)
  for (let k = 0; k < 3; k++) {
    const out = spot(1 - ((t * 0.9 + k / 3) % 1));
    R(c, out.x - 2, out.y - 2, 5, 5, C.ink);
    R(c, out.x - 1, out.y - 1, 3, 3, tone[3] || tone[2]);
    const back = spot((t * 1.3 + k / 3 + 0.17) % 1);
    R(c, back.x - 1, back.y - 1, 4, 4, C.ink);
    R(c, back.x, back.y, 2, 2, C.white);
  }
}

// ---- sandbox effects on a house ---------------------------------------------------------------

// A sandbox starting: a green scan line climbs the house, as if it were being put back together.
export function drawWakeFx(c, v, age) {
  const top = houseTop(v);
  const height = v.door.y - top;
  const f = Math.min(1, age / 0.9);
  const y = Math.round(v.door.y - height * f);
  const half = v.style === 'tower' ? 34 : 50;
  R(c, v.door.x - half, y, half * 2, 1, C.modal[3]);
  R(c, v.door.x - half, y + 1, half * 2, 1, C.modal[2]);
  for (let i = 0; i < 14; i++) {
    const px = v.door.x - half + ((i * 37 + Math.floor(age * 40)) % (half * 2));
    R(c, px, y + 2 + ((i * 7) % 9), 1, 2, i % 2 ? C.modal[2] : C.modal[1]);
  }
}

// A snapshot being taken: corner brackets close in on the house like a camera frame, then flash.
export function drawSnapFx(c, v, age) {
  const top = houseTop(v) - 4;
  const half = (v.style === 'tower' ? 36 : 52) + Math.round(Math.max(0, 1 - age / 0.35) * 10);
  const left = v.door.x - half;
  const right = v.door.x + half;
  const bottom = v.door.y + 6;
  const color = age > 0.35 && age < 0.55 ? C.white : '#b4e2f8';
  for (const [cx, cy, sx, sy] of [[left, top, 1, 1], [right, top, -1, 1], [left, bottom, 1, -1], [right, bottom, -1, -1]]) {
    R(c, sx > 0 ? cx : cx - 9, cy, 10, 2, color);
    R(c, cx, sy > 0 ? cy : cy - 9, 2, 10, color);
  }
  if (age > 0.35 && age < 0.5) {
    c.fillStyle = 'rgba(255, 255, 255, .35)';
    c.fillRect(left, top, half * 2, bottom - top);
  }
}

// ---- things on shelves ----------------------------------------------------------------------

export function kindOf(entry) {
  if (entry.type === 'dir') return entry.name === 'mailbox' ? 'mailbag' : entry.name === 'gifts' ? 'present' : 'crate';
  const ext = (entry.name.split('.').pop() || '').toLowerCase();
  if (['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'picture';
  if (['py', 'sh', 'js', 'c', 'rb'].includes(ext)) return 'program';
  if (['html', 'htm', 'css'].includes(ext)) return 'page';
  if (['json', 'csv', 'toml', 'yaml', 'yml', 'pid', 'log'].includes(ext)) return 'jar';
  return 'book';
}

const BOOKS = ['#d6553f', '#2f9e8f', '#8d6cc0', '#e8a82d', '#4d7ea8', '#c9577a'];

// (x, y) is the middle of the thing's base.
export function drawThing(c, x, y, kind, { sprite = null, seed = 0, highlight = false, t = 0 } = {}) {
  x = Math.round(x);
  y = Math.round(y);
  if (kind === 'crate') {
    box(c, x - 8, y - 12, 16, 12, C.wood[3]);
    R(c, x - 7, y - 11, 14, 1, C.wood[4]);
    R(c, x - 7, y - 7, 14, 1, C.wood[1]);
    R(c, x - 3, y - 11, 1, 10, C.wood[1]);
    R(c, x + 2, y - 11, 1, 10, C.wood[1]);
    R(c, x - 7, y - 2, 14, 1, C.wood[2]);
  } else if (kind === 'mailbag') {
    box(c, x - 7, y - 11, 14, 11, '#b08a5a');
    R(c, x - 6, y - 10, 12, 1, '#d1ab78');
    box(c, x - 5, y - 15, 10, 7, C.white);
    R(c, x - 3, y - 13, 6, 1, '#e0483e');
    R(c, x - 6, y - 5, 12, 1, C.wood[1]);
  } else if (kind === 'present') {
    box(c, x - 7, y - 10, 14, 10, '#e0607a');
    R(c, x - 1, y - 9, 2, 8, C.glow);
    R(c, x - 6, y - 6, 12, 2, C.glow);
    box(c, x - 4, y - 14, 4, 5, C.glow);
    box(c, x, y - 14, 4, 5, C.glow);
  } else if (kind === 'picture') {
    box(c, x - 8, y - 16, 16, 16, C.wood[2]);
    R(c, x - 7, y - 15, 14, 1, C.wood[4]);
    R(c, x - 6, y - 14, 12, 12, C.white);
    if (sprite) c.drawImage(sprite, x - Math.floor(sprite.width / 2), y - 8 - Math.floor(sprite.height / 2));
    else {
      R(c, x - 6, y - 14, 12, 7, '#a8dcf6');
      R(c, x - 6, y - 6, 12, 4, C.grass[2]);
      R(c, x - 3, y - 9, 4, 3, C.grass[1]);
      R(c, x + 2, y - 13, 2, 2, C.glow);
    }
  } else if (kind === 'program') {
    box(c, x - 8, y - 13, 16, 11, '#2b3140');
    R(c, x - 6, y - 11, 12, 7, '#1c2130');
    R(c, x - 5, y - 10, 1, 1, '#7de08f');
    R(c, x - 4, y - 9, 1, 1, '#7de08f');
    R(c, x - 5, y - 8, 1, 1, '#7de08f');
    R(c, x - 2, y - 8, 4, 1, '#7de08f');
    R(c, x - 5, y - 6, 6, 1, '#4d7ea8');
    R(c, x - 3, y - 2, 6, 2, C.ink);
  } else if (kind === 'page') {
    box(c, x - 7, y - 14, 14, 14, C.white);
    R(c, x - 6, y - 13, 12, 3, '#4d7ea8');
    R(c, x - 5, y - 12, 1, 1, '#ffe27a');
    R(c, x - 5, y - 8, 10, 1, '#b9b3c6');
    R(c, x - 5, y - 6, 7, 1, '#b9b3c6');
    R(c, x - 5, y - 4, 9, 1, '#b9b3c6');
  } else if (kind === 'jar') {
    box(c, x - 5, y - 11, 11, 11, '#bfe6f2');
    R(c, x - 4, y - 10, 2, 8, C.white);
    box(c, x - 4, y - 14, 9, 4, C.brick[1]);
    for (const [dx, dy] of [[-2, -3], [1, -2], [3, -4], [0, -6], [-2, -7]]) R(c, x + dx, y + dy, 2, 2, '#e8a82d');
  } else {
    // a book standing on end; the seed picks its colour
    const tone = ramp(BOOKS[seed % BOOKS.length]);
    box(c, x - 5, y - 14, 10, 14, tone[1]);
    R(c, x - 4, y - 13, 2, 12, tone[2]);
    R(c, x + 2, y - 13, 2, 12, tone[0]);
    R(c, x - 2, y - 11, 4, 2, C.white);
    R(c, x - 2, y - 4, 4, 1, C.glow);
  }
  if (highlight && Math.floor(t * 3) % 2 === 0) {
    // the classic blinking selection brackets
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const cx = x + sx * 11;
      const cy = y - 8 + sy * 10;
      R(c, cx - (sx > 0 ? 3 : 0), cy, 4, 1, C.glow);
      R(c, cx, cy - (sy > 0 ? 3 : 0), 1, 4, C.glow);
    }
  }
}

// Turns any picture (the SVGs villagers draw) into a small hard-edged sprite with a dark outline,
// so a gift looks like it belongs in a pixel world.
export function spriteFromImage(image, maxW, maxH, outline = true) {
  if (!image || !image.complete || !image.naturalWidth) return null;
  const scale = Math.min(maxW / image.naturalWidth, maxH / image.naturalHeight);
  const w = Math.max(1, Math.round(image.naturalWidth * scale));
  const h = Math.max(1, Math.round(image.naturalHeight * scale));
  const pad = outline ? 1 : 0;
  const canvas = makeCanvas(w + pad * 2, h + pad * 2);
  const c = canvas.getContext('2d');
  c.imageSmoothingQuality = 'high';
  c.drawImage(image, pad, pad, w, h);
  try {
    const data = c.getImageData(0, 0, canvas.width, canvas.height);
    const px = data.data;
    const solid = new Uint8Array(canvas.width * canvas.height);
    for (let i = 0; i < solid.length; i++) {
      solid[i] = px[i * 4 + 3] > 96 ? 1 : 0;
      px[i * 4 + 3] = solid[i] ? 255 : 0;
      for (let k = 0; k < 3; k++) px[i * 4 + k] = Math.min(255, Math.round(px[i * 4 + k] / 20) * 20); // fewer colours
    }
    if (outline) {
      const ink = rgb(C.ink);
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const i = y * canvas.width + x;
          if (solid[i]) continue;
          const touches = (x > 0 && solid[i - 1]) || (x < canvas.width - 1 && solid[i + 1]) || (y > 0 && solid[i - canvas.width]) || (y < canvas.height - 1 && solid[i + canvas.width]);
          if (touches) px.set([ink[0], ink[1], ink[2], 255], i * 4);
        }
      }
    }
    c.putImageData(data, 0, 0);
  } catch {
    /* a picture the browser won't let us read back: keep the plain scaled copy */
  }
  return canvas;
}

export function drawGift(c, x, y, sprite) {
  x = Math.round(x);
  y = Math.round(y);
  if (!sprite) return drawThing(c, x, y, 'crate');
  E(c, x, y, Math.max(4, Math.floor(sprite.width / 2) - 1), 2, C.shade);
  c.drawImage(sprite, x - Math.floor(sprite.width / 2), y - sprite.height + 1);
}

// ---- inside a house -------------------------------------------------------------------------

const roomSprites = new Map();
const ROOM_LOOK = {
  tower: { wall: '#3b3160', stripe: '#6c4fb3', floor: ['#5a5470', '#77718e', '#8a84a2'], stone: true },
  lab: { wall: '#dfe6ee', stripe: '#b9c3cf', floor: ['#8793a4', '#b9c3cf', '#cdd6e0'], stone: true },
  mushroom: { wall: '#f3e6c8', stripe: '#c23b3b', floor: ['#6b5a3c', '#8a7550', '#9c8660'] },
  caravan: { wall: '#c2483d', stripe: '#e8b33a', floor: C.floor },
  ruin: { wall: '#4a4f66', stripe: '#7f8fb0', floor: ['#5d6274', '#7b8194', '#8e94a6'], stone: true },
  gpu: { wall: '#1f3a2c', stripe: '#7fee64', floor: ['#2a2e36', '#3a3f4a', '#4a505c'], stone: true },
  garage: { wall: '#d9dde4', stripe: '#aab2bf', floor: ['#8a8f99', '#a3a8b2', '#b6bbc4'], stone: true },
};

function roomSprite(v, bare) {
  const key = `${v.id}:${bare}`;
  if (roomSprites.has(key)) return roomSprites.get(key);
  const canvas = makeCanvas(ROOM.w, ROOM.h);
  const c = canvas.getContext('2d');
  const tint = ramp(v.accent);
  const rug = ramp(v.color);
  const look = ROOM_LOOK[v.style] || { wall: C.wall[2], stripe: mix(tint[2], C.wall[2], 0.35), floor: C.floor };

  R(c, 0, 0, ROOM.w, ROOM.h, '#1d1830');
  R(c, 7, 3, 274, 185, C.ink);
  R(c, 8, 4, 272, 183, '#6f5646');
  R(c, 8, 4, 272, 2, '#8d7260');

  // back wall
  R(c, 16, 8, 256, 44, bare ? '#cfc9bd' : look.wall);
  if (!bare) {
    if (v.style === 'tower') {
      const rand = seeded(9);
      for (let i = 0; i < 26; i++) {
        const x = 20 + Math.floor(rand() * 248);
        const y = 10 + Math.floor(rand() * 26);
        R(c, x, y, 1, 3, C.glow);
        R(c, x - 1, y + 1, 3, 1, C.glow);
      }
    } else if (v.style === 'lab') {
      for (let x = 16; x < 272; x += 32) R(c, x, 8, 1, 36, look.stripe);
      for (let x = 24; x < 272; x += 32) R(c, x, 14, 2, 2, C.steel[0]);
    } else if (v.style === 'mushroom') {
      // the underside of the cap: gills, and a few spots showing through
      for (let x = 18; x < 272; x += 6) R(c, x, 8, 1, 36, '#dcc9a3');
      for (const [x, y, r] of [[52, 20, 6], [120, 28, 4], [190, 18, 7], [244, 30, 4]]) E(c, x, y, r, r - 1, look.stripe);
    } else if (v.style === 'caravan') {
      for (let x = 16; x < 272; x += 16) R(c, x, 8, 8, 36, look.stripe);
      for (let i = 0; i < 16; i++) {
        const color = ['#4d7ea8', '#58a858', '#f1eee6'][i % 3];
        R(c, 20 + i * 16, 10, 7, 3, color);
        R(c, 22 + i * 16, 13, 3, 2, color);
      }
    } else if (v.style === 'ruin') {
      // old stone, a gap in the wall with stars through it
      for (let y = 14; y < 44; y += 7) R(c, 16, y, 256, 1, '#3a3f55');
      for (let x = 22; x < 272; x += 19) R(c, x, 8, 1, 36, '#3a3f55');
      R(c, 150, 8, 44, 30, '#141a33');
      R(c, 146, 30, 8, 8, '#141a33');
      for (const [x, y] of [[158, 14], [170, 24], [182, 12], [188, 30], [164, 32]]) R(c, x, y, 1, 1, C.white);
    } else {
      for (let x = 20; x < 272; x += 8) R(c, x, 8, 2, 36, look.stripe);
      for (let x = 24; x < 272; x += 16) R(c, x - 1, 16, 1, 1, tint[1]);
    }
  }
  R(c, 16, 8, 256, 2, bare ? '#b3ad9f' : mix(look.wall, C.ink, 0.25));
  R(c, 16, 44, 256, 8, C.wood[2]);
  R(c, 16, 44, 256, 1, C.wood[4]);
  R(c, 16, 51, 256, 1, C.wood[0]);
  for (let x = 32; x < 272; x += 16) R(c, x, 45, 1, 6, C.wood[1]);

  // floor: planks, or flagstones for the tower and the lab
  const floor = bare ? ['#9c8f7d', '#b8ab98', '#c4b7a3'] : look.floor;
  for (let row = 0; row < 16; row++) {
    const y = 52 + row * 8;
    R(c, 16, y, 256, 8, row % 2 ? floor[1] : floor[2]);
    R(c, 16, y + 7, 256, 1, floor[0]);
    const step = look.stone && !bare ? 24 : 44;
    for (let x = 16 + ((row * 20) % step); x < 272; x += step) R(c, x, y, 1, 7, floor[0]);
  }
  R(c, 16, 52, 256, 2, 'rgba(26, 20, 44, .18)');

  // the long shelf
  R(c, 25, 39, 238, 6, C.ink);
  R(c, 26, 40, 236, 4, C.wood[3]);
  R(c, 26, 40, 236, 1, C.wood[4]);
  R(c, 26, 43, 236, 1, C.wood[1]);
  for (let x = 34; x < 262; x += 38) {
    R(c, x, 44, 3, 5, C.ink);
    R(c, x + 1, 44, 1, 4, C.wood[2]);
  }

  if (!bare) {
    E(c, 144, 132, 50, 17, C.ink);
    E(c, 144, 132, 49, 16, rug[1]);
    E(c, 144, 132, 43, 13, rug[2]);
    E(c, 144, 132, 39, 11, rug[1]);
    for (let i = -3; i <= 3; i++) R(c, 143 + i * 10, 131, 3, 3, i % 2 ? rug[2] : C.white);
  }

  // table and desk: a lit top face and a darker front face
  for (const [x, y, w] of [[96, 88, 80], [220, 82, 44]]) {
    E(c, x + w / 2, y + 26, w / 2 + 2, 3, C.shade);
    R(c, x - 1, y - 1, w + 2, 23, C.ink);
    R(c, x, y, w, 15, C.wood[3]);
    R(c, x, y, w, 1, C.wood[4]);
    R(c, x, y + 15, w, 6, C.wood[1]);
    R(c, x + 2, y + 21, 3, 4, C.ink);
    R(c, x + w - 5, y + 21, 3, 4, C.ink);
  }

  // door mat and the doorway in the front wall
  R(c, 126, 180, 36, 8, '#1d1830');
  box(c, 127, 168, 34, 10, '#5fae5a');
  R(c, 129, 170, 30, 6, '#7cc76a');
  R(c, 131, 172, 26, 2, '#5fae5a');
  roomSprites.set(key, canvas);
  return canvas;
}

export function drawRoom(c, v, t, bare) {
  c.drawImage(roomSprite(v, bare), 0, 0); // what stands on the desk, and the rest of the room's life, is in rooms.js
}

// ---- things in the village that are really files in a sandbox --------------------------------

function drawCrop(c, x, y, kind, t) {
  const sway = Math.floor(t * 1.5 + x) % 4 === 0 ? 1 : 0;
  if (kind === 'sunflower') {
    R(c, x, y - 9, 1, 9, C.leaf[1]);
    R(c, x - 2, y - 5, 2, 1, C.leaf[2]);
    box(c, x - 3 + sway, y - 15, 7, 7, C.glow);
    R(c, x - 1 + sway, y - 13, 3, 3, C.wood[1]);
  } else if (kind === 'tulip' || kind === 'rose') {
    R(c, x, y - 6, 1, 6, C.leaf[1]);
    R(c, x + 1, y - 3, 2, 1, C.leaf[2]);
    box(c, x - 2 + sway, y - 11, 5, 6, kind === 'rose' ? '#d1493f' : '#f08bb0');
    R(c, x - 1 + sway, y - 10, 1, 2, kind === 'rose' ? '#f08b7a' : '#ffd1dc');
  } else if (kind === 'pumpkin') {
    box(c, x - 4, y - 6, 9, 7, '#e8912d');
    R(c, x - 1, y - 5, 1, 5, '#c26f1c');
    R(c, x + 1, y - 5, 1, 5, '#c26f1c');
    R(c, x, y - 8, 1, 3, C.leaf[0]);
    R(c, x + 1, y - 8, 2, 1, C.leaf[1]);
  } else if (kind === 'cabbage') {
    box(c, x - 4, y - 6, 9, 7, C.leaf[2]);
    R(c, x - 2, y - 4, 5, 3, C.leaf[3]);
    R(c, x, y - 3, 1, 1, C.white);
  } else if (kind === 'carrot') {
    R(c, x - 2, y - 7, 1, 5, C.leaf[1]);
    R(c, x, y - 8, 1, 6, C.leaf[2]);
    R(c, x + 2, y - 7, 1, 5, C.leaf[1]);
    box(c, x - 2, y - 3, 5, 4, '#e8912d');
  } else if (kind === 'mushroom') {
    R(c, x - 1, y - 3, 3, 3, C.white);
    box(c, x - 4, y - 8, 9, 6, '#d1493f');
    R(c, x - 2, y - 6, 2, 1, C.white);
    R(c, x + 2, y - 5, 1, 1, C.white);
  } else {
    // bean (and anything unrecognised): a pole with leaves
    R(c, x, y - 13, 1, 13, C.wood[2]);
    for (let i = 0; i < 4; i++) R(c, x + (i % 2 ? 1 : -2), y - 3 - i * 3, 2, 2, i % 2 ? C.leaf[3] : C.leaf[2]);
  }
}

// The gardener's plot. `crops` is the contents of garden.txt, one plant to a line.
export function drawGarden(c, plot, crops, t) {
  R(c, plot.x - 2, plot.y - 2, plot.w + 4, plot.h + 4, C.ink);
  R(c, plot.x - 1, plot.y - 1, plot.w + 2, plot.h + 2, C.wood[2]);
  R(c, plot.x, plot.y, plot.w, plot.h, '#6b4a34');
  for (let row = 0; row < 2; row++) {
    R(c, plot.x, plot.y + 5 + row * 12, plot.w, 2, '#553826');
    R(c, plot.x, plot.y + 8 + row * 12, plot.w, 1, '#84604a');
  }
  for (const x of [plot.x - 2, plot.x + plot.w]) {
    for (const y of [plot.y - 5, plot.y + plot.h - 3]) {
      R(c, x, y, 2, 6, C.ink);
      R(c, x, y, 1, 5, C.wood[4]);
    }
  }
  crops.slice(0, 8).forEach((kind, index) => {
    drawCrop(c, plot.x + 6 + (index % 4) * 11, plot.y + 11 + Math.floor(index / 4) * 12, kind, t);
  });
}

// A pedestal on the lane, with one of the tinkerer's pieces on it (or nothing yet).
export function drawPedestal(c, x, y, sprite) {
  E(c, x, y + 1, 9, 3, C.shade);
  box(c, x - 8, y - 5, 17, 7, C.stone[1]);
  R(c, x - 7, y - 4, 15, 1, C.stone[2]);
  box(c, x - 6, y - 10, 13, 6, C.stone[2]);
  R(c, x - 5, y - 9, 11, 1, C.white);
  if (sprite) c.drawImage(sprite, x - Math.floor(sprite.width / 2), y - 9 - sprite.height);
}

// Music hanging in the air above whoever is playing.
export function drawNotes(c, x, y, t) {
  for (let i = 0; i < 4; i++) {
    const phase = (t * 0.55 + i / 4) % 1;
    const nx = Math.round(x + 6 + i * 6 + Math.sin(phase * 6 + i * 2) * 5);
    const ny = Math.round(y - 32 - phase * 30);
    const color = [C.gold, C.white, '#9be8ff', '#ffc2d4'][i];
    // outline first, so a note shows against a red wall as well as the sky
    R(c, nx - 3, ny + 3, 5, 5, C.ink);
    R(c, nx, ny - 1, 3, 8, C.ink);
    R(c, nx + 1, ny - 1, 5, 4, C.ink);
    R(c, nx - 2, ny + 4, 3, 3, color);
    R(c, nx + 1, ny, 1, 6, color);
    R(c, nx + 2, ny, 3, 2, color);
  }
}

// ---- weather ----------------------------------------------------------------------------------

// Painted over the whole view. `view` is {x, y, w, h} in game pixels.
export function drawWeather(c, view, kind, t) {
  if (kind === 'rain' || kind === 'storm') {
    const drops = kind === 'storm' ? 120 : 70;
    c.fillStyle = kind === 'storm' ? 'rgba(30, 42, 90, .26)' : 'rgba(46, 70, 120, .15)';
    c.fillRect(view.x, view.y, view.w, view.h);
    for (let i = 0; i < drops; i++) {
      const fx = hash(i, 7);
      const fy = hash(i, 13);
      const speed = 150 + fx * 80;
      const y = ((fy * view.h + t * speed) % (view.h + 16)) - 8;
      const span = view.w + 60;
      const x = ((((fx * span - t * speed * 0.35) % span) + span) % span) - 30;
      R(c, view.x + x, view.y + y, 1, 4, 'rgba(200, 226, 255, .8)');
      R(c, view.x + x - 1, view.y + y + 4, 1, 2, 'rgba(200, 226, 255, .5)');
    }
    if (kind === 'storm' && t % 7 < 0.12) {
      c.fillStyle = 'rgba(255, 255, 255, .4)';
      c.fillRect(view.x, view.y, view.w, view.h);
    }
  } else if (kind === 'snow') {
    c.fillStyle = 'rgba(226, 238, 255, .16)';
    c.fillRect(view.x, view.y, view.w, view.h);
    for (let i = 0; i < 70; i++) {
      const fx = hash(i, 3);
      const fy = hash(i, 17);
      const y = ((fy * view.h + t * (16 + fx * 16)) % (view.h + 8)) - 4;
      const x = fx * view.w + Math.sin(t * 0.8 + i) * 6;
      R(c, view.x + x, view.y + y, i % 3 ? 1 : 2, i % 3 ? 1 : 2, C.white);
    }
  } else if (kind === 'fog') {
    c.fillStyle = 'rgba(232, 238, 244, .14)';
    c.fillRect(view.x, view.y, view.w, view.h);
    for (let i = 0; i < 6; i++) {
      const y = view.y + (i * view.h) / 6 + Math.sin(t * 0.2 + i) * 6;
      const drift = ((t * 5 + i * 70) % 90) - 45;
      c.fillStyle = 'rgba(240, 244, 248, .2)';
      c.fillRect(view.x - 45 + drift, Math.round(y), view.w + 90, 12 + (i % 3) * 7);
    }
  } else if (kind === 'blossom') {
    for (let i = 0; i < 46; i++) {
      const fx = hash(i, 5);
      const fy = hash(i, 23);
      const y = ((fy * view.h + t * (14 + fx * 12)) % (view.h + 8)) - 4;
      const span = view.w + 40;
      const x = ((((fx * span + t * 9 + Math.sin(t + i) * 8) % span) + span) % span) - 20;
      R(c, view.x + x, view.y + y, 2, 1, i % 2 ? '#ffc2d4' : '#ffe1ea');
      R(c, view.x + x + 1, view.y + y + 1, 1, 1, '#f08bb0');
    }
  }
}

// ---- night ----------------------------------------------------------------------------------

const glowSprites = new Map();

function glowSprite(radius, color) {
  const key = `${radius}:${color}`;
  if (glowSprites.has(key)) return glowSprites.get(key);
  const canvas = makeCanvas(radius * 2 + 1, radius * 2 + 1);
  const c = canvas.getContext('2d');
  const [r, g, b] = rgb(color);
  // three flat bands, not a smooth gradient: it should read as pixel-art light
  for (const [scale, alpha] of [[1, 0.07], [0.68, 0.09], [0.4, 0.12]]) {
    E(c, radius, radius, Math.round(radius * scale), Math.round(radius * scale * 0.8), `rgba(${r}, ${g}, ${b}, ${alpha})`);
  }
  glowSprites.set(key, canvas);
  return canvas;
}

// Darkens the scene, then adds pools of light back in. `lights` are {x, y, radius, color}.
export function drawNight(c, view, darkness, lights, t) {
  if (darkness <= 0.01) return;
  c.fillStyle = `rgba(22, 26, 92, ${(darkness * 0.56).toFixed(3)})`;
  c.fillRect(view.x, view.y, view.w, view.h);
  c.globalCompositeOperation = 'lighter';
  c.globalAlpha = Math.min(1, darkness * 1.6);
  for (const light of lights) {
    const sprite = glowSprite(light.radius, light.color);
    c.drawImage(sprite, Math.round(light.x - light.radius), Math.round(light.y - light.radius));
  }
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
  // fireflies
  for (let i = 0; i < 18; i++) {
    const phase = t * 0.3 + i * 1.7;
    const x = Math.round(((i * 97.3) % WORLD.w) + Math.sin(phase) * 14);
    const y = Math.round(90 + ((i * 61.7) % (WORLD.h - 120)) + Math.cos(phase * 1.3) * 9);
    if (Math.sin(phase * 3 + i) > 0.2) {
      c.fillStyle = `rgba(255, 240, 150, ${Math.min(1, darkness * 2).toFixed(2)})`;
      c.fillRect(x, y, 1, 1);
    }
  }
}

export { C, R, E, EO, box, mix, hash, makeCanvas };
