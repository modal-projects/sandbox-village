// Scenery: the landmarks that stand for a piece of Modal, and the small things that make the
// village feel lived in (lamps, a dock, bushes, butterflies, a balloon). Drawn in code with the
// same whole-pixel primitives as everything else.

import { BEACONS, C, E, EO, GREENS, LAMPS, PEDESTALS, PLACES, POND, R, WORLD, box, hash, ramp, roadDistance, seeded } from './art.js';

const MODAL_BLACK = '#181818';

// ---- the snapshot cellar ------------------------------------------------------------------------

// One crystal per villager: lit when a snapshot of their home exists.
function drawCrystal(c, x, y, crystal, t, i) {
  if (!crystal.lit) {
    R(c, x + 1, y + 6, 4, 1, '#4a4060'); // an empty stand
    return;
  }
  const tone = ramp(crystal.color);
  R(c, x + 2, y, 2, 1, C.ink);
  R(c, x + 1, y + 1, 4, 1, C.ink);
  R(c, x, y + 2, 6, 3, C.ink);
  R(c, x + 1, y + 5, 4, 1, C.ink);
  R(c, x + 2, y + 6, 2, 1, C.ink);
  R(c, x + 2, y + 1, 2, 1, tone[2]);
  R(c, x + 1, y + 2, 4, 3, tone[1]);
  R(c, x + 2, y + 5, 2, 1, tone[0]);
  R(c, x + 1, y + 2, 1, 2, tone[2]);
  R(c, x + 4, y + 3, 1, 2, tone[0]);
  if (crystal.fresh ? Math.floor(t * 8) % 2 : Math.floor(t * 2 + i * 1.7) % 9 === 0) R(c, x + 2, y + 2, 2, 1, C.white);
  if (crystal.fresh) {
    R(c, x + 2, y - 3, 2, 2, C.white);
    R(c, x - 1, y + 3, 1, 1, C.white);
    R(c, x + 6, y + 1, 1, 1, C.white);
  }
}

// crystals: [{ color, lit, fresh }] in villager order
export function drawCellar(c, at, crystals, t) {
  const { x, y } = at;
  E(c, x + 14, y + 1, 42, 4, C.shade);
  // a stone hut, half sunk, under a turf roof
  box(c, x - 22, y - 26, 44, 27, C.stone[1]);
  R(c, x - 21, y - 25, 2, 25, C.stone[2]);
  R(c, x + 18, y - 25, 3, 25, C.stone[0]);
  for (let row = 0; row < 4; row++) {
    const yy = y - 19 + row * 6;
    R(c, x - 21, yy, 42, 1, C.stone[0]);
    for (let col = 0; col < 5; col++) R(c, x - 17 + col * 9 + (row % 2) * 4, yy - 5, 1, 5, C.stone[0]);
  }
  R(c, x - 26, y - 35, 52, 11, C.ink);
  R(c, x - 25, y - 34, 50, 9, C.leaf[1]);
  R(c, x - 25, y - 34, 50, 2, C.leaf[3]);
  R(c, x - 25, y - 27, 50, 2, C.leaf[0]);
  for (let i = 0; i < 9; i++) {
    R(c, x - 23 + i * 6, y - 37 - (i % 2), 2, 3 + (i % 2), C.ink);
    R(c, x - 23 + i * 6, y - 36 - (i % 2), 1, 2 + (i % 2), C.leaf[2]);
  }
  for (const [dx, color] of [[-14, '#ffc2d4'], [3, '#fff6e0'], [17, '#ffe27a']]) R(c, x + dx, y - 32, 2, 2, color);
  for (let i = 0; i < 7; i++) R(c, x - 20 + i * 6 + (i % 2), y - 25, 1, 2 + ((i * 7) % 3), '#d6f4ff'); // icicles
  // the cold door
  R(c, x - 9, y - 21, 18, 22, C.ink);
  R(c, x - 8, y - 20, 16, 20, '#5fb4dc');
  R(c, x - 8, y - 20, 16, 2, '#b4e2f8');
  R(c, x - 8, y - 20, 2, 20, '#8fd3f0');
  R(c, x, y - 20, 1, 20, '#3f8fc0');
  for (const sx of [x - 4, x + 4]) {
    R(c, sx - 1, y - 13, 3, 1, C.white);
    R(c, sx, y - 14, 1, 3, C.white);
  }
  R(c, x - 2, y - 8, 1, 3, C.ink);
  R(c, x + 2, y - 8, 1, 3, C.ink);
  R(c, x - 11, y, 22, 3, C.ink);
  R(c, x - 10, y, 20, 2, C.stone[2]);
  // cold air creeping out under the door
  for (let i = 0; i < 3; i++) {
    const drift = (t * 5 + i * 9) % 18;
    c.fillStyle = `rgba(214, 244, 255, ${(0.5 * (1 - drift / 18)).toFixed(2)})`;
    c.fillRect(x - 8 + i * 6, Math.round(y + 3 + drift * 0.3), 5, 2);
  }

  // the rack beside it
  const rx = x + 28;
  const ry = y - 32;
  R(c, rx + 1, y, 2, 2, C.ink);
  R(c, rx + 22, y, 2, 2, C.ink);
  box(c, rx, ry, 25, 33, C.wood[1]);
  R(c, rx + 1, ry + 1, 23, 31, '#2b2340');
  for (let row = 0; row < 3; row++) R(c, rx + 1, ry + 9 + row * 10, 23, 2, C.wood[3]);
  crystals.slice(0, 9).forEach((crystal, i) => drawCrystal(c, rx + 3 + (i % 3) * 7, ry + 2 + Math.floor(i / 3) * 10, crystal, t, i));
}

