// The villagers: animals in clothes, a robot and a ghost, drawn in code like everything else.
// Each one shares the same small body and walk cycle; what makes them themselves is the head.
// The visitor (the player) is human, and picks a look on the title screen (LOOKS, below).

import { C, R, E, EO, box, ramp } from './art.js';

const PINK = '#f3a8b8';

// fur: the head and hands; dark: its shadow side
const SPECIES = {
  orlo: { animal: 'goat', fur: '#f4efe4', dark: '#cfc7b8', hand: '#f4efe4' },
  juniper: { animal: 'beaver', fur: '#a0683c', dark: '#7a4a26', hand: '#7a4a26' },
  bao: { animal: 'capybara', fur: '#b98f5f', dark: '#93693d', hand: '#93693d' },
  moss: { animal: 'frog', fur: '#84c25c', dark: '#5f9a44', hand: '#84c25c' },
  fennel: { animal: 'fennec', fur: '#ecc083', dark: '#cf9a58', hand: '#ecc083' },
  mo: { animal: 'modal', fur: '#7fee64', dark: '#62de61', hand: '#7fee64' },
  ziggy: { animal: 'raccoon', fur: '#a9afbb', dark: '#7d8492', hand: '#3a3f4c' },
  player: { animal: 'human', fur: C.skin[1], dark: C.skin[0], hand: C.skin[1] },
  // Three people from Modal, there to be seen and not spoken to. Each is a few traits and
  // nothing more: hair, glasses, beard and clothes.
  angler: { animal: 'human', fur: C.skin[1], dark: C.skin[0], hand: C.skin[1], mohawk: ['#c6f432', '#8fcf1e', '#f0ff9a'], glasses: 'half', moustache: '#b08a5a', tee: '#d43d3d' }, // Charles
  erik: { animal: 'human', fur: C.skin[1], dark: C.skin[0], hand: C.skin[1], hair: ['#7a5236', '#5a3a24', '#a07a58'], glasses: 'round', pocket: '#7d828c' },
  akshat: { animal: 'human', fur: '#c8946a', dark: '#a87650', hand: '#c8946a', hair: ['#2b2630', '#1a1620', '#4a4452'], tousled: true, beard: '#2b2630', tee: '#27304f' },
};

const MASK = '#3a3f4c'; // a raccoon's mask, ear tips and tail rings

// What a visitor can choose on the title screen. A look is four numbers, one per list:
// { skin, hair, hairColor, outfit }.
export const LOOKS = {
  skin: [
    { name: 'Light', fur: '#f8dcb6', dark: '#dba57c', blush: '#f0a39a', mouth: '#a8553f' },
    { name: 'Warm', fur: '#eec39a', dark: '#cf9a6e', blush: '#e8917f', mouth: '#a8553f' },
    { name: 'Tan', fur: '#d9a273', dark: '#b57f52', blush: '#cf7d68', mouth: '#8f4433' },
    { name: 'Brown', fur: '#b07a4f', dark: '#8c5c38', blush: '#a85f4c', mouth: '#6e2f25' },
    { name: 'Deep', fur: '#855837', dark: '#664126', blush: '#7a4034', mouth: '#4f2019' },
  ],
  hair: ['Short', 'Curly', 'Afro', 'Buzz', 'Long', 'Ponytail', 'Bun'].map((name) => ({ name, style: name.toLowerCase() })),
  hairColor: [
    { name: 'Brown', tones: ['#6b4a34', '#4a3122', '#9a7558'] },
    { name: 'Black', tones: ['#2b2630', '#1a1620', '#4a4452'] },
    { name: 'Blonde', tones: ['#e0b860', '#b98f3c', '#f4dc98'] },
    { name: 'Red', tones: ['#b5532e', '#8a3a1e', '#d97a4c'] },
    { name: 'Grey', tones: ['#b9b9c2', '#8f8f9c', '#dedee6'] },
    { name: 'Pink', tones: ['#e87aa8', '#b9507c', '#f6a9c8'] },
    { name: 'Green', tones: ['#7fee64', '#4fb842', '#c5ffb5'] },
  ],
  // every outfit carries Modal's mark somewhere
  outfit: [
    { name: 'Black tee', color: '#22252b', sleeves: 'short', mark: ['#7fee64', '#62de61'] },
    { name: 'White tee', color: '#efe9da', sleeves: 'short', mark: ['#3fae4a', '#2f8f3a'] },
    { name: 'Green hoodie', color: '#62c558', sleeves: 'long', mark: ['#181818', '#2a3a2a'], hood: true },
    { name: 'Denim jacket', color: '#4d7ea8', sleeves: 'long', open: '#22252b' },
    { name: 'Striped jumper', color: '#c9503f', sleeves: 'long', stripes: '#f3e6c8', mark: ['#7fee64', '#62de61'] },
  ],
};
export const DEFAULT_LOOK = { skin: 0, hair: 0, hairColor: 0, outfit: 0 };

// A saved look, made safe: whole numbers inside each list, the default where one is missing.
export function tidyLook(look) {
  const tidy = {};
  for (const part of Object.keys(DEFAULT_LOOK)) {
    const n = Number(look?.[part]);
    tidy[part] = Number.isInteger(n) && n >= 0 && n < LOOKS[part].length ? n : DEFAULT_LOOK[part];
  }
  return tidy;
}

function visitor(look) {
  const { skin, hair, hairColor, outfit } = tidyLook(look);
  const tone = LOOKS.skin[skin];
  return { animal: 'human', fur: tone.fur, dark: tone.dark, hand: tone.fur, blush: tone.blush, lips: tone.mouth, style: LOOKS.hair[hair].style, hair: LOOKS.hairColor[hairColor].tones, outfit: LOOKS.outfit[outfit] };
}

