// What makes each house somebody's: the thing on their desk, and the bits of life around the
// room. Only Mo has a computer. Everyone else works at something that suits them, and it stirs
// while they are busy (which is to say: while a command is running in their sandbox).
//
// The desk's top runs from x 220 to 264 at y 82; things on it stand with their base at y 84.

import { C, E, R, box } from './art.js';

const GREEN = '#7fee64';

// ---- on the desk --------------------------------------------------------------------------------

const DESKS = {
  // Mo: the one computer in the village
  gpu(c, t, busy) {
    box(c, 231, 68, 22, 15, '#2b3140');
    R(c, 233, 70, 18, 10, busy ? '#12301f' : '#101a14');
    if (busy) {
      const scroll = Math.floor(t * 8);
      for (let i = 0; i < 4; i++) R(c, 234, 71 + i * 2, 4 + ((scroll + i * 7) % 12), 1, GREEN);
    } else {
      R(c, 234, 71, 6, 1, GREEN);
      R(c, 234, 73, 10, 1, '#3d7a3a');
      if (Math.floor(t * 2) % 2) R(c, 234, 75, 2, 1, GREEN);
    }
    R(c, 240, 83, 4, 2, C.ink);
    R(c, 237, 85, 10, 2, C.ink);
    // a keyboard, and a mug with the mark on it
    box(c, 226, 89, 14, 4, '#3a3f4a');
    box(c, 255, 78, 6, 7, '#22252b');
    R(c, 257, 80, 2, 2, GREEN);
  },
  // Orlo: a crystal ball that clouds over when he is at work
  tower(c, t, busy) {
    R(c, 236, 80, 12, 5, C.ink);
    R(c, 237, 81, 10, 3, C.gold);
    E(c, 242, 73, 8, 8, C.ink);
    E(c, 242, 73, 7, 7, busy ? '#b98cff' : '#7d5fd0');
    E(c, 242, 73, 4, 4, busy && Math.floor(t * 6) % 2 ? '#f1e2ff' : '#a98bea');
    R(c, 238, 69, 2, 2, C.white);
    if (busy) for (let i = 0; i < 3; i++) R(c, 236 + ((Math.floor(t * 5) + i * 5) % 13), 62 - ((Math.floor(t * 7) + i * 3) % 6), 1, 1, C.glow);
    // a wand and a small bottle
    R(c, 224, 88, 9, 1, C.wood[0]);
    R(c, 232, 87, 2, 2, C.glow);
    box(c, 254, 77, 5, 8, '#62c08a');
    R(c, 255, 75, 3, 2, C.wood[2]);
  },
  // Juniper: a vice, and a gear that turns
  workshop(c, t, busy) {
    box(c, 226, 76, 12, 9, C.steel[1]);
    R(c, 228, 73, 3, 4, C.steel[0]);
    R(c, 233, 73, 3, 4, C.steel[0]);
    R(c, 238, 79, 5, 2, C.ink);
    const turn = busy ? Math.floor(t * 8) % 2 : 0;
    E(c, 251, 77, 7, 7, C.ink);
    E(c, 251, 77, 6, 6, C.gold);
    E(c, 251, 77, 2, 2, C.ink);
    for (const [dx, dy] of turn ? [[0, -8], [0, 7], [-8, 0], [7, 0]] : [[-6, -6], [5, -6], [-6, 5], [5, 5]]) R(c, 251 + dx, 77 + dy, 2, 2, C.gold);
    R(c, 223, 90, 10, 2, C.wood[0]); // a hammer
    box(c, 231, 88, 5, 5, C.steel[2]);
  },
  // Bao: brass scales
  shop(c, t, busy) {
    R(c, 241, 66, 2, 18, C.ink);
    R(c, 236, 83, 12, 2, C.ink);
    R(c, 237, 83, 10, 1, C.gold);
    const tip = busy ? (Math.floor(t * 4) % 2 ? 1 : -1) : 0;
    R(c, 231, 68, 22, 2, C.ink);
    R(c, 232, 68, 20, 1, C.gold);
    for (const [x, dy] of [[232, tip], [251, -tip]]) {
      R(c, x, 70, 1, 5 + dy, C.ink);
      R(c, x - 3, 75 + dy, 7, 3, C.ink);
      R(c, x - 2, 75 + dy, 5, 2, C.gold);
    }
    box(c, 255, 79, 6, 6, '#d6553f'); // a tin of buttons
    R(c, 256, 80, 4, 1, '#f08b7a');
    box(c, 224, 87, 8, 5, C.white); // a receipt pad
    R(c, 225, 89, 5, 1, '#b9b3c6');
  },
  // Dot: a charging dock. Dot is the computer.
  lab(c, t, busy) {
    box(c, 232, 74, 20, 11, C.steel[2]);
    R(c, 233, 75, 18, 2, C.steel[3]);
    const rate = busy ? 10 : 2;
    for (let i = 0; i < 4; i++) R(c, 235 + i * 4, 79, 2, 2, (Math.floor(t * rate) + i) % 4 === 0 ? '#58d06a' : '#2c6a41');
    R(c, 241, 64, 2, 10, C.ink);
    R(c, 240, 62, 4, 3, busy && Math.floor(t * 6) % 2 ? '#ff6b5e' : '#6d2b33');
    R(c, 224, 90, 12, 1, C.ink); // a coiled cable
    R(c, 224, 88, 1, 3, C.ink);
    box(c, 255, 80, 5, 5, '#e8a82d'); // a spare bolt tin
  },
  // Moss: seedlings in a tray
  mushroom(c, t, busy) {
    box(c, 228, 79, 26, 6, C.wood[1]);
    R(c, 229, 80, 24, 2, '#5b3a29');
    for (let i = 0; i < 5; i++) {
      const sway = busy && (Math.floor(t * 5) + i) % 2 ? 1 : 0;
      R(c, 231 + i * 5, 75, 1, 5, C.leaf[1]);
      R(c, 230 + i * 5 + sway, 73, 3, 2, C.leaf[3]);
    }
    box(c, 256, 76, 6, 9, '#4d7ea8'); // watering can
    R(c, 252, 78, 4, 1, C.ink);
    R(c, 224, 89, 6, 3, '#8a5a3c'); // a trowel
    R(c, 230, 90, 5, 1, C.steel[2]);
  },
  // Fennel: a music stand and a metronome
  caravan(c, t, busy) {
    R(c, 238, 70, 1, 15, C.ink);
    box(c, 231, 64, 15, 10, C.white);
    for (let i = 0; i < 3; i++) R(c, 233, 66 + i * 2, 11, 1, '#b9b3c6');
    R(c, 235, 66, 2, 2, C.ink);
    R(c, 240, 69, 2, 2, C.ink);
    box(c, 252, 73, 8, 12, C.wood[2]);
    const tick = Math.floor(t * (busy ? 8 : 2)) % 2 ? 2 : -2;
    R(c, 256 + tick, 74, 1, 8, C.ink);
    R(c, 255 + tick, 75, 3, 2, C.gold);
    R(c, 224, 89, 9, 2, '#c2483d'); // a ribbon
  },
  // Wisp: one candle, burning blue
  ruin(c, t, busy) {
    box(c, 239, 72, 6, 13, '#e9e4d6');
    R(c, 240, 73, 1, 11, C.white);
    R(c, 236, 84, 12, 2, C.ink);
    const flick = Math.floor(t * (busy ? 12 : 5)) % 2;
    R(c, 241, 66 - flick - (busy ? 2 : 0), 2, 6 + flick + (busy ? 2 : 0), '#7fd6ff');
    R(c, 241, 69, 2, 3, C.white);
    R(c, 226, 88, 5, 4, '#77748a'); // a pebble or two
    R(c, 254, 82, 4, 3, '#a3a0ae');
  },
  // Ziggy: sticky notes, a mug and a rubber duck. The pitch is all in his head.
  garage(c, t, busy) {
    const notes = ['#ffe066', '#ff9ec4', '#9be8a8', '#8ecbff'];
    notes.forEach((color, i) => {
      const lift = busy && (Math.floor(t * 6) + i) % 4 === 0 ? 1 : 0;
      box(c, 226 + i * 7, 74 - lift, 6, 6, color);
      R(c, 227 + i * 7, 76 - lift, 3, 1, 'rgba(42,34,56,.5)');
    });
    box(c, 255, 77, 6, 8, C.white); // a mug
    R(c, 261, 79, 2, 3, C.ink);
    const steam = Math.floor(t * 3) % 3;
    R(c, 257, 73 - steam, 1, 2, '#d9d4de');
    box(c, 225, 86, 7, 6, '#ffd23f'); // the duck
    R(c, 231, 88, 3, 2, '#e8912d');
    R(c, 227, 87, 1, 1, C.ink);
  },
};