// ---- the watchman's bell -------------------------------------------------------------------------

export function drawBell(c, at, t, ringing) {
  const { x, y } = at;
  E(c, x, y + 1, 14, 3, C.shade);
  for (const px of [x - 9, x + 6]) {
    R(c, px, y - 34, 4, 27, C.ink);
    R(c, px + 1, y - 33, 2, 25, C.wood[2]);
    R(c, px + 1, y - 33, 1, 25, C.wood[3]);
  }
  R(c, x - 9, y - 31, 19, 3, C.ink);
  R(c, x - 8, y - 30, 17, 1, C.wood[3]);
  // a small roof, in Modal green
  for (let row = 0; row < 8; row++) {
    const half = 3 + row * 2;
    R(c, x - half - 1, y - 43 + row, half * 2 + 2, 2, C.ink);
    R(c, x - half, y - 43 + row, half * 2, 1, row < 2 ? C.modal[2] : row < 5 ? C.modal[1] : C.modal[0]);
  }
  // the bell swings when it rings
  const swing = ringing ? (Math.floor(t * 8) % 2 ? 2 : -2) : 0;
  R(c, x, y - 28, 1, 3, C.ink);
  box(c, x - 4 + swing, y - 26, 9, 8, C.gold);
  R(c, x - 3 + swing, y - 25, 2, 5, '#fff1b0');
  R(c, x - 5 + swing, y - 19, 11, 2, C.ink);
  R(c, x - 4 + swing, y - 19, 9, 1, '#c8922a');
  R(c, x - 1 - swing, y - 17, 2, 2, C.ink);
  if (ringing) {
    const phase = Math.floor(t * 6) % 3;
    for (const s of [-1, 1]) {
      R(c, x + s * (13 + phase * 3), y - 25, 1, 5, C.white);
      R(c, x + s * (12 + phase * 3), y - 26, 1, 1, C.white);
      R(c, x + s * (12 + phase * 3), y - 20, 1, 1, C.white);
    }
  }
  // the plinth, with a clock on it
  box(c, x - 11, y - 9, 22, 10, C.stone[1]);
  R(c, x - 10, y - 8, 20, 1, C.stone[2]);
  R(c, x + 7, y - 7, 3, 7, C.stone[0]);
  EO(c, x, y - 4, 3, 3, C.white);
  const angle = t * 0.7;
  R(c, x + Math.round(Math.cos(angle) * 2), y - 4 + Math.round(Math.sin(angle) * 2), 1, 1, C.ink);
  R(c, x, y - 6, 1, 2, '#b0393f');
  R(c, x, y - 4, 1, 1, C.ink);
}

// ---- the GPU patch ---------------------------------------------------------------------------------

function drawGpu(c, x, y, t, busy, i) {
  R(c, x, y - 4, 1, 4, C.leaf[1]);
  R(c, x - 2, y - 2, 2, 1, C.leaf[2]);
  R(c, x + 1, y - 3, 2, 1, C.leaf[2]);
  box(c, x - 7, y - 13, 15, 10, '#20362a');
  R(c, x - 6, y - 12, 13, 1, '#2f5a40');
  R(c, x - 5, y - 11, 11, 6, '#2b3140');
  const fx = x - 2;
  const fy = y - 8;
  E(c, fx, fy, 2, 2, '#5d6878');
  const spin = Math.floor(t * (busy ? 16 : 2.5) + i) % 4;
  const blade = '#cdd6e0';
  if (spin === 0) R(c, fx, fy - 2, 1, 5, blade);
  else if (spin === 2) R(c, fx - 2, fy, 5, 1, blade);
  else {
    const s = spin === 1 ? 1 : -1;
    R(c, fx - 1, fy - s, 1, 1, blade);
    R(c, fx, fy, 1, 1, blade);
    R(c, fx + 1, fy + s, 1, 1, blade);
  }
  R(c, x + 2, y - 10, 3, 1, '#46557e');
  R(c, x + 2, y - 8, 3, 1, '#46557e');
  R(c, x + 5, y - 12, 1, 1, busy && Math.floor(t * 6 + i) % 2 ? C.modal[2] : '#2c6a41');
  R(c, x - 5, y - 4, 8, 1, C.gold);
  if (busy) {
    const rise = (t * 9 + i * 5) % 9;
    c.fillStyle = `rgba(255, 255, 255, ${(0.55 * (1 - rise / 9)).toFixed(2)})`;
    c.fillRect(x + 3 - (i % 2) * 6, Math.round(y - 15 - rise), 1, 2);
  }
}