// Hair for a human head. Draws what sits behind the face, and returns what must go over it.
// hy: the top of the head. fx: see drawFolk.
function drawHair(c, { x, hy, fx, side, up, style, tones }) {
  const [hair, deep, light] = tones;
  const tie = '#7fee64';
  if (style === 'afro') {
    // a round cloud of it, drawn a row at a time: [row, from, width], first in ink, then in hair
    const rows = (list, color) => list.forEach(([row, from, wide, tall = 1]) => R(c, side ? fx(from, wide) : x + from, hy + row, wide, tall, color));
    if (up) {
      rows([[-5, -4, 8], [-4, -6, 12], [-3, -8, 16], [-2, -9, 18, 9], [7, -8, 16], [8, -6, 12]], C.ink);
      rows([[-4, -4, 8], [-3, -6, 12], [-2, -7, 14], [-1, -8, 16, 7], [6, -7, 14], [7, -5, 10]], hair);
      rows([[6, -5, 10]], deep);
    } else if (side) {
      rows([[-5, -5, 8], [-4, -7, 12], [-3, -9, 16], [-2, -10, 17, 6], [4, -10, 7, 5], [9, -9, 5]], C.ink);
      rows([[-4, -5, 8], [-3, -7, 12], [-2, -8, 14], [-1, -9, 15, 5], [4, -9, 5, 4], [8, -8, 3]], hair);
      rows([[7, -8, 3]], deep);
    } else {
      rows([[-5, -4, 8], [-4, -6, 12], [-3, -8, 16], [-2, -9, 18, 6], [4, -9, 3, 3], [4, 6, 3, 3], [7, -8, 2], [7, 6, 2]], C.ink);
      rows([[-4, -4, 8], [-3, -6, 12], [-2, -7, 14], [-1, -8, 16, 5], [4, -8, 2, 3], [4, 6, 2, 3]], hair);
    }
    R(c, x - 4, hy - 3, 3, 1, light);
    R(c, x + 2, hy - 1, 2, 1, light);
    R(c, x - 2, hy + 1, 1, 1, deep);
    R(c, x + 4, hy + 2, 1, 1, deep);
    R(c, x - 6, hy + 1, 1, 1, deep);
    return null;
  }
  if (style === 'buzz') {
    if (up) {
      R(c, x - 5, hy + 1, 10, 6, hair);
      R(c, x - 6, hy + 2, 12, 4, hair);
      R(c, x - 4, hy + 6, 8, 1, deep);
    } else {
      R(c, x - 5, hy + 1, 10, 2, hair);
      R(c, x - 6, hy + 2, 12, 1, hair);
      if (side) R(c, fx(-6, 4), hy + 2, 4, 4, hair);
    }
    return null;
  }
  // everything else starts from the same cap of hair
  if (up) {
    R(c, x - 5, hy + 1, 10, 9, hair);
    R(c, x - 6, hy + 2, 12, 7, hair);
    R(c, x - 4, hy + 8, 8, 2, deep);
  } else {
    R(c, x - 5, hy + 1, 10, 3, hair);
    R(c, x - 6, hy + 2, 12, 2, hair);
    if (side) R(c, fx(-6, 5), hy + 2, 5, 6, hair);
    else {
      R(c, x - 6, hy + 4, 1, 3, hair);
      R(c, x + 5, hy + 4, 1, 3, hair);
    }
    R(c, x - 4, hy + 1, 4, 1, light);
  }
  if (style === 'curly') {
    // more of it, and none of it lying flat
    R(c, x - 6, hy - 1, 12, 3, C.ink);
    R(c, x - 5, hy - 2, 9, 2, C.ink);
    R(c, x - 5, hy, 10, 2, hair);
    R(c, x - 4, hy - 1, 7, 1, hair);
    R(c, x - 2, hy - 1, 3, 1, light);
    if (!up) {
      R(c, x + 3, hy + 3, 2, 2, hair);
      R(c, x - 5, hy + 3, 3, 1, hair);
    }
  } else if (style === 'swept' && !up) {
    R(c, x - 2, hy, 7, 1, C.ink); // swept up and over to one side
    R(c, x - 1, hy, 5, 1, hair);
    R(c, x + 2, hy + 3, 3, 1, hair);
  } else if (style === 'bun') {
    const bx = side ? fx(-4, 6) : x - 3;
    R(c, bx, hy - 4, 6, 5, C.ink);
    R(c, bx + 1, hy - 3, 4, 4, hair);
    R(c, bx + 1, hy - 3, 2, 1, light);
    R(c, bx + 1, hy, 4, 1, deep);
  } else if (style === 'ponytail') {
    if (up) {
      R(c, x - 3, hy + 7, 6, 11, C.ink);
      R(c, x - 2, hy + 8, 4, 9, hair);
      R(c, x - 2, hy + 8, 4, 1, tie);
      R(c, x - 2, hy + 15, 4, 2, deep);
    } else if (side) {
      R(c, fx(-10, 4), hy + 3, 4, 10, C.ink);
      R(c, fx(-9, 3), hy + 4, 3, 8, hair);
      R(c, fx(-8, 2), hy + 4, 2, 1, tie);
      R(c, fx(-9, 2), hy + 10, 2, 2, deep);
    } else {
      R(c, x + 6, hy + 2, 4, 8, C.ink);
      R(c, x + 7, hy + 3, 2, 6, hair);
      R(c, x + 7, hy + 7, 2, 2, deep);
    }
  } else if (style === 'long') {
    if (up) {
      R(c, x - 7, hy + 10, 14, 6, C.ink);
      R(c, x - 6, hy + 2, 12, 13, hair);
      R(c, x - 5, hy + 13, 10, 2, deep);
      R(c, x - 3, hy + 3, 1, 8, light);
    } else if (side) {
      R(c, fx(-8, 7), hy + 2, 7, 14, C.ink);
      R(c, fx(-7, 5), hy + 2, 5, 13, hair);
      R(c, fx(-7, 5), hy + 13, 5, 2, deep);
    } else {
      // two curtains that frame the face and rest on the shoulders: drawn over the cheeks
      return () => {
        R(c, x - 8, hy + 3, 3, 13, C.ink);
        R(c, x + 5, hy + 3, 3, 13, C.ink);
        R(c, x - 7, hy + 3, 2, 12, hair);
        R(c, x + 5, hy + 3, 2, 12, hair);
        R(c, x - 7, hy + 13, 2, 2, deep);
        R(c, x + 5, hy + 13, 2, 2, deep);
      };
    }
  }
  return null;
}

// The head every villager starts from: a rounded block with a dark outline.
function headBlock(c, x, hy, fur, dark) {
  R(c, x - 5, hy, 10, 13, C.ink);
  R(c, x - 6, hy + 1, 12, 11, C.ink);
  R(c, x - 7, hy + 2, 14, 9, C.ink);
  R(c, x - 5, hy + 1, 10, 11, fur);
  R(c, x - 6, hy + 2, 12, 9, fur);
  R(c, x + 3, hy + 5, 3, 6, dark);
}