// ---- around the room ----------------------------------------------------------------------------
// Two corners by the door wall, and the wall above the long shelf.

const frame = (c, x, y, w, h, fill) => {
  R(c, x - 1, y - 1, w + 2, h + 2, C.ink);
  R(c, x, y, w, h, C.wood[2]);
  R(c, x + 1, y + 1, w - 2, h - 2, fill);
};

const DECOR = {
  gpu(c, t, v) {
    // a server rack, lights running, and a fan
    box(c, 24, 146, 20, 28, '#23262d');
    for (let row = 0; row < 5; row++) {
      R(c, 26, 149 + row * 5, 16, 3, '#16181d');
      R(c, 27 + ((Math.floor(t * 6) + row * 3) % 12), 150 + row * 5, 2, 1, v.show === 'awake' ? GREEN : '#2d4327');
    }
    // the mark, framed
    frame(c, 60, 11, 22, 13, '#181818');
    R(c, 64, 15, 6, 5, GREEN);
    R(c, 71, 16, 6, 5, '#62de61');
    // a small cactus, beside the rack (the corner by the desk is the arcade cabinet's)
    box(c, 50, 164, 10, 9, '#b56a50');
    box(c, 52, 152, 6, 13, C.leaf[2]);
    R(c, 48, 157, 4, 2, C.leaf[2]);
    R(c, 58, 155, 3, 2, C.leaf[2]);
    R(c, 54, 151, 2, 2, '#f08bb0');
  },
  tower(c, t) {
    // a cauldron, bubbling
    E(c, 34, 166, 12, 9, C.ink);
    E(c, 34, 165, 11, 7, '#3a3f4c');
    E(c, 34, 160, 9, 3, '#58d06a');
    for (let i = 0; i < 3; i++) {
      const rise = (t * 0.6 + i / 3) % 1;
      R(c, 28 + i * 5, 158 - Math.round(rise * 12), 2, 2, rise > 0.7 ? '#b9efc4' : '#7de08f');
    }
    // a star chart
    frame(c, 60, 10, 24, 14, '#1d1b3a');
    for (const [x, y] of [[64, 13], [70, 18], [76, 12], [80, 20], [67, 21]]) R(c, x, y, 1, 1, Math.floor(t * 2 + x) % 5 ? C.white : C.glow);
    // a tall candle
    R(c, 258, 152, 3, 22, C.ink);
    R(c, 255, 172, 9, 2, C.ink);
    R(c, 258, 147 - (Math.floor(t * 6) % 2), 3, 5, C.glow);
  },
  workshop(c, t) {
    // planks and a crate
    box(c, 22, 158, 24, 16, C.wood[2]);
    R(c, 23, 165, 22, 1, C.wood[0]);
    for (let i = 0; i < 3; i++) R(c, 26 + i * 6, 148 + i * 3, 4, 10, C.wood[4 - i]);
    // tools on the wall
    R(c, 58, 12, 28, 1, C.ink);
    R(c, 62, 13, 2, 10, C.steel[1]);
    box(c, 60, 21, 6, 4, C.wood[1]);
    R(c, 72, 13, 1, 9, C.wood[0]);
    box(c, 70, 13, 5, 3, C.steel[2]);
    R(c, 80, 13, 3, 9, C.steel[2]);
    // a wind-up toy, walking back and forth
    const walk = Math.abs(((t * 6) % 24) - 12);
    box(c, 246 + Math.round(walk), 168, 6, 5, '#d6553f');
    R(c, 247 + Math.round(walk), 173, 1, 2 - (Math.floor(t * 8) % 2), C.ink);
    R(c, 250 + Math.round(walk), 173, 1, 1 + (Math.floor(t * 8) % 2), C.ink);
    R(c, 248 + Math.round(walk), 166, 2, 2, C.gold);
  },
  shop(c, t) {
    // sacks and a crate
    box(c, 22, 160, 14, 14, C.wood[2]);
    R(c, 23, 166, 12, 1, C.wood[0]);
    E(c, 42, 168, 7, 6, C.ink);
    E(c, 42, 168, 6, 5, '#d9c7a0');
    R(c, 40, 161, 4, 2, C.wood[0]);
    // a paper lantern, swaying
    const sway = Math.floor(t * 1.5) % 2;
    R(c, 71 + sway, 9, 1, 4, C.ink);
    E(c, 71 + sway, 18, 6, 6, C.ink);
    E(c, 71 + sway, 18, 5, 5, '#f08b4a');
    R(c, 69 + sway, 16, 2, 3, C.glowHi);
    // a cat, asleep; its tail twitches now and then
    E(c, 255, 169, 8, 5, C.ink);
    E(c, 255, 169, 7, 4, '#5b5f6b');
    R(c, 248, 164, 5, 5, '#5b5f6b');
    R(c, 248, 162, 2, 2, '#5b5f6b');
    R(c, 251, 162, 2, 2, '#5b5f6b');
    R(c, 261, 171 - (Math.floor(t * 0.8) % 4 === 0 ? 2 : 0), 4, 2, '#5b5f6b');
  },
  lab(c, t) {
    // beakers, one of them fizzing
    box(c, 22, 164, 24, 10, C.steel[1]);
    for (const [x, color] of [[25, '#62b0e8'], [32, '#58d06a'], [39, '#f08bb0']]) {
      box(c, x, 154, 5, 10, C.white);
      R(c, x + 1, 158, 3, 5, color);
    }
    R(c, 33, 152 - (Math.floor(t * 5) % 4), 1, 1, '#b9efc4');
    // a clock with a hand that moves
    E(c, 72, 17, 7, 7, C.ink);
    E(c, 72, 17, 6, 6, C.white);
    const hand = (t * 0.5) % (Math.PI * 2);
    R(c, 72 + Math.round(Math.cos(hand) * 3), 17 + Math.round(Math.sin(hand) * 3), 1, 1, C.ink);
    R(c, 72, 17, 1, 1, '#d6553f');
    // a small sweeper, going back and forth along the wall (the corner by the desk is the TV's)
    const along = Math.abs(((t * 6) % 80) - 40);
    E(c, 62 + Math.round(along), 173, 5, 3, C.ink);
    E(c, 62 + Math.round(along), 172, 4, 2, C.steel[2]);
    R(c, 62 + Math.round(along), 171, 1, 1, Math.floor(t * 4) % 2 ? '#58d06a' : C.steel[0]);
  },
  mushroom(c, t) {
    // potted plants, leaning with the light
    for (const [x, h, leaf] of [[26, 14, C.leaf[2]], [38, 20, C.leaf[3]]]) {
      box(c, x - 4, 166, 9, 8, '#b56a50');
      const sway = Math.floor(t * 1.2 + x) % 3 === 0 ? 1 : 0;
      R(c, x, 166 - h, 1, h, C.leaf[1]);
      box(c, x - 3 + sway, 163 - h, 7, 6, leaf);
    }
    // a round window with the sun in it
    E(c, 72, 17, 8, 8, C.ink);
    E(c, 72, 17, 7, 7, '#bfe6f2');
    E(c, 75, 14, 3, 3, C.glow);
    R(c, 65, 17, 15, 1, C.ink);
    // fireflies
    for (let i = 0; i < 3; i++) {
      const x = 246 + Math.round(Math.sin(t * 0.8 + i * 2) * 9);
      const y = 158 + Math.round(Math.cos(t * 0.6 + i * 1.7) * 8);
      if (Math.floor(t * 3 + i) % 3) R(c, x, y, 1, 1, C.glowHi);
    }
    box(c, 250, 166, 12, 8, C.wood[2]); // a basket
    R(c, 252, 164, 8, 2, '#d1493f');
  },
  caravan(c, t) {
    // cushions
    E(c, 30, 170, 9, 5, C.ink);
    E(c, 30, 170, 8, 4, '#c2483d');
    E(c, 42, 166, 7, 4, C.ink);
    E(c, 42, 166, 6, 3, '#e8b33a');
    // a lute on the wall
    E(c, 70, 19, 5, 5, C.ink);
    E(c, 70, 19, 4, 4, C.wood[3]);
    R(c, 70, 9, 1, 8, C.ink);
    R(c, 69, 19, 2, 2, C.ink);
    // a horn gramophone, with a tune coming out of it
    box(c, 250, 166, 12, 8, C.wood[1]);
    R(c, 256, 158, 2, 8, C.ink);
    box(c, 248, 152, 10, 7, C.gold);
    for (let i = 0; i < 2; i++) {
      const rise = (t * 0.5 + i / 2) % 1;
      R(c, 244 - i * 4 + Math.round(Math.sin(rise * 6) * 2), 150 - Math.round(rise * 14), 2, 2, C.ink);
      R(c, 245 - i * 4 + Math.round(Math.sin(rise * 6) * 2), 147 - Math.round(rise * 14), 1, 3, C.ink);
    }
  },
  ruin(c, t) {
    // a fallen column
    box(c, 22, 164, 24, 9, '#8e94a6');
    for (let x = 26; x < 44; x += 5) R(c, x, 165, 1, 7, '#5d6274');
    R(c, 22, 158, 8, 6, '#7b8194');
    // a cobweb in the corner
    for (let i = 0; i < 4; i++) R(c, 18 + i * 3, 10 + i * 3, 12 - i * 3, 1, 'rgba(233,248,255,.55)');
    R(c, 18, 10, 1, 12, 'rgba(233,248,255,.55)');
    // lights that drift about and are not anybody
    for (let i = 0; i < 4; i++) {
      const x = 200 + Math.round(Math.sin(t * 0.35 + i * 1.9) * 50);
      const y = 150 + Math.round(Math.cos(t * 0.5 + i * 2.3) * 16);
      R(c, x, y, 2, 2, i % 2 ? '#bfeaff' : '#e9f8ff');
    }
  },
  garage(c, t) {
    // a beanbag
    E(c, 34, 167, 12, 8, C.ink);
    E(c, 34, 166, 11, 7, '#e0685c');
    E(c, 31, 163, 5, 3, '#f08b7a');
    // a whiteboard: a line that only goes up
    frame(c, 56, 9, 30, 16, C.white);
    for (let i = 0; i < 6; i++) R(c, 60 + i * 4, 21 - i * 2 - (i === 5 ? Math.floor(t * 2) % 2 : 0), 3, 1, '#d6553f');
    R(c, 59, 22, 24, 1, C.ink);
    R(c, 59, 11, 1, 12, C.ink);
    // pizza boxes, and a ball that will not stop bouncing
    for (let i = 0; i < 3; i++) box(c, 247, 168 - i * 4, 16, 5, '#d9c7a0');
    R(c, 252, 162, 6, 1, '#d6553f');
    const bounce = Math.abs(Math.sin(t * 4));
    E(c, 236, 172 - Math.round(bounce * 14), 2, 2, C.white);
  },
};

export function drawDesk(c, v, t) {
  (DESKS[v.style] || DESKS.shop)(c, t, !!v.working);
}

export function drawDecor(c, v, t) {
  (DECOR[v.style] || DECOR.shop)(c, t, v);
}