// Graphics cards, grown like cabbages. Their fans spin up while a villager is thinking.
export function drawGpuPatch(c, at, t, busy) {
  const { x, y } = at;
  R(c, x - 32, y - 33, 64, 34, C.ink);
  R(c, x - 31, y - 32, 62, 32, '#6b4a34');
  for (let row = 0; row < 3; row++) {
    R(c, x - 31, y - 27 + row * 11, 62, 2, '#553826');
    R(c, x - 31, y - 24 + row * 11, 62, 1, '#84604a');
  }
  for (let i = 0; i < 6; i++) drawGpu(c, x - 20 + (i % 3) * 20, y - 17 + Math.floor(i / 3) * 13, t, busy, i);
  // a low fence along the front and sides
  for (let i = 0; i <= 6; i++) {
    const px = x - 31 + Math.round(i * 10.2);
    R(c, px - 1, y - 6, 3, 8, C.ink);
    R(c, px, y - 5, 1, 6, C.wood[4]);
  }
  R(c, x - 31, y - 3, 62, 1, C.wood[3]);
  for (const px of [x - 32, x + 31]) for (const py of [y - 34, y - 20]) {
    R(c, px - 1, py - 4, 3, 8, C.ink);
    R(c, px, py - 3, 1, 6, C.wood[4]);
  }
}

// ---- the image yard ------------------------------------------------------------------------------------

function container(c, x, y, tone, mark) {
  box(c, x, y, 30, 13, tone[1]);
  R(c, x + 1, y + 1, 28, 1, tone[2]);
  R(c, x + 1, y + 11, 28, 1, tone[0]);
  for (let i = 0; i < 9; i++) R(c, x + 2 + i * 3, y + 2, 1, 9, tone[0]);
  R(c, x + 25, y + 2, 1, 9, C.ink);
  R(c, x + 27, y + 4, 1, 5, C.steel[2]);
  if (mark) {
    R(c, x + 3, y + 2, mark.width + 2, 9, tone[1]);
    c.drawImage(mark, x + 4, y + 2 + Math.floor((9 - mark.height) / 2));
  }
}

// Shipping containers: every home starts from the same container image.


// A mound with a stone mouth: the one way into the village from the internet.

export function drawYard(c, at, mark) {
  const { x, y } = at;
  E(c, x, y + 1, 36, 3, C.shade);
  container(c, x - 31, y - 13, ramp('#3b3f4c'), mark);
  container(c, x + 1, y - 13, ramp(C.modal[1]), null);
  container(c, x - 15, y - 26, ramp('#ece6d6'), mark);
  // a crate and a cone
  box(c, x + 33, y - 8, 9, 9, C.wood[3]);
  R(c, x + 34, y - 7, 7, 1, C.wood[4]);
  R(c, x + 37, y - 7, 1, 7, C.wood[1]);
  R(c, x - 39, y - 2, 6, 3, C.ink);
  R(c, x - 38, y - 6, 4, 5, '#f08a24');
  R(c, x - 37, y - 8, 2, 2, '#f08a24');
  R(c, x - 38, y - 4, 4, 1, C.white);
}

// ---- the road in -----------------------------------------------------------------------------------------

// Two posts and a board over the road. The words on it are drawn by the game as labels.
// Mo's screen: an arcade cabinet in Modal's colours, with the game running on it.
export function drawArcade(c, at, t, near) {
  const { x, y } = at;
  E(c, x, y + 1, 15, 3, C.shade);
  R(c, x - 13, y - 40, 26, 41, C.ink);
  R(c, x - 12, y - 39, 24, 39, '#22252b');
  R(c, x - 12, y - 39, 24, 2, '#3a3f4a');
  R(c, x + 9, y - 37, 3, 36, '#16181d');
  // marquee
  R(c, x - 10, y - 37, 20, 5, '#7fee64');
  R(c, x - 7, y - 36, 5, 3, '#181818');
  R(c, x - 1, y - 36, 5, 3, '#181818');
  // screen
  R(c, x - 10, y - 30, 20, 15, C.ink);
  R(c, x - 9, y - 29, 18, 13, '#0d1512');
  const wall = near ? '#62de61' : '#3d7a3a';
  for (const [dx, dy, w, h] of [[-8, -28, 16, 1], [-8, -18, 16, 1], [-8, -28, 1, 11], [7, -28, 1, 11], [-5, -25, 4, 1], [1, -25, 4, 1], [-5, -22, 1, 3], [-2, -21, 6, 1]]) R(c, x + dx, y + dy, w, h, wall);
  for (const [dx, dy] of [[-6, -27], [4, -27], [-6, -20], [5, -23]]) R(c, x + dx, y + dy, 1, 1, '#d6ffc9');
  R(c, x - 1 + (Math.floor(t * 3) % 2), y - 24, 2, 2, '#7fee64');
  R(c, x + 3, y - 20, 2, 2, '#bfe6ff');
  // controls
  R(c, x - 11, y - 14, 22, 5, '#3a3f4a');
  R(c, x - 7, y - 16, 2, 4, C.ink);
  R(c, x - 8, y - 17, 4, 2, '#e0685c');
  R(c, x + 2, y - 13, 2, 2, '#7fee64');
  R(c, x + 6, y - 13, 2, 2, '#ffdf70');
  R(c, x - 6, y - 6, 12, 1, '#3a3f4a');
}