// o: { kind, color, accent, dir: 'down'|'up'|'left'|'right', frame: 0..3 (walk cycle), moving,
//      talking, blink, bubble, t }
export function drawFolk(c, x, y, o) {
  x = Math.round(x);
  y = Math.round(y);
  if (o.kind === 'dot') return drawRobot(c, x, y, o);
  if (o.kind === 'wisp') return drawGhost(c, x, y, o);
  const kind = SPECIES[o.kind] ? o.kind : 'player';
  const who = kind === 'player' ? visitor(o.look) : SPECIES[kind];
  const wear = who.outfit || {};
  const body = ramp(wear.color || o.color);
  const accent = ramp(o.accent || o.color || wear.color);
  const frame = o.moving ? o.frame : 0;
  const bob = frame % 2;
  const up = o.dir === 'up';
  const front = o.dir === 'down';
  const side = o.dir === 'left' || o.dir === 'right';
  const flip = o.dir === 'left' ? -1 : 1;
  const by = y - bob; // everything above the feet rides the bob
  const hy = by - 25; // top of the head
  const half = side ? 5 : 6;
  const robe = kind === 'orlo';
  const t = o.t || 0;
  const mouth = o.talking ? '#7a2f3a' : null;
  // x of a rectangle `w` wide that starts `dx` right of centre when facing right; mirrored when facing left
  const fx = (dx, w) => (flip > 0 ? x + dx : x - dx - w);

  E(c, x, y, 6, 2, C.shade);

  // tails that show behind the body
  if (kind === 'ziggy' && !up) {
    if (side) {
      box(c, fx(-13, 8), by - 9, 8, 7, who.fur);
      R(c, fx(-11, 2), by - 8, 2, 5, MASK);
      R(c, fx(-7, 2), by - 8, 2, 5, MASK);
    } else {
      box(c, x + 5, by - 8, 7, 7, who.fur);
      R(c, x + 7, by - 7, 2, 5, MASK);
    }
  }
  if (kind === 'juniper' && !up) {
    if (side) box(c, fx(-12, 7), by - 6, 7, 6, '#5f3b22');
    else box(c, x + 5, by - 5, 6, 5, '#5f3b22');
  }
  if (kind === 'fennel' && !up) {
    if (side) {
      box(c, fx(-13, 8), by - 14, 8, 11, who.fur);
      R(c, fx(-12, 6), by - 13, 6, 3, C.white);
      R(c, fx(-12, 6), by - 6, 6, 2, who.dark);
    } else {
      box(c, x + 5, by - 10, 6, 8, who.fur);
      R(c, x + 6, by - 9, 4, 2, C.white);
    }
  }

  // feet
  if (side) {
    const stride = frame === 1 ? 2 : frame === 3 ? -2 : 0;
    R(c, x - 3 + stride, y - 3, 4, 3, C.ink);
    R(c, x - 1 - stride, y - 3, 4, 3, C.ink);
  } else {
    R(c, x - 5, y - 3 - (frame === 1 ? 1 : 0), 4, 3, C.ink);
    R(c, x + 1, y - 3 - (frame === 3 ? 1 : 0), 4, 3, C.ink);
  }

  // body
  box(c, x - half, by - 13, half * 2, robe ? 13 : 11, body[1]);
  R(c, x + half - 3, by - 12, 2, robe ? 11 : 9, body[0]);
  R(c, x - half + 1, by - 12, 1, 8, body[2]);
  if (robe) {
    R(c, x - half + 1, by - 2, half * 2 - 2, 1, C.gold);
    R(c, x - 1, by - 11, 1, 9, body[0]);
  }
  if (wear.stripes) for (const row of [10, 7, 4]) R(c, x - half + 1, by - row, half * 2 - 2, 1, wear.stripes);
  if (wear.open && !up) {
    // a jacket worn open: the t-shirt under it, and its mark
    if (side) R(c, flip > 0 ? x + 2 : x - 4, by - 12, 2, 10, wear.open);
    else {
      R(c, x - 2, by - 12, 4, 10, wear.open);
      R(c, x - 1, by - 9, 2, 2, '#7fee64');
      R(c, x - 4, by - 12, 2, 2, body[2]);
      R(c, x + 2, by - 12, 2, 2, body[2]);
    }
  }
  const swing = frame === 1 ? 1 : frame === 3 ? -1 : 0;
  const bare = wear.sleeves === 'short' ? 3 : 0; // a t-shirt: this much of the arm below the sleeve is skin
  if (side) {
    R(c, x - 2 + swing * flip, by - 11, 4, 7, C.ink);
    R(c, x - 1 + swing * flip, by - 10, 2, 5, body[1]);
    R(c, x - 1 + swing * flip, by - 5 - bare, 2, 1 + bare, who.hand);
  } else {
    R(c, x - half - 1, by - 12 + swing, 2, 7, C.ink);
    R(c, x - half, by - 11 + swing, 1, 5, body[1]);
    R(c, x - half, by - 6 + swing - bare, 1, 1 + bare, who.hand);
    R(c, x + half - 1, by - 12 - swing, 2, 7, C.ink);
    R(c, x + half - 1, by - 11 - swing, 1, 5, body[0]);
    R(c, x + half - 1, by - 6 - swing - bare, 1, 1 + bare, who.dark);
  }
  // Seen from the side, a mark on the chest is mostly out of view: only its leading edge
  // shows, ahead of the arm (and less of it when the arm swings forward).
  const chestEdge = (top, color, shade) => {
    const wide = swing === 1 ? 1 : 2;
    const left = flip > 0 ? x + 4 - wide : x - 4;
    R(c, left, top, wide, 3, color);
    R(c, left, top + 3, wide, 1, shade);
  };

  // what they wear
  if (kind === 'bao' && !up) {
    R(c, x - 3 + (side ? flip : 0), by - 11, side ? 5 : 6, 8, C.white);
    R(c, x - 3 + (side ? flip : 0), by - 4, side ? 5 : 6, 1, '#d9d4c6');
  }
  if (kind === 'juniper') {
    R(c, x - half + 1, by - 6, half * 2 - 2, 1, C.wood[0]);
    if (!up) R(c, x + (side ? flip : 2), by - 7, 2, 3, C.glow);
  }
  if (kind === 'moss' && !up) {
    R(c, x - 4 + (side ? flip : 0), by - 10, side ? 6 : 8, 8, '#8a5a3c');
    R(c, x - 4 + (side ? flip : 0), by - 10, side ? 6 : 8, 1, '#a9744e');
    R(c, x - 1 + (side ? flip : 0), by - 6, 3, 2, '#6b4229');
  }
  if (kind === 'fennel') {
    if (!side) R(c, x, by - 12, half - 1, 10, accent[1]);
    R(c, x - half + 1, by - 5, half * 2 - 2, 1, C.ink);
  }
  if (kind === 'mo' && !up) {
    // Modal's mark on the front of his hoodie, and a green drawstring
    if (side) chestEdge(by - 9, '#7fee64', '#62de61');
    else {
      R(c, x - 3, by - 9, 3, 3, '#7fee64');
      R(c, x, by - 8, 3, 3, '#62de61');
    }
    R(c, x - 3 + (side ? flip : 0), by - 12, 6, 1, '#3a3f4a');
  }
  if (kind === 'ziggy') {
    R(c, x - half + 1, by - 12, half * 2 - 2, 1, '#7386ad'); // the hood, folded down
    if (!up) {
      R(c, x - 1 + (side ? flip : 0), by - 11, 1, 5, C.gold); // lanyard
      R(c, x - 2 + (side ? flip : 0), by - 7, 3, 3, C.white);
      R(c, x - 1 + (side ? flip : 0), by - 6, 1, 1, '#4d7ea8');
    } else {
      // seen from behind: the ringed tail
      box(c, x + 2, by - 8, 6, 8, who.fur);
      R(c, x + 3, by - 6, 4, 1, MASK);
      R(c, x + 3, by - 3, 4, 1, MASK);
    }
  }
  if (wear.mark && !up) {
    // Modal's mark on the chest
    if (side) chestEdge(by - 10, ...wear.mark);
    else {
      R(c, x - 3, by - 10, 3, 3, wear.mark[0]);
      R(c, x, by - 9, 3, 3, wear.mark[1]);
    }
  }
  if (wear.hood) {
    if (up) R(c, x - 4, by - 12, 8, 4, body[0]); // the hood, lying on the back
    else {
      R(c, x - 3 + (side ? flip : 0), by - 12, 6, 1, body[0]);
      if (!side) R(c, x - 3, by - 4, 6, 1, body[0]); // the pocket
    }
  }
  if (who.tee && !up) R(c, x - 2 + (side ? flip : 0), by - 12, side ? 3 : 4, side ? 6 : who.beard ? 9 : 3, who.tee); // what shows under an open jacket
  if (who.pocket && !up && !side) R(c, x + 1, by - 9, 3, 3, who.pocket);

  // seen from behind: tails, and what they carry on their backs
  if (up && kind === 'juniper') {
    box(c, x - 4, by - 6, 8, 7, '#5f3b22');
    for (let i = 0; i < 3; i++) R(c, x - 2 + i * 2, by - 5, 1, 5, '#4a2c18');
  }
  if (up && kind === 'fennel') {
    box(c, x - 4, by - 12, 8, 8, C.wood[3]); // the lute rides on his back
    R(c, x - 1, by - 10, 2, 2, C.ink);
    R(c, x - 1, by - 19, 2, 8, C.wood[1]);
    box(c, x + 2, by - 9, 6, 8, who.fur);
    R(c, x + 3, by - 8, 4, 2, C.white);
  }

  // ---- the head -------------------------------------------------------------------------------
  const eye = (ex, ey, w = 2, h = 2, color = C.ink) => R(c, ex, ey + (o.blink ? h - 1 : 0), w, o.blink ? 1 : h, color);

  if (who.animal === 'human') {
    const [hair, hairDark, hairLight] = who.hair || ['#6b4a34', '#4a3122', '#9a7558'];
    // glasses, a moustache or a beard, for those who have them
    const face = () => {
      if (up) return;
      if (who.beard) {
        if (side) R(c, fx(0, 6), hy + 9, 6, 3, who.beard);
        else {
          R(c, x - 6, hy + 7, 1, 3, who.beard);
          R(c, x + 5, hy + 7, 1, 3, who.beard);
          R(c, x - 5, hy + 9, 10, 3, who.beard);
          R(c, x - 1, hy + 10, 2, 1, mouth || '#d8a58a');
        }
      }
      if (who.moustache) {
        if (side) R(c, fx(2, 3), hy + 9, 3, 1, who.moustache);
        else R(c, x - 2, hy + 9, 4, 1, who.moustache);
      }
      if (who.glasses) {
        const frame = who.glasses === 'round' ? '#5a4632' : C.ink;
        if (side) {
          R(c, fx(1, 4), hy + 5, 4, 1, frame);
          R(c, fx(-5, 6), hy + 5, 6, 1, frame);
          if (who.glasses === 'round') R(c, fx(1, 4), hy + 8, 4, 1, frame);
        } else {
          R(c, x - 6, hy + 5, 12, 1, frame);
          if (who.glasses === 'round') {
            R(c, x - 5, hy + 8, 4, 1, frame);
            R(c, x + 1, hy + 8, 4, 1, frame);
            R(c, x - 5, hy + 6, 1, 2, frame);
            R(c, x + 4, hy + 6, 1, 2, frame);
          }
        }
      }
    };
    headBlock(c, x, hy, who.fur, who.dark);
    if (who.mohawk) {
      // shaved at the sides, and a tall crest down the middle
      const [crest, deep, tip] = who.mohawk;
      if (side) {
        R(c, x - 6, hy - 5, 12, 7, C.ink);
        R(c, x - 5, hy - 4, 10, 6, crest);
        R(c, x - 5, hy - 1, 10, 3, deep);
        for (let i = 0; i < 5; i++) R(c, x - 5 + i * 2, hy - 5, 1, 1, crest);
        R(c, x - 4, hy - 4, 3, 1, tip);
      } else {
        R(c, x - 3, hy - 6, 6, 9, C.ink);
        R(c, x - 2, hy - 5, 4, 8, crest);
        R(c, x + 1, hy - 5, 1, 8, deep);
        R(c, x - 2, hy - 5, 1, 3, tip);
        R(c, x - 1, hy - 7, 2, 2, C.ink);
        R(c, x - 1, hy - 6, 2, 1, crest);
      }
      if (!up) {
        if (side) eye(fx(2, 2), hy + 6);
        else {
          eye(x - 4, hy + 6);
          eye(x + 2, hy + 6);
        }
        R(c, side ? fx(2, 2) : x - 1, hy + 10, 2, 1, '#a8553f');
      }
      face();
    } else {
      const style = who.style || (who.tousled ? 'curly' : who.hair ? 'swept' : 'short');
      const over = drawHair(c, { x, hy, fx, side, up, style, tones: [hair, hairDark, hairLight] });
      if (!up) {
        if (side) eye(fx(2, 2), hy + 6);
        else {
          eye(x - 4, hy + 6);
          eye(x + 2, hy + 6);
          R(c, x - 6, hy + 8, 1, 1, who.blush || '#f0a39a');
          R(c, x + 5, hy + 8, 1, 1, who.blush || '#f0a39a');
        }
        const mx = side ? fx(2, 2) : x - 1;
        if (mouth) R(c, mx, hy + 9, 2, 2, mouth);
        else R(c, mx, hy + 10, 2, 1, who.lips || '#a8553f');
        face();
      }
      over?.();
    }
  } else if (who.animal === 'modal') {
    // the two peaks of Modal's mark stand up from his head
    const peak = (px, lean) => {
      for (let i = 0; i < 7; i++) {
        const w = Math.max(2, 7 - i);
        R(c, px + Math.round(i * 0.5 * lean) - 1, hy + 1 - i, w + 2, 1, C.ink);
      }
      R(c, px + Math.round(3 * lean), hy - 6, 3, 1, C.ink);
      for (let i = 0; i < 6; i++) {
        const w = Math.max(2, 7 - i);
        R(c, px + Math.round(i * 0.5 * lean), hy + 1 - i, w, 1, i % 2 ? who.fur : who.dark);
      }
    };
    if (side) peak(x - 3, flip);
    else {
      peak(x - 8, 1);
      peak(x + 1, 1);
    }
    headBlock(c, x, hy, who.fur, who.dark);
    R(c, x - 5, hy + 1, 10, 1, '#d6ffc9');
    if (front) {
      eye(x - 4, hy + 5, 2, 3, '#181818');
      eye(x + 2, hy + 5, 2, 3, '#181818');
      R(c, x - 6, hy + 9, 2, 1, '#d6ffc9');
      R(c, x + 4, hy + 9, 2, 1, '#d6ffc9');
      R(c, x - 2, hy + 10, 4, 1, '#181818');
      if (mouth) R(c, x - 1, hy + 11, 2, 1, mouth);
    } else if (side) {
      eye(fx(2, 2), hy + 5, 2, 3, '#181818');
      R(c, fx(3, 3), hy + 10, 3, 1, '#181818');
      if (mouth) R(c, fx(4, 2), hy + 11, 2, 1, mouth);
    }
  } else if (who.animal === 'raccoon') {
    const ear = (ex) => {
      R(c, ex, hy - 3, 5, 5, C.ink);
      R(c, ex + 1, hy - 2, 3, 4, who.fur);
      R(c, ex + 1, hy - 2, 3, 1, MASK);
    };
    if (side) ear(fx(-5, 5));
    else {
      ear(x - 7);
      ear(x + 2);
    }
    headBlock(c, x, hy, who.fur, who.dark);
    if (front) {
      R(c, x - 6, hy + 4, 12, 4, MASK); // the mask
      R(c, x - 1, hy + 4, 2, 4, who.fur);
      R(c, x - 5, hy + 3, 4, 1, C.white);
      R(c, x + 1, hy + 3, 4, 1, C.white);
      eye(x - 4, hy + 5, 2, 2, C.white);
      eye(x + 2, hy + 5, 2, 2, C.white);
      R(c, x - 3, hy + 8, 6, 4, C.white);
      R(c, x - 1, hy + 8, 2, 2, C.ink);
      R(c, x - 1, hy + 11, 2, mouth ? 2 : 1, mouth || '#b9b3c6');
    } else if (side) {
      R(c, fx(0, 6), hy + 4, 6, 4, MASK);
      R(c, fx(0, 5), hy + 3, 5, 1, C.white);
      eye(fx(2, 2), hy + 5, 2, 2, C.white);
      R(c, fx(3, 5), hy + 8, 5, 4, C.ink);
      R(c, fx(3, 4), hy + 8, 4, 3, C.white);
      R(c, fx(6, 2), hy + 8, 2, 2, C.ink);
      if (mouth) R(c, fx(3, 3), hy + 11, 3, 1, mouth);
    }
  } else if (who.animal === 'goat') {
    const HORN = '#c9b384';
    // ears stick straight out sideways, under the brim of the hat
    if (side) {
      R(c, fx(-11, 6), hy + 5, 6, 4, C.ink);
      R(c, fx(-10, 5), hy + 6, 5, 2, who.fur);
    } else {
      R(c, x - 12, hy + 5, 6, 4, C.ink);
      R(c, x - 11, hy + 6, 5, 2, who.fur);
      R(c, x - 11, hy + 7, 3, 1, PINK);
      R(c, x + 6, hy + 5, 6, 4, C.ink);
      R(c, x + 6, hy + 6, 5, 2, who.fur);
      R(c, x + 8, hy + 7, 3, 1, PINK);
    }
    headBlock(c, x, hy, who.fur, who.dark);
    if (front) {
      // yellow eyes with a sideways slit
      for (const ex of [x - 5, x + 2]) {
        R(c, ex, hy + 4, 3, 3, o.blink ? who.fur : '#f2d24a');
        R(c, ex, hy + 5, 3, 1, C.ink);
      }
      R(c, x - 3, hy + 7, 6, 4, C.white);
      R(c, x - 1, hy + 7, 2, 1, PINK);
      R(c, x - 1, hy + 9, 2, mouth ? 2 : 1, mouth || '#b9a59a');
      // the goatee
      R(c, x - 3, hy + 11, 6, 4, C.ink);
      R(c, x - 2, hy + 11, 4, 3, C.white);
      R(c, x - 2, hy + 14, 4, 4, C.ink);
      R(c, x - 1, hy + 14, 2, 3, C.white);
    } else if (side) {
      R(c, fx(1, 3), hy + 4, 3, 3, o.blink ? who.fur : '#f2d24a');
      R(c, fx(1, 3), hy + 5, 3, 1, C.ink);
      R(c, fx(3, 6), hy + 6, 6, 6, C.ink);
      R(c, fx(3, 5), hy + 7, 5, 4, C.white);
      R(c, fx(7, 1), hy + 7, 1, 1, PINK);
      if (mouth) R(c, fx(5, 2), hy + 10, 2, 1, mouth);
      R(c, fx(2, 4), hy + 11, 4, 7, C.ink);
      R(c, fx(3, 2), hy + 11, 2, 6, C.white);
    }
    // little horns either side of the hat
    if (side) {
      R(c, fx(-10, 4), hy - 4, 4, 6, C.ink);
      R(c, fx(-9, 2), hy - 3, 2, 5, HORN);
    } else {
      for (const hx of [x - 12, x + 8]) {
        R(c, hx, hy - 4, 4, 6, C.ink);
        R(c, hx + 1, hy - 3, 2, 5, HORN);
        R(c, hx + 1, hy - 1, 2, 1, '#a8905e');
      }
    }
    // pointed hat with stars
    R(c, x - 9, hy + 1, 18, 3, C.ink);
    R(c, x - 8, hy + 2, 16, 1, accent[1]);
    let top = hy + 1;
    for (const [w, h] of [[6, 3], [5, 3], [4, 3], [3, 3], [2, 2]]) {
      top -= h;
      const lean = top < hy - 8 ? flip : 0;
      R(c, x - w + lean - 1, top, w * 2 + 2, h + 1, C.ink);
      R(c, x - w + lean, top + 1, w * 2, h, accent[1]);
      R(c, x - w + lean, top + 1, Math.max(1, w - 2), h, accent[2]);
    }
    R(c, x - 2, hy - 3, 1, 1, C.glow);
    R(c, x + 2, hy - 7, 1, 1, C.glow);
    R(c, x - 1, hy - 10, 1, 1, C.glow);
    // staff with a glowing orb
    const sx = x + (o.dir === 'left' ? -10 : 10);
    R(c, sx - 1, by - 21, 3, 21, C.ink);
    R(c, sx, by - 20, 1, 19, C.wood[3]);
    EO(c, sx, by - 23, 2, 2, Math.floor(t * 3) % 2 ? '#d9c2ff' : '#9be8ff');
    R(c, sx - 1, by - 24, 1, 1, C.white);
  } else if (who.animal === 'beaver') {
    const MUZZLE = '#e2b98a';
    const NOSE = '#3a2416';
    if (side) {
      box(c, fx(-6, 5), hy - 2, 5, 5, who.fur);
      R(c, fx(-4, 1), hy, 1, 1, who.dark);
    } else {
      box(c, x - 8, hy - 2, 5, 5, who.fur);
      box(c, x + 3, hy - 2, 5, 5, who.fur);
      if (front) {
        R(c, x - 6, hy, 1, 1, who.dark);
        R(c, x + 5, hy, 1, 1, who.dark);
      }
    }
    headBlock(c, x, hy, who.fur, who.dark);
    R(c, x - 6, hy + 2, 12, 1, C.wood[0]); // the strap of her goggles
    if (front) {
      R(c, x - 5, hy + 1, 4, 3, C.ink);
      R(c, x + 1, hy + 1, 4, 3, C.ink);
      R(c, x - 4, hy + 2, 2, 1, '#bfe6f2');
      R(c, x + 2, hy + 2, 2, 1, '#bfe6f2');
      eye(x - 4, hy + 5);
      eye(x + 2, hy + 5);
      R(c, x - 4, hy + 7, 8, 5, MUZZLE);
      R(c, x - 2, hy + 7, 4, 2, NOSE);
      // two very large front teeth
      const open = mouth ? 1 : 0;
      R(c, x - 3, hy + 9 + open, 6, 5, C.ink);
      R(c, x - 2, hy + 9 + open, 2, 4, C.white);
      R(c, x, hy + 9 + open, 2, 4, '#e6dfcc');
    } else if (side) {
      R(c, fx(1, 4), hy + 1, 4, 3, C.ink);
      R(c, fx(2, 2), hy + 2, 2, 1, '#bfe6f2');
      eye(fx(2, 2), hy + 5);
      R(c, fx(3, 5), hy + 7, 5, 5, C.ink);
      R(c, fx(3, 4), hy + 7, 4, 4, MUZZLE);
      R(c, fx(6, 2), hy + 7, 2, 2, NOSE);
      const open = mouth ? 1 : 0;
      R(c, fx(3, 4), hy + 10 + open, 4, 4, C.ink);
      R(c, fx(4, 2), hy + 10 + open, 2, 3, C.white);
    }
  } else if (who.animal === 'capybara') {
    const SNOUT = '#d2ab7b';
    const NOSE = '#4a3220';
    if (side) box(c, fx(-5, 4), hy - 1, 4, 4, who.dark);
    else {
      box(c, x - 7, hy - 1, 4, 4, who.dark);
      box(c, x + 3, hy - 1, 4, 4, who.dark);
    }
    headBlock(c, x, hy, who.fur, who.dark);
    if (front) {
      // nothing troubles him: his eyes are two calm lines
      R(c, x - 6, hy + 5, 3, 1, C.ink);
      R(c, x + 3, hy + 5, 3, 1, C.ink);
      R(c, x - 5, hy + 7, 10, 5, SNOUT);
      R(c, x - 3, hy + 8, 2, 1, NOSE);
      R(c, x + 1, hy + 8, 2, 1, NOSE);
      R(c, x - 1, hy + 10, 2, mouth ? 2 : 1, mouth || NOSE);
    } else if (side) {
      R(c, fx(0, 3), hy + 5, 3, 1, C.ink);
      R(c, fx(1, 8), hy + 6, 8, 7, C.ink);
      R(c, fx(1, 7), hy + 7, 7, 5, SNOUT);
      R(c, fx(6, 1), hy + 8, 1, 1, NOSE);
      R(c, fx(4, 3), hy + 10, 3, mouth ? 2 : 1, mouth || NOSE);
    }
    // the orange he keeps on his head; it wobbles when he walks
    const wobble = o.moving ? (frame % 2 ? 1 : -1) : 0;
    EO(c, x + wobble, hy - 3, 3, 3, '#f59a2a');
    R(c, x - 2 + wobble, hy - 5, 2, 1, '#ffd27a');
    R(c, x + wobble, hy - 8, 1, 2, C.wood[0]);
    R(c, x + 1 + wobble, hy - 8, 2, 1, C.leaf[2]);
  } else if (who.animal === 'frog') {
    const BELLY = '#e2f1b8';
    const LINE = '#3f6f2e';
    headBlock(c, x, hy, who.fur, who.dark);
    // the toadstool that grows on her head
    R(c, x - 2, hy - 3, 4, 4, C.ink);
    R(c, x - 1, hy - 3, 2, 3, C.white);
    box(c, x - 6, hy - 9, 12, 7, accent[1]);
    R(c, x - 5, hy - 8, 3, 2, accent[2]);
    R(c, x - 3, hy - 8, 2, 2, C.white);
    R(c, x + 2, hy - 6, 2, 2, C.white);
    R(c, x - 5, hy - 5, 1, 1, C.white);
    if (side) {
      box(c, fx(1, 6), hy - 2, 6, 6, who.fur);
      R(c, fx(2, 4), hy - 1, 4, 4, C.white);
      if (o.blink) R(c, fx(2, 4), hy + 1, 4, 1, C.ink);
      else R(c, fx(4, 2), hy, 2, 2, C.ink);
      R(c, fx(-1, 7), hy + 8, 7, 4, BELLY);
      R(c, fx(-1, 8), hy + 7, 8, 1, LINE);
      if (mouth) R(c, fx(2, 4), hy + 8, 4, 2, '#c2475a');
    } else {
      box(c, x - 8, hy - 2, 6, 6, who.fur);
      box(c, x + 2, hy - 2, 6, 6, who.fur);
      if (front) {
        R(c, x - 7, hy - 1, 4, 4, C.white);
        R(c, x + 3, hy - 1, 4, 4, C.white);
        if (o.blink) {
          R(c, x - 7, hy + 1, 4, 1, C.ink);
          R(c, x + 3, hy + 1, 4, 1, C.ink);
        } else {
          R(c, x - 5, hy, 2, 2, C.ink);
          R(c, x + 3, hy, 2, 2, C.ink);
        }
        R(c, x - 5, hy + 8, 10, 4, BELLY);
        R(c, x - 6, hy + 7, 12, 1, LINE);
        R(c, x - 6, hy + 6, 1, 1, LINE);
        R(c, x + 5, hy + 6, 1, 1, LINE);
        if (mouth) R(c, x - 3, hy + 8, 6, 2, '#c2475a');
      }
    }
    // her watering can
    if (!up) {
      const cx = x + (o.dir === 'left' ? -11 : 9);
      box(c, cx - 2, by - 9, 6, 6, C.steel[2]);
      R(c, cx - 1, by - 8, 1, 4, C.white);
      R(c, cx + (o.dir === 'left' ? -4 : 4), by - 8, 2, 1, C.ink);
      R(c, cx + (o.dir === 'left' ? -5 : 5), by - 9, 2, 1, C.ink);
      R(c, cx, by - 11, 3, 1, C.ink);
    }
  } else if (who.animal === 'fennec') {
    // ears taller than his head
    const ear = (left, lean, inner) => {
      const rows = [];
      for (let i = 0; i < 11; i++) {
        const w = Math.max(2, 7 - Math.floor(i * 0.55));
        const drift = Math.floor(i / 3) * lean;
        const ex = lean < 0 ? left + drift : left + drift + (7 - w);
        rows.push([ex, hy + 2 - i, w]);
      }
      for (const [ex, ey, w] of rows) R(c, ex - 1, ey, w + 2, 1, C.ink);
      R(c, rows[10][0], rows[10][1] - 1, rows[10][2], 1, C.ink);
      for (const [ex, ey, w] of rows) R(c, ex, ey, w, 1, inner ? who.fur : who.dark);
      if (inner) for (const [ex, ey, w] of rows.slice(1, 8)) if (w > 3) R(c, ex + (lean < 0 ? 1 : 2), ey, w - 3, 1, PINK);
    };
    if (side) ear(flip > 0 ? x - 9 : x + 2, -flip, true);
    else {
      ear(x - 10, -1, front);
      ear(x + 3, 1, front);
    }
    headBlock(c, x, hy, who.fur, who.dark);
    if (front) {
      eye(x - 5, hy + 4, 2, 3);
      eye(x + 3, hy + 4, 2, 3);
      R(c, x - 6, hy + 7, 2, 4, C.white);
      R(c, x + 4, hy + 7, 2, 4, C.white);
      R(c, x - 3, hy + 7, 6, 5, C.white);
      R(c, x - 1, hy + 7, 2, 2, C.ink);
      R(c, x - 1, hy + 10, 2, mouth ? 2 : 1, mouth || '#d9b9a0');
    } else if (side) {
      eye(fx(1, 2), hy + 4, 2, 3);
      R(c, fx(3, 6), hy + 6, 6, 6, C.ink);
      R(c, fx(3, 5), hy + 7, 5, 4, C.white);
      R(c, fx(7, 2), hy + 7, 2, 2, C.ink);
      if (mouth) R(c, fx(5, 2), hy + 10, 2, 1, mouth);
    }
    // a small cap with a very long feather
    R(c, x - 4, hy - 2, 8, 4, C.ink);
    R(c, x - 3, hy - 1, 6, 2, body[1]);
    R(c, x - 3, hy - 1, 6, 1, body[2]);
    for (let i = 0; i < 6; i++) R(c, fx(1 + i, 2), hy - 3 - i, 2, 2, i < 4 ? accent[1] : accent[2]);
    // the lute, held across him
    if (!up) {
      const lx = x + (side ? flip * 3 : 4);
      box(c, lx - 3, by - 9, 7, 7, C.wood[3]);
      R(c, lx - 1, by - 7, 2, 2, C.ink);
      R(c, lx - 2, by - 8, 1, 4, C.wood[4]);
      const neck = o.dir === 'left' ? 1 : -1;
      for (let i = 1; i <= 6; i++) R(c, lx + neck * (2 + i), by - 9 - i, 2, 2, i > 5 ? C.ink : C.wood[1]);
    }
  }

  const tall = { orlo: 22, moss: 16, fennel: 16, bao: 14 }[kind] || 9;
  if (o.bubble) drawBubble(c, x + 8, hy - tall, o.bubble, t);
}

