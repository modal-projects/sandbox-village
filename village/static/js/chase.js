// Cold Start Chase: the game on the TV in the robot's house.
//
// You are Mo. Collect every request (the pale dots). Three cold starts wander the maze after
// you; touch one and the game is over. A snapshot crystal freezes them for a few seconds, and
// while they are frozen you can run into them to warm them up: points, and they start over.
// The maze itself comes from the villager's sandbox (see village/arcade.py); this file only
// draws it and runs the chase, because a round trip to a sandbox is too slow for that.

const CELL = 16;
const GREEN = '#7fee64';
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
// The points that float up when a cold start is caught: "+", and the digits those scores use.
const GLYPHS = {
  '+': [0, 2, 7, 2, 0],
  0: [7, 5, 5, 5, 7],
  1: [2, 6, 2, 2, 7],
  2: [7, 1, 7, 4, 7],
  4: [5, 5, 7, 1, 1],
  6: [7, 4, 7, 5, 7],
  8: [7, 5, 7, 5, 7],
};

// grid: rows of text (# wall, . request, S crystal, C cold start, P player)
// hooks: onScore(points), onEnd({ won }), sound(name: dot, freeze, warm, caught)
export function startChase(canvas, { grid, level = 1, onScore = () => {}, onEnd = () => {}, sound = () => {} }) {
  const rows = grid.length;
  const cols = grid[0].length;
  canvas.width = cols * CELL;
  canvas.height = rows * CELL;
  const c = canvas.getContext('2d');
  c.imageSmoothingEnabled = false;

  const open = (x, y) => y >= 0 && y < rows && x >= 0 && x < cols && grid[y][x] !== '#';
  const key = (x, y) => `${x},${y}`;
  const dots = new Set();
  const crystals = new Set();
  const chasers = [];
  let player = null;
  grid.forEach((line, y) => {
    [...line].forEach((mark, x) => {
      if (mark === '.') dots.add(key(x, y));
      else if (mark === 'S') crystals.add(key(x, y));
      else if (mark === 'C') chasers.push({ x, y, fx: x, fy: y, dir: [0, 0], step: 0, home: [x, y], away: 0 });
      else if (mark === 'P') player = { x, y, fx: x, fy: y, dir: [0, 0], want: null, step: 0 };
    });
  });

  const playerSpeed = 6; // cells a second
  const chaserSpeed = Math.min(5.2, 3.3 + level * 0.35);
  const FREEZE_S = 6;
  const AWAY_S = 4; // how long a warmed-up cold start stays out of the maze
  let frozenFor = 0;
  let warmed = 0; // how many you have caught on this crystal: each is worth double the last
  const popups = []; // "+200" where one was caught
  let started = false;
  let over = false;
  let frame = 0;
  let last = performance.now();
  let clock = 0;

  // An entity walks from cell (x, y) one step in `dir`; `step` runs 0..1 along the way.
  function advance(body, speed, dt, choose) {
    let budget = speed * dt;
    while (budget > 0) {
      if (body.dir[0] === 0 && body.dir[1] === 0) {
        choose(body);
        if (body.dir[0] === 0 && body.dir[1] === 0) break;
      }
      const need = 1 - body.step;
      if (budget < need) {
        body.step += budget;
        budget = 0;
      } else {
        budget -= need;
        body.x += body.dir[0];
        body.y += body.dir[1];
        body.step = 0;
        const came = body.dir;
        body.dir = [0, 0];
        choose(body, came);
      }
    }
    body.fx = body.x + body.dir[0] * body.step;
    body.fy = body.y + body.dir[1] * body.step;
  }

  function steerPlayer(body, came = [0, 0]) {
    const mark = key(body.x, body.y);
    if (dots.delete(mark)) {
      onScore(10);
      sound('dot');
    }
    if (crystals.delete(mark)) {
      frozenFor = FREEZE_S;
      warmed = 0;
      onScore(50);
      sound('freeze');
    }
    if (body.want && open(body.x + body.want[0], body.y + body.want[1])) body.dir = body.want;
    else if (open(body.x + came[0], body.y + came[1]) && (came[0] || came[1])) body.dir = came;
  }

  function steerChaser(body, came = [0, 0]) {
    let ways = DIRS.filter(([dx, dy]) => open(body.x + dx, body.y + dy));
    const forward = ways.filter(([dx, dy]) => !(dx === -came[0] && dy === -came[1]));
    if (forward.length) ways = forward; // only turn back at a dead end
    if (!ways.length) return;
    if (Math.random() < 0.3) {
      body.dir = ways[Math.floor(Math.random() * ways.length)];
      return;
    }
    const far = ([dx, dy]) => Math.abs(body.x + dx - player.x) + Math.abs(body.y + dy - player.y);
    body.dir = ways.reduce((best, way) => (far(way) < far(best) ? way : best));
  }

  function tick(dt) {
    clock += dt;
    if (!started || over) return;
    frozenFor = Math.max(0, frozenFor - dt);
    advance(player, playerSpeed, dt, steerPlayer);
    for (const chaser of chasers) {
      if (chaser.away > 0) chaser.away = Math.max(0, chaser.away - dt);
      else if (frozenFor <= 0) advance(chaser, chaserSpeed, dt, steerChaser);
    }
    const touching = chasers.filter((chaser) => chaser.away <= 0 && Math.hypot(chaser.fx - player.fx, chaser.fy - player.fy) < 0.6);
    if (frozenFor > 0) {
      for (const chaser of touching) {
        const points = 200 * 2 ** warmed;
        warmed += 1;
        popups.push({ x: chaser.fx, y: chaser.fy, text: `+${points}`, until: clock + 0.9 });
        Object.assign(chaser, { x: chaser.home[0], y: chaser.home[1], fx: chaser.home[0], fy: chaser.home[1], dir: [0, 0], step: 0, away: AWAY_S });
        onScore(points);
        sound('warm');
      }
    } else if (touching.length) {
      over = true;
      sound('caught');
      onEnd({ won: false });
    } else if (!dots.size) {
      over = true;
      onEnd({ won: true });
    }
  }

  const R = (x, y, w, h, color) => {
    c.fillStyle = color;
    c.fillRect(Math.round(x), Math.round(y), w, h);
  };

  function draw() {
    R(0, 0, canvas.width, canvas.height, '#0d1512');
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (grid[y][x] !== '#') continue;
        const px = x * CELL;
        const py = y * CELL;
        R(px, py, CELL, CELL, '#16241c');
        // a green edge wherever a wall faces a passage
        if (open(x, y - 1)) R(px, py, CELL, 2, '#3d7a3a');
        if (open(x, y + 1)) R(px, py + CELL - 2, CELL, 2, '#2d5a2d');
        if (open(x - 1, y)) R(px, py, 2, CELL, '#3d7a3a');
        if (open(x + 1, y)) R(px + CELL - 2, py, 2, CELL, '#2d5a2d');
      }
    }
    for (const mark of dots) {
      const [x, y] = mark.split(',').map(Number);
      R(x * CELL + 7, y * CELL + 7, 2, 2, '#d6ffc9');
    }
    for (const mark of crystals) {
      const [x, y] = mark.split(',').map(Number);
      const cx = x * CELL + 8;
      const cy = y * CELL + 8 + (Math.floor(clock * 3) % 2);
      R(cx - 1, cy - 5, 2, 10, '#9fe2ff');
      R(cx - 3, cy - 3, 6, 6, '#9fe2ff');
      R(cx - 4, cy - 1, 8, 2, '#9fe2ff');
      R(cx - 1, cy - 3, 2, 3, '#ffffff');
    }
    const frozen = frozenFor > 0;
    const thawing = frozen && frozenFor < 1.5 && Math.floor(clock * 8) % 2;
    for (const chaser of chasers) {
      // warmed up: out of the maze, then it flickers back in where it began
      if (chaser.away > 1.2 || (chaser.away > 0 && Math.floor(clock * 8) % 2)) continue;
      const px = chaser.fx * CELL + 2;
      const py = chaser.fy * CELL + 3;
      const ice = frozen && !thawing ? '#5f7f99' : '#bfe6ff';
      // a lump of frost with a spiky crown
      R(px + 1, py + 1, 10, 10, '#1f4f6a');
      R(px, py + 3, 12, 6, '#1f4f6a');
      R(px + 2, py + 2, 8, 8, ice);
      R(px + 1, py + 4, 10, 4, ice);
      R(px + 2, py - 1, 2, 3, ice);
      R(px + 5, py - 2, 2, 4, ice);
      R(px + 8, py - 1, 2, 3, ice);
      R(px + 3, py + 5, 2, 2, '#1f4f6a');
      R(px + 7, py + 5, 2, 2, '#1f4f6a');
      if (!frozen) R(px + 4, py + 8, 4, 1, '#1f4f6a');
    }
    // Mo: a green head with two peaks
    const px = player.fx * CELL + 2;
    const py = player.fy * CELL + 2;
    const bob = started && !over ? Math.floor(clock * 10) % 2 : 0;
    R(px, py + 4, 12, 9, '#181818');
    R(px + 1, py + 5 - bob, 10, 7, GREEN);
    R(px + 1, py + 1 - bob, 4, 4, '#181818');
    R(px + 7, py + 1 - bob, 4, 4, '#181818');
    R(px + 2, py + 2 - bob, 2, 3, GREEN);
    R(px + 8, py + 2 - bob, 2, 3, GREEN);
    R(px + 3, py + 7 - bob, 2, 2, '#181818');
    R(px + 7, py + 7 - bob, 2, 2, '#181818');
    if (over && dots.size) {
      R(px + 3, py + 7, 2, 2, '#e0685c');
      R(px + 7, py + 7, 2, 2, '#e0685c');
    }
    for (const popup of popups) {
      if (popup.until < clock) continue;
      const rise = Math.round((0.9 - (popup.until - clock)) * 10);
      const left = popup.x * CELL + 8 - popup.text.length * 2;
      const top = popup.y * CELL + 1 - rise;
      R(left - 2, top - 2, popup.text.length * 4 + 3, 9, '#181818');
      [...popup.text].forEach((glyph, i) => {
        // each glyph is five rows of three pixels, top to bottom
        GLYPHS[glyph].forEach((row, y) => {
          for (let x = 0; x < 3; x++) if (row & (4 >> x)) R(left + i * 4 + x, top + y, 1, 1, '#ffe9a8');
        });
      });
    }
  }

  function loop(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    tick(dt);
    draw();
    frame = requestAnimationFrame(loop);
  }
  frame = requestAnimationFrame(loop);

  return {
    // dir: [dx, dy]. The first press starts the chase.
    steer(dir) {
      if (over) return;
      player.want = dir;
      started = true;
    },
    stop() {
      cancelAnimationFrame(frame);
    },
    get left() {
      return dots.size;
    },
    // where everything is, for a program that plays the game
    get scene() {
      return { player: { x: player.x, y: player.y }, frozen: frozenFor, chasers: chasers.map(({ x, y, away }) => ({ x, y, away })), crystals: [...crystals], dots: [...dots] };
    },
  };
}