// The village register: a big book on a lectern, under a small roof.
export function drawRegister(c, at, t) {
  const { x, y } = at;
  E(c, x, y + 1, 11, 3, C.shade);
  for (const px of [x - 8, x + 6]) {
    R(c, px, y - 22, 3, 23, C.ink);
    R(c, px + 1, y - 21, 1, 21, C.wood[2]);
  }
  for (let row = 0; row < 5; row++) {
    R(c, x - 12 + row, y - 27 + row, 25 - row * 2, 1, C.ink);
    if (row) R(c, x - 11 + row, y - 27 + row, 23 - row * 2, 1, row % 2 ? '#2f9e8f' : '#237a6e');
  }
  R(c, x - 2, y - 12, 5, 13, C.ink);
  R(c, x - 1, y - 11, 3, 11, C.wood[1]);
  R(c, x - 8, y - 17, 17, 7, C.ink);
  R(c, x - 7, y - 16, 15, 5, C.white);
  R(c, x, y - 16, 1, 5, '#b9b3c6');
  for (let i = 0; i < 2; i++) {
    R(c, x - 6, y - 15 + i * 2, 5, 1, '#8793a4');
    R(c, x + 2, y - 15 + i * 2, 5, 1, '#8793a4');
  }
  if (Math.floor(t * 2) % 2) R(c, x + 5, y - 13, 1, 1, '#7fee64'); // a line being written
}

// The library: a little open-fronted book house on a stone step, with a green roof. The books
// on its shelves are the villagers' own colours; `count` of them are there.
export function drawLibrary(c, at, t, spines = [], mark = null) {
  const { x, y } = at;
  E(c, x, y + 1, 21, 4, C.shade);
  // the step
  box(c, x - 20, y - 5, 40, 6, C.stone[1]);
  R(c, x - 19, y - 4, 38, 1, C.stone[2]);
  R(c, x + 14, y - 3, 5, 3, C.stone[0]);
  // the case
  box(c, x - 17, y - 36, 34, 32, C.wood[1]);
  R(c, x - 16, y - 35, 1, 30, C.wood[3]);
  R(c, x + 14, y - 35, 2, 30, C.wood[0]);
  R(c, x - 14, y - 33, 28, 27, '#2a2238');
  // three shelves of books
  for (let row = 0; row < 3; row++) {
    const top = y - 33 + row * 9;
    R(c, x - 14, top + 8, 28, 1, C.wood[2]);
    for (let i = 0; i < 9; i++) {
      const spine = spines[row * 9 + i];
      if (!spine) continue;
      const tall = 5 + ((i * 7 + row * 3) % 3);
      const tone = ramp(spine);
      R(c, x - 13 + i * 3, top + 8 - tall, 2, tall, tone[1]);
      R(c, x - 13 + i * 3, top + 8 - tall, 1, tall, tone[2]);
      R(c, x - 13 + i * 3, top + 10 - tall, 2, 1, tone[0]);
    }
  }
  // the roof, in Modal green, with the mark on its gable
  for (let row = 0; row < 9; row++) {
    const half = 4 + row * 2;
    R(c, x - half - 1, y - 46 + row, half * 2 + 2, 2, C.ink);
    R(c, x - half, y - 46 + row, half * 2, 1, row < 2 ? C.modal[2] : row < 6 ? C.modal[1] : C.modal[0]);
  }
  if (mark) c.drawImage(mark, x - Math.floor(mark.width / 2), y - 44);
  // a lantern that glows on the left post
  R(c, x - 21, y - 22, 3, 5, C.ink);
  R(c, x - 20, y - 21, 1, 3, Math.floor(t * 2) % 5 ? C.glow : '#fff6c8');
}