// Wisp has no feet to put on the ground: a pale shape that floats, with a lantern. The ears
// and whiskers say she was probably a cat.
function drawGhost(c, x, y, o) {
  const t = o.t || 0;
  const float = Math.round(Math.sin(t * 2.2) * 2);
  const flip = o.dir === 'left' ? -1 : 1;
  const side = o.dir === 'left' || o.dir === 'right';
  const top = y - 30 + float;
  const pale = ramp(o.color);
  const dusk = o.accent;
  const sheet = (fill, inset) => {
    // head and body as one rounded drape, with a hem that ripples
    for (let row = inset; row < 26 - inset; row++) {
      const yy = top + row;
      const half = row < 6 ? 4 + Math.floor(row * 0.8) : row > 19 ? 8 - Math.floor((row - 19) / 3) : 8;
      R(c, x - half + inset, yy, (half - inset) * 2, 1, fill);
    }
    for (let i = -2; i <= 2; i++) {
      const drop = (Math.floor(t * 3) + i + 4) % 2 ? 2 : 0;
      R(c, x + i * 3 - 1 + (inset ? 0 : -1), top + 25 - inset, inset ? 2 : 4, 2 + drop - inset, fill);
    }
  };
  // the shadow is small and faint: she is a long way off the ground
  E(c, x, y, 5, 1, 'rgba(26, 20, 44, .18)');
  c.globalAlpha = 0.9;
  // cat ears
  for (const ex of [x - 6, x + 2]) {
    R(c, ex, top - 3, 5, 5, dusk);
    R(c, ex + 1, top - 2, 3, 4, pale[1]);
    R(c, ex + 2, top - 1, 1, 2, '#f0b8c8');
  }
  sheet(dusk, 0);
  sheet(pale[1], 1);
  c.globalAlpha = 1;
  R(c, x - 6, top + 4, 2, 12, C.white);
  R(c, x + 4, top + 8, 2, 12, pale[0]);
  if (o.dir !== 'up') {
    const ex = side ? flip * 2 : 0;
    const open = o.blink ? 1 : 3;
    R(c, x - 4 + ex, top + 8 + (o.blink ? 1 : 0), 2, open, C.ink);
    R(c, x + 2 + ex, top + 8 + (o.blink ? 1 : 0), 2, open, C.ink);
    R(c, x - 1 + ex, top + 12, 2, 1, '#f0b8c8'); // nose
    if (o.talking) R(c, x - 1 + ex, top + 13, 2, 3, C.ink);
    // whiskers
    R(c, x - 9 + ex, top + 12, 3, 1, dusk);
    R(c, x + 6 + ex, top + 12, 3, 1, dusk);
    R(c, x - 9 + ex, top + 14, 3, 1, dusk);
    R(c, x + 6 + ex, top + 14, 3, 1, dusk);
  }
  // a stubby arm and the lantern she carries
  const lx = x + (o.dir === 'left' ? -11 : 11);
  R(c, x + (o.dir === 'left' ? -9 : 7), top + 17, 3, 2, pale[1]);
  R(c, lx, top + 15, 1, 4, C.ink);
  box(c, lx - 2, top + 19, 5, 6, Math.floor(t * 3) % 2 ? '#9fe2ff' : '#d6f4ff');
  R(c, lx - 1, top + 21, 1, 2, C.white);
  if (o.bubble) drawBubble(c, x + 9, top - 10, o.bubble, t);
}