// A small shiba inu, sitting. (x, y) is where it sits.
export function drawShiba(c, x, y, t) {
  x = Math.round(x);
  y = Math.round(y);
  const FUR = '#e2954a';
  const CREAM = '#f6e3c4';
  const wag = Math.floor(t * 4) % 2;
  // curled tail
  R(c, x + 4, y - 8 - wag, 4, 4, C.ink);
  R(c, x + 5, y - 7 - wag, 2, 2, CREAM);
  // body
  R(c, x - 4, y - 7, 9, 8, C.ink);
  R(c, x - 3, y - 6, 7, 6, FUR);
  R(c, x - 2, y - 4, 4, 4, CREAM);
  // head
  R(c, x - 6, y - 14, 9, 8, C.ink);
  R(c, x - 5, y - 13, 7, 6, FUR);
  R(c, x - 6, y - 16, 3, 3, C.ink);
  R(c, x, y - 16, 3, 3, C.ink);
  R(c, x - 5, y - 15, 1, 2, FUR);
  R(c, x + 1, y - 15, 1, 2, FUR);
  R(c, x - 4, y - 10, 5, 3, CREAM);
  R(c, x - 4, y - 12, 1, 1, C.ink);
  R(c, x, y - 12, 1, 1, C.ink);
  R(c, x - 2, y - 10, 1, 1, C.ink);
}

// A fat old television on a stand, with a maze game on the screen.
export function drawTv(c, at, t, near) {
  const { x, y } = at;
  E(c, x, y + 1, 16, 3, C.shade);
  // stand
  R(c, x - 11, y - 6, 22, 7, C.ink);
  R(c, x - 10, y - 5, 20, 5, C.wood[1]);
  R(c, x - 10, y - 5, 20, 1, C.wood[3]);
  // aerial
  R(c, x - 6, y - 36, 1, 8, C.ink);
  R(c, x + 5, y - 38, 1, 10, C.ink);
  R(c, x - 7, y - 37, 3, 2, C.steel[2]);
  R(c, x + 4, y - 39, 3, 2, C.steel[2]);
  // cabinet
  R(c, x - 15, y - 30, 30, 25, C.ink);
  R(c, x - 14, y - 29, 28, 23, '#6b4a34');
  R(c, x - 14, y - 29, 28, 2, '#8d6a4c');
  R(c, x + 9, y - 26, 4, 18, '#4a3122');
  R(c, x + 10, y - 24, 2, 2, C.gold);
  R(c, x + 10, y - 19, 2, 2, C.steel[2]);
  for (let i = 0; i < 3; i++) R(c, x + 10, y - 14 + i * 2, 2, 1, C.ink);
  // screen
  R(c, x - 12, y - 27, 20, 19, C.ink);
  R(c, x - 11, y - 26, 18, 17, '#10231a');
  // a maze on the screen, with somebody green in it
  const wall = near ? '#62de61' : '#3d7a3a';
  for (const [dx, dy, w, h] of [[-10, -25, 16, 1], [-10, -10, 16, 1], [-10, -25, 1, 16], [5, -25, 1, 16], [-7, -21, 5, 1], [0, -21, 3, 1], [-7, -17, 1, 4], [-3, -17, 6, 1], [-4, -13, 1, 3], [0, -14, 3, 1]]) R(c, x + dx, y + dy, w, h, wall);
  for (const [dx, dy] of [[-8, -23], [-5, -23], [3, -23], [-8, -12], [3, -18], [2, -12]]) R(c, x + dx, y + dy, 1, 1, '#d6ffc9');
  const hop = Math.floor(t * 3) % 2;
  R(c, x - 2 + hop, y - 20, 2, 2, '#7fee64');
  R(c, x - 6, y - 15, 2, 2, '#bfe6ff');
  R(c, x - 11, y - 26, 6, 1, '#1d3a2a');
}

// A short pole with a Modal-green pennant: flown over a house while its sandbox is running.
export function drawPennant(c, x, y, t) {
  x = Math.round(x);
  y = Math.round(y);
  R(c, x - 1, y - 15, 3, 16, C.ink);
  R(c, x, y - 14, 1, 14, '#d9dde8');
  R(c, x - 1, y - 16, 3, 2, C.ink);
  R(c, x, y - 16, 1, 1, '#ffdf70');
  const wave = Math.floor(t * 4) % 2;
  // the cloth: a tapering triangle, two shades of Modal's green
  R(c, x + 1, y - 15, 9, 7, C.ink);
  R(c, x + 10, y - 14 + wave, 2, 5 - wave, C.ink);
  R(c, x + 12, y - 13 + wave, 1, 3 - wave, C.ink);
  R(c, x + 2, y - 14, 7, 5, '#7fee64');
  R(c, x + 2, y - 12, 7, 3, '#62de61');
  R(c, x + 9, y - 13 + wave, 2, 3 - wave, '#7fee64');
  R(c, x + 3, y - 13, 2, 1, '#d6ffc9');
}

export function drawGate(c, at) {
  const { x, y } = at;
  for (const px of [x - 20, x + 17]) {
    E(c, px + 1, y + 1, 4, 2, C.shade);
    R(c, px - 1, y - 41, 5, 42, C.ink);
    R(c, px, y - 40, 3, 40, C.wood[2]);
    R(c, px, y - 40, 1, 40, C.wood[4]);
    box(c, px - 2, y - 4, 7, 5, C.stone[1]);
    box(c, px - 2, y - 50, 7, 9, C.glow);
    R(c, px, y - 47, 3, 4, C.glowHi);
    R(c, px - 3, y - 51, 9, 2, C.ink);
  }
  R(c, x - 33, y - 42, 66, 15, C.ink);
  R(c, x - 32, y - 41, 64, 13, C.wood[3]);
  R(c, x - 32, y - 41, 64, 1, C.wood[4]);
  R(c, x - 32, y - 29, 64, 1, C.wood[1]);
  for (const bx of [x - 30, x + 29]) for (const byy of [y - 39, y - 31]) R(c, bx, byy, 1, 1, C.ink);
  R(c, x - 14, y - 27, 1, 4, C.ink);
  R(c, x + 13, y - 27, 1, 4, C.ink);
}

// A Modal flag on a pole. `mark` is a small sprite of Modal's logo mark.
export function drawFlag(c, at, t, mark) {
  const { x, y } = at;
  E(c, x, y + 1, 4, 2, C.shade);
  box(c, x - 3, y - 3, 7, 4, C.stone[1]);
  R(c, x - 1, y - 47, 3, 45, C.ink);
  R(c, x, y - 46, 1, 43, C.steel[3]);
  EO(c, x, y - 48, 1, 1, C.gold);
  const w = 26;
  const h = 15;
  for (let i = 0; i < w; i++) {
    const dy = Math.round(Math.sin(t * 3.2 - i * 0.45) * (i / w) * 2.2);
    const top = y - 45 + dy;
    R(c, x + 2 + i, top - 1, 1, h + 2, C.ink);
    R(c, x + 2 + i, top, 1, h, MODAL_BLACK);
    R(c, x + 2 + i, top, 1, 1, '#2f2f2f');
    if (mark && i >= 5 && i < 5 + mark.width) c.drawImage(mark, i - 5, 0, 1, mark.height, x + 2 + i, top + Math.floor((h - mark.height) / 2), 1, mark.height);
    if (i === w - 1) R(c, x + 3 + i, top, 1, h, C.ink);
  }
}

// A hot-air balloon that drifts over the village. (x, y) is the middle of the envelope.
export function drawBalloon(c, x, y, t, mark) {
  x = Math.round(x);
  y = Math.round(y + Math.sin(t * 0.9) * 2);
  E(c, x + 8, y + 86, 10, 3, 'rgba(26, 20, 44, .16)'); // its shadow, far below
  const widthAt = (row) => (row <= 0 ? Math.round(16 * Math.sqrt(1 - (row * row) / (17.5 * 17.5))) : Math.round(16 * (1 - row / 24) ** 0.85));
  for (let row = -17; row <= 19; row++) {
    const half = widthAt(row);
    R(c, x - half - 1, y + row - 1, half * 2 + 2, 3, C.ink);
  }
  for (let row = -17; row <= 19; row++) {
    const half = widthAt(row);
    // six gores, green and black by turns
    for (let gore = 0; gore < 6; gore++) {
      const from = Math.round(-half + (gore * half * 2) / 6);
      const to = Math.round(-half + ((gore + 1) * half * 2) / 6);
      R(c, x + from, y + row, to - from, 1, gore % 2 ? MODAL_BLACK : gore === 0 ? C.modal[3] : C.modal[2]);
    }
  }
  if (mark) {
    R(c, x - 10, y - 7, 20, mark.height + 4, MODAL_BLACK);
    c.drawImage(mark, x - Math.floor(mark.width / 2), y - 5);
  }
  R(c, x - 5, y + 19, 1, 6, C.ink);
  R(c, x + 4, y + 19, 1, 6, C.ink);
  box(c, x - 6, y + 24, 12, 8, C.wood[3]);
  R(c, x - 5, y + 25, 10, 1, C.wood[4]);
  for (let i = 0; i < 4; i++) R(c, x - 4 + i * 3, y + 26, 1, 5, C.wood[1]);
  // the duck has got hold of a balloon
  box(c, x - 2, y + 19, 6, 6, C.white);
  R(c, x + 3, y + 21, 2, 1, '#e8912d');
  R(c, x + 1, y + 20, 1, 1, C.ink);
}

// ---- small things ----------------------------------------------------------------------------------------

export function drawLamp(c, at, lit) {
  const { x, y } = at;
  E(c, x, y + 1, 4, 2, C.shade);
  box(c, x - 3, y - 3, 7, 4, C.steel[0]);
  R(c, x - 1, y - 25, 3, 23, C.ink);
  R(c, x, y - 24, 1, 21, C.steel[1]);
  R(c, x - 4, y - 27, 9, 2, C.ink);
  box(c, x - 4, y - 36, 9, 10, lit ? C.glow : '#46557e');
  if (lit) R(c, x - 1, y - 33, 3, 4, C.glowHi);
  else R(c, x - 2, y - 34, 2, 5, '#62759e');
  R(c, x - 5, y - 38, 11, 3, C.ink);
  R(c, x - 4, y - 37, 9, 1, C.steel[1]);
  R(c, x - 1, y - 40, 3, 2, C.ink);
}