// Dot is not shaped like the others: a box on treads, with a visor and an aerial.
function drawRobot(c, x, y, o) {
  const t = o.t || 0;
  const frame = o.moving ? o.frame : 0;
  const bob = o.moving ? frame % 2 : 0;
  const side = o.dir === 'left' || o.dir === 'right';
  const flip = o.dir === 'left' ? -1 : 1;
  const by = y - bob;
  const steel = ramp(o.color);
  const trim = ramp(o.accent);
  E(c, x, y, 7, 2, C.shade);
  // treads
  box(c, x - 7, y - 4, 14, 5, '#3a3f4c');
  for (let i = 0; i < 4; i++) R(c, x - 5 + i * 3 + ((o.moving ? frame % 3 : 0) % 3), y - 2, 1, 1, C.steel[2]);
  // body
  box(c, x - 6, by - 14, 12, 11, steel[1]);
  R(c, x + 3, by - 13, 2, 9, steel[0]);
  R(c, x - 5, by - 13, 1, 8, steel[2]);
  if (o.dir !== 'up') {
    R(c, x - 3 + (side ? flip : 0), by - 11, 6, 5, '#1c2130');
    R(c, x - 2 + (side ? flip : 0), by - 10, 1, 1, Math.floor(t * 2) % 2 ? '#58d06a' : '#2c6a41');
    R(c, x + (side ? flip : 0), by - 10, 2, 1, trim[1]);
    R(c, x - 2 + (side ? flip : 0), by - 8, 4, 1, '#62b0e8');
  } else {
    for (let i = 0; i < 3; i++) R(c, x - 3, by - 11 + i * 2, 6, 1, steel[0]);
  }
  // arms
  const swing = o.moving ? (frame === 1 ? 1 : frame === 3 ? -1 : 0) : 0;
  R(c, x - 8, by - 12 + swing, 2, 7, C.ink);
  R(c, x - 8, by - 6 + swing, 3, 2, trim[1]);
  R(c, x + 6, by - 12 - swing, 2, 7, C.ink);
  R(c, x + 5, by - 6 - swing, 3, 2, trim[1]);
  // head
  const hy = by - 25;
  box(c, x - 7, hy + 1, 14, 11, steel[2]);
  R(c, x - 6, hy + 2, 12, 1, C.white);
  R(c, x + 4, hy + 3, 2, 8, steel[1]);
  if (o.dir !== 'up') {
    const vx = side ? x - 4 + flip * 2 : x - 5;
    R(c, vx, hy + 4, side ? 8 : 10, 5, '#1c2130');
    const open = o.blink ? 1 : 2;
    const glow = o.talking ? C.white : '#7ef0ff';
    if (side) R(c, x + flip * 3 - (flip > 0 ? 1 : 0), hy + 5 + (o.blink ? 1 : 0), 2, open, glow);
    else {
      R(c, x - 4, hy + 5 + (o.blink ? 1 : 0), 2, open, glow);
      R(c, x + 2, hy + 5 + (o.blink ? 1 : 0), 2, open, glow);
    }
    R(c, x - 2, hy + 10, 4, 1, o.talking && Math.floor(t * 10) % 2 ? trim[1] : C.ink);
  } else {
    R(c, x - 4, hy + 5, 8, 1, steel[0]);
    R(c, x - 4, hy + 8, 8, 1, steel[0]);
  }
  // aerial
  R(c, x, hy - 3, 1, 5, C.ink);
  box(c, x - 2, hy - 6, 5, 4, Math.floor(t * 1.5) % 2 ? '#ff6b5e' : '#8a2f33');
  if (o.bubble) drawBubble(c, x + 9, hy - 11, o.bubble, t);
}

function drawBubble(c, x, y, what, t) {
  box(c, x - 6, y - 5, 13, 10, C.white);
  R(c, x - 4, y + 5, 3, 1, C.ink);
  R(c, x - 4, y + 4, 2, 1, C.white);
  R(c, x - 5, y + 6, 2, 1, C.ink);
  if (what === 'working') {
    // a tiny blinking cursor and a line of "code"
    R(c, x - 4, y - 2, 5, 1, '#3d8a4b');
    R(c, x - 4, y + 1, 3, 1, '#3d8a4b');
    if (Math.floor(t * 4) % 2) R(c, x, y + 1, 2, 1, C.ink);
  } else if (what === 'alert') {
    R(c, x - 1, y - 3, 2, 4, '#d1493f');
    R(c, x - 1, y + 2, 2, 1, '#d1493f');
  } else {
    const on = Math.floor(t * 4) % 4;
    for (let i = 0; i < 3; i++) R(c, x - 4 + i * 4, y - (on === i ? 1 : 0), 2, 2, C.ink);
  }
}

// How far above a villager's feet their speech bubble should start (hats and ears differ).
export function heightOf(kind) {
  return { orlo: 46, moss: 42, fennel: 42, bao: 40, wisp: 38, mo: 40, ziggy: 36 }[kind] || 34;
}