// The dock at the end of the lane, and a rowboat tied to it.
export function drawDock(c, at, t) {
  const { x, y } = at;
  for (const px of [x - 19, x - 5]) for (const py of [y - 8, y + 2]) {
    R(c, px, py, 3, 6, C.ink);
    R(c, px + 1, py, 1, 5, C.wood[1]);
  }
  R(c, x - 22, y - 6, 42, 9, C.ink);
  R(c, x - 21, y - 5, 40, 7, C.wood[3]);
  for (let i = 1; i < 8; i++) R(c, x - 21 + i * 5, y - 5, 1, 7, C.wood[1]);
  R(c, x - 21, y - 5, 40, 1, C.wood[4]);
  const bob = Math.floor(t * 1.5) % 2;
  const bx = x - 30;
  const by = y + 13 + bob;
  R(c, bx + 10, y + 3, 1, by - y - 5, C.wood[4]); // the mooring rope
  E(c, bx, by, 13, 5, C.ink);
  E(c, bx, by, 12, 4, C.wood[2]);
  E(c, bx, by, 9, 2, C.wood[0]);
  R(c, bx - 6, by - 1, 12, 1, C.wood[4]);
  R(c, bx - 16, by - 3, 9, 1, C.wood[4]);
  R(c, bx - 18, by - 4, 3, 3, C.wood[3]);
  R(c, bx - 12, by + 5, 24, 1, C.water[3]);
}

const BLOCKS_THE_WAY = { bush: true, berries: true, rock: true, stump: true, log: true };

// Bushes, rocks, logs and toadstools, scattered the same way on every visit.
export function makeProps(villagers, trees) {
  const rand = seeded(77);
  const props = [];
  const spots = [...Object.values(PLACES), ...Object.values(BEACONS), ...PEDESTALS, ...LAMPS];
  const free = (x, y) => {
    if (x < 20 || y < 50 || x > WORLD.w - 20 || y > WORLD.h - 8) return false;
    if (roadDistance(x, y, villagers) < 17) return false;
    if (GREENS.some((green) => Math.hypot(x - green.x, y - green.y) < 44)) return false;
    if (((x - POND.x) / (POND.rx + 18)) ** 2 + ((y - POND.y) / (POND.ry + 18)) ** 2 < 1) return false;
    if (spots.some((spot) => Math.abs(x - spot.x) < 46 && Math.abs(y - spot.y + 14) < 34)) return false;
    for (const v of villagers) {
      const reach = v.style === 'mushroom' ? 124 : 64;
      if (x > v.door.x - 64 && x < v.door.x + reach && y > v.door.y - 126 && y < v.door.y + 34) return false;
    }
    if (trees.some((tree) => (tree.x - x) ** 2 + ((tree.y - y) * 1.4) ** 2 < 17 ** 2)) return false;
    return !props.some((prop) => (prop.x - x) ** 2 + (prop.y - y) ** 2 < 16 ** 2);
  };
  const kinds = ['bush', 'bush', 'berries', 'rock', 'rock', 'grass', 'grass', 'grass', 'stump', 'log', 'toadstools', 'flowers', 'flowers'];
  for (let i = 0; i < 2600 && props.length < 86; i++) {
    const x = Math.round(rand() * WORLD.w);
    const y = Math.round(50 + rand() * (WORLD.h - 58));
    const kind = kinds[Math.floor(rand() * kinds.length)];
    if (free(x, y)) props.push({ x, y, kind, variant: Math.floor(rand() * 4), solid: !!BLOCKS_THE_WAY[kind] });
  }
  return props;
}

export function drawProp(c, prop, t) {
  const { x, y, kind, variant } = prop;
  if (kind === 'bush' || kind === 'berries') {
    E(c, x, y, 8, 2, C.shade);
    EO(c, x, y - 5, 8, 5, C.leaf[1]);
    E(c, x - 2, y - 7, 4, 2, C.leaf[2]);
    R(c, x - 4, y - 9, 3, 1, C.leaf[3]);
    R(c, x + 3, y - 3, 3, 2, C.leaf[0]);
    if (kind === 'berries') for (const [dx, dy] of [[-4, -4], [1, -7], [4, -4], [-1, -2]]) R(c, x + dx, y + dy, 2, 2, variant % 2 ? '#d1493f' : '#6c4fb3');
    else if (variant === 0) for (const [dx, dy] of [[-3, -6], [2, -8], [4, -4]]) R(c, x + dx, y + dy, 1, 1, '#fff6e0');
  } else if (kind === 'rock') {
    E(c, x, y, 6, 2, C.shade);
    EO(c, x, y - 3, 5 + (variant % 2), 3, C.stone[1]);
    R(c, x - 3, y - 5, 4, 1, C.stone[2]);
    R(c, x + 2, y - 2, 2, 2, C.stone[0]);
    if (variant > 1) R(c, x - 4, y - 2, 2, 1, C.leaf[2]);
  } else if (kind === 'grass') {
    const sway = Math.floor(t * 1.2 + x * 0.1) % 5 === 0 ? 1 : 0;
    for (let i = 0; i < 5; i++) {
      const tall = 5 + ((i * 3 + variant) % 4);
      R(c, x - 4 + i * 2 + (i > 1 ? sway : 0), y - tall, 1, tall, i % 2 ? C.leaf[2] : C.leaf[1]);
    }
    if (variant === 0) R(c, x + 2 + sway, y - 9, 1, 2, C.wood[3]);
  } else if (kind === 'stump') {
    E(c, x, y, 6, 2, C.shade);
    box(c, x - 5, y - 6, 10, 7, C.wood[2]);
    R(c, x + 2, y - 5, 2, 5, C.wood[1]);
    E(c, x, y - 6, 4, 2, C.wood[4]);
    R(c, x - 1, y - 6, 2, 1, C.wood[2]);
    if (variant % 2) R(c, x - 6, y - 2, 2, 2, '#d1493f');
  } else if (kind === 'log') {
    E(c, x, y, 10, 2, C.shade);
    box(c, x - 10, y - 6, 20, 7, C.wood[2]);
    R(c, x - 9, y - 5, 16, 1, C.wood[3]);
    R(c, x - 6, y - 3, 5, 1, C.wood[1]);
    EO(c, x + 8, y - 3, 2, 2, C.wood[4]);
    R(c, x + 8, y - 3, 1, 1, C.wood[2]);
    if (variant > 1) R(c, x - 4, y - 7, 3, 2, C.leaf[2]);
  } else if (kind === 'toadstools') {
    for (const [dx, tall] of [[-3, 4], [3, 6]]) {
      R(c, x + dx, y - tall, 2, tall, C.white);
      box(c, x + dx - 2, y - tall - 3, 6, 4, variant % 2 ? '#d1493f' : '#e8a82d');
      R(c, x + dx - 1, y - tall - 2, 1, 1, C.white);
    }
  } else {
    // a little bed of flowers
    const petals = ['#ffc2d4', '#ffe27a', '#d6c2ff', '#fff6e0'];
    for (let i = 0; i < 5; i++) {
      const fxp = x - 6 + i * 3;
      const fy = y - 2 - ((i * 2 + variant) % 3);
      R(c, fxp, fy, 1, 3, C.leaf[1]);
      R(c, fxp - 1, fy - 1, 3, 1, petals[(i + variant) % 4]);
      R(c, fxp, fy - 2, 1, 3, petals[(i + variant) % 4]);
      R(c, fxp, fy - 1, 1, 1, '#e8912d');
    }
  }
}

const FLUTTER = [[905, 150], [938, 172], [372, 338], [620, 286], [128, 262], [500, 252], [300, 430], [700, 430], [176, 330]];

export function drawButterflies(c, t) {
  FLUTTER.forEach(([hx, hy], i) => {
    const x = Math.round(hx + Math.sin(t * (0.5 + i * 0.07) + i) * 26 + Math.sin(t * 1.3 + i * 2) * 6);
    const y = Math.round(hy + Math.cos(t * (0.4 + i * 0.05) + i * 3) * 14 + Math.sin(t * 2.1 + i) * 3);
    const color = ['#ffe27a', '#ffc2d4', '#b4e2f8', '#ffffff'][i % 4];
    R(c, x, y, 1, 2, C.ink);
    if (Math.floor(t * 9 + i) % 2) {
      R(c, x - 2, y - 1, 2, 2, color);
      R(c, x + 1, y - 1, 2, 2, color);
    } else {
      R(c, x - 1, y - 1, 1, 2, color);
      R(c, x + 1, y - 1, 1, 2, color);
    }
  });
}

// Drawn over the dark, so they glow. `amount` is 0 by day and 1 at night.
export function drawFireflies(c, t, amount) {
  if (amount < 0.05) return;
  for (let i = 0; i < 26; i++) {
    if (Math.sin(t * (1.2 + hash(i, 5)) + i * 2.3) < 0.15) continue;
    const x = Math.round(hash(i, 91) * WORLD.w + Math.sin(t * 0.6 + i) * 9);
    const y = Math.round(60 + hash(i, 37) * (WORLD.h - 90) + Math.cos(t * 0.5 + i * 1.7) * 6);
    c.fillStyle = `rgba(233, 255, 138, ${(0.28 * amount).toFixed(2)})`;
    c.fillRect(x - 1, y - 1, 3, 3);
    c.fillStyle = `rgba(245, 255, 190, ${(0.95 * amount).toFixed(2)})`;
    c.fillRect(x, y, 1, 1);
  }
}
