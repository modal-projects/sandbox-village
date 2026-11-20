// A walk through the game in a real browser, against the offline server (no Modal, no model).
//
//     npm install          (once: gets Playwright; then `npx playwright install chromium`)
//     node tests/smoke.js  (or: npm run smoke)
//
// It starts `python -m village.dev --offline --quiet` itself on a spare port, plays the first
// few minutes the way a visitor would, and exits non-zero if anything is missing or the page
// throws. Options: --url http://host:port (use a server that is already running),
// --shots DIR (save a screenshot of each step), --python PATH (which Python starts the server).
//
// What it covers: the title screen, Mo's welcome, waking a villager, a conversation and a gift,
// going indoors, the glossary on Mo's table, the game on his screen, ringing the bell, the
// signs, the almanac ticking itself off, Ziggy's dare (a house falls and comes back from its
// snapshot), and the same first steps at phone size, where a tap has to find its way round.

const { chromium, devices } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const option = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const PORT = 8799;
const URL = option('--url', `http://127.0.0.1:${PORT}`);
const SHOTS = option('--shots');
const PYTHON = option('--python', process.env.PYTHON || 'python3');

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? '  ok  ' : 'FAILED'} ${what}`);
  if (!ok) failures.push(what);
};

async function startServer() {
  if (option('--url')) return null;
  const server = spawn(PYTHON, ['-m', 'village.dev', '--offline', '--quiet', '--port', String(PORT)], { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${URL}/`)).ok) return server; // the page itself: the API needs to know whose village
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  server.kill();
  throw new Error(`the offline server did not start (${PYTHON} -m village.dev --offline)`);
}

// The game keeps its state on window.__village; the test reads it, and moves the player by
// setting a place to stand (walking every street would only test the test's patience).
function helpers(page) {
  const G = (fn, arg) => page.evaluate(fn, arg);
  const until = async (fn, arg, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await G(fn, arg)) return true;
      await page.waitForTimeout(100);
    }
    return false;
  };
  let step = 0;
  const shot = async (name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `${String(++step).padStart(2, '0')}-${name}.png`) });
  };
  const stand = (x, y) => G(([x, y]) => { const g = window.__village; g.player.x = x; g.player.y = y; g.target = null; }, [x, y]);
  const prompt = () => G(() => (document.getElementById('prompt').hidden ? '' : document.getElementById('prompt').textContent));
  const reader = () => G(() => (document.getElementById('overlay').hidden ? null : { title: document.getElementById('reader-title').textContent, text: document.getElementById('reader-body').innerText }));
  const wakeAt = async (id) => {
    await G((id) => { const g = window.__village; const v = g.byId[id]; g.player.x = v.door.x - 8; g.player.y = v.door.y + 30; g.target = null; }, id);
    return until((id) => { const v = window.__village.byId[id]; return v.state.status === 'awake' && v.place === 'home' && v.out > 0.95 && !v.path && !v.led; }, id, 30000);
  };
  const goIn = async (id) => {
    await G((id) => { const g = window.__village; const v = g.byId[id]; g.player.x = v.door.x; g.player.y = v.door.y + 6; g.player.dir = 'up'; }, id);
    await page.waitForTimeout(300);
    await page.keyboard.press('e');
    return until(() => window.__village.scene === 'house' && !window.__village.fading && !window.__village.house.loading);
  };
  const goOut = async () => {
    await page.keyboard.press('Escape');
    return until(() => window.__village.scene === 'village' && !window.__village.fading);
  };
  return { G, until, shot, stand, prompt, reader, wakeAt, goIn, goOut };
}

async function desktop(browser) {
  console.log('\nAt a desk:');
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { G, until, shot, stand, prompt, reader, wakeAt, goIn, goOut } = helpers(page);
  await page.goto(URL, { waitUntil: 'networkidle' });
  check(await page.isVisible('#welcome .logo'), 'the title screen shows');
  await shot('title');
  // choose your character: the second row is hair, and its right arrow picks the next style
  await page.click('#look-rows .look-row:nth-child(2) button:last-child');
  await page.click('#look-rows .look-row:nth-child(4) button:first-child');
  check(await G(() => window.__village.player.look.hair === 1 && window.__village.player.look.outfit === 4), 'the arrows change your hair and clothes');
  check(await G(() => JSON.parse(localStorage.getItem('village-look')).hair === 1 && document.getElementById('look-hair').textContent === 'Curly'), 'and the choice is named and remembered');
  await page.fill('#welcome-name', 'Tess');
  await page.click('#welcome-form button');

  // Mo comes over and says hello, in three lines
  check(await until(() => !!window.__village.guide), 'Mo sets off to say hello on a first visit');
  check(await until(() => window.__village.talking?.id === 'mo' && !document.getElementById('dialogue').hidden, null, 30000), 'he arrives and speaks');
  await page.waitForTimeout(600);
  await shot('welcome');
  check((await G(() => document.querySelector('#dlg-log .them')?.textContent || '')).includes('Tess'), 'he uses the name you gave');
  check(await G(() => getComputedStyle(document.querySelector('#dialogue .answer')).display === 'none'), 'no reply box while he is talking');
  for (let i = 0; i < 8 && (await G(() => !!window.__village.talking)); i++) {
    await page.keyboard.press('e');
    await page.waitForTimeout(250);
  }
  check(await until(() => !window.__village.talking && window.__village.hints.met), 'the welcome ends after his last line');
  // then the screen says what to do, and points at it
  check(await until(() => /dark house/.test(window.__village.goal?.text || '') && !!window.__village.goal.at, null, 5000), 'the first thing to do is to walk up to a dark house');
  check(/yellow arrow/.test(await prompt()), 'the line at the bottom says to follow the arrow');
  await G(() => (window.__village.hints.walked = 99));
  await page.waitForTimeout(200);
  check(/^Next: Walk up to a dark house/.test(await prompt()), 'and then names the next thing in the almanac');
  check(await until(() => !window.__village.byId.mo.led, null, 30000), 'he walks home again');

  // walking in a second time: he comes over again, and Escape cuts him short
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('#welcome-form button');
  check(await until(() => window.__village.talking?.id === 'mo' && !document.getElementById('dialogue').hidden, null, 30000), 'on a later visit Mo still comes over');
  check(await until(() => /Welcome back, Tess/.test(document.querySelector('#dlg-log .them')?.textContent || ''), null, 8000), 'and knows you have met');
  await page.keyboard.press('Escape');
  check(await until(() => !window.__village.talking && !window.__village.guide, null, 10000), 'Escape ends the welcome early');

  // a villager, a conversation, a present
  check(await wakeAt('bao'), 'walking up to a dark house wakes its villager');
  await shot('awake');
  const ticked = (key) => G((key) => window.__village.almanac[key] === true, key);
  check((await ticked('wake')) && (await G(() => document.getElementById('almanac-count').textContent === '1/7')), 'and that is the first thing ticked in the almanac');
  check(await until(() => /Ask Bao to make you something/.test(window.__village.goal?.text || ''), null, 4000), 'the next thing to do moves on: ask Bao to make something');
  await G(() => { const g = window.__village; const v = g.byId.bao; g.player.x = v.pos.x - 18; g.player.y = v.pos.y + 6; g.player.dir = 'right'; });
  await page.waitForTimeout(400);
  check(/Talk to Bao/.test(await prompt()), 'standing next to them offers to talk');
  await page.keyboard.press('e');
  check(await until(() => window.__village.talking?.id === 'bao'), 'E opens the talk box');
  check((await page.locator('#dlg-asks button').count()) === 3, 'three things to say are offered');
  await page.waitForTimeout(1800);
  await page.keyboard.press('1');
  check(await until(() => !window.__village.replying && !!document.querySelector('#dlg-log .meta'), null, 30000), 'a numbered choice gets an answer');
  check(/sandbox/.test(await G(() => document.querySelector('#dlg-log .meta')?.textContent || '')), 'the line under it counts what ran in the sandbox');
  check(await until(() => !document.getElementById('overlay').hidden), 'the thing they made is shown');
  await shot('gift');
  check(/made you/.test((await reader())?.title || ''), 'and says who made it');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  check(await G(() => window.__village.inventory.length === 1), 'it is in your pocket');
  await page.click('#almanac-toggle');
  check(/2 of 7/.test(await G(() => document.getElementById('reader-sub').textContent)) && (await G(() => document.querySelectorAll('ul.almanac li.done').length === 2)), 'the almanac lists seven things, two of them done');
  await shot('almanac');
  await page.keyboard.press('Escape');

  // indoors: the shelves are the sandbox's files
  check(await goIn('bao'), 'the door leads inside');
  check(await G(() => window.__village.house.things.length >= 3), 'the shelves hold the house\'s files');
  await shot('indoors');
  await G(() => { const g = window.__village; const thing = g.house.things.find((other) => other.entry.type !== 'dir' && !other.open); g.house.x = thing.reach.x; g.house.y = thing.reach.y; });
  await page.waitForTimeout(300);
  await page.keyboard.press('e');
  check((await until(() => !document.getElementById('overlay').hidden && /bytes/.test(document.getElementById('reader-sub').textContent), null, 8000)) && (await ticked('file')), 'a file on the shelf opens, and reading it is ticked');
  await page.keyboard.press('Escape');
  check(await goOut(), 'and back out again');

  // the library: the present Bao made has a copy on the shelf every house shares
  await stand(440, 298);
  await page.waitForTimeout(400);
  check(/village library/.test(await prompt()), 'the library offers a look');
  await page.keyboard.press('e');
  check(await until(() => document.querySelectorAll('.file-list.shelf li').length >= 1, null, 10000), 'what Bao made is on its shelf');
  await shot('library');
  await page.click('.file-list.shelf button');
  check(await until(() => !!document.querySelector('#reader-body img.picture'), null, 10000), 'and opens from there');
  await page.keyboard.press('Escape');

  // Mo's house: the glossary, and the game
  check(await wakeAt('mo'), 'Mo wakes like anyone else');
  check(await goIn('mo'), 'into Mo\'s house');
  check(await until(() => window.__village.house.things.some((thing) => thing.open), null, 15000), 'the glossary lies open on his table');
  await G(() => { const g = window.__village; g.house.x = 146; g.house.y = 118; });
  await page.waitForTimeout(400);
  await page.keyboard.press('e');
  check(await until(() => document.querySelectorAll('.md-terms button').length === 79), 'its contents list all 79 pages');
  await shot('glossary');
  await page.locator('.md-terms button', { hasText: /^Warp$/ }).click();
  check(await until(() => /Warp/.test(document.getElementById('reader-title').textContent) && document.querySelectorAll('.md .md-link').length > 3), 'a page opens with its links');
  check(!/\]\(\/gpu-glossary/.test((await reader())?.text || ''), 'and no raw Markdown shows');
  await page.locator('.md .md-link').first().click();
  check(await until(() => /^What /.test(document.getElementById('reader-title').textContent) && !/Warp\?/.test(document.getElementById('reader-title').textContent)), 'a link leads to another page');
  await page.locator('#reader-actions button', { hasText: 'Next' }).click();
  await page.keyboard.press('Escape'); // shut the book while the next page is still on its way
  await page.waitForTimeout(900);
  check((await reader()) === null, 'shutting the book while a page loads keeps it shut');
  await G(() => { const g = window.__village; g.house.x = 230; g.house.y = 170; });
  await page.waitForTimeout(400);
  check(/Cold Start Chase/.test(await prompt()), 'his screen offers the game');
  await page.keyboard.press('e');
  check(await until(() => /Collect every dot/.test(document.querySelector('.tv-status')?.textContent || '')), 'a maze arrives from his sandbox');
  for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(350);
  }
  await shot('game');
  check(/Score [1-9]/.test(await G(() => document.querySelector('.tv-score').textContent)) || /Caught/.test(await G(() => document.querySelector('.tv-status').textContent)), 'the arrow keys play it');
  await page.keyboard.press('Escape');
  // one corridor: the player, a crystal, then a cold start
  const caught = await G(async () => {
    const { startChase } = await import('/js/chase.js');
    let score = 0;
    const chase = startChase(document.createElement('canvas'), { grid: ['#########', '#PS.C...#', '#########'], onScore: (points) => { score += points; } });
    chase.steer([1, 0]);
    await new Promise((done) => setTimeout(done, 1200));
    chase.stop();
    return score;
  });
  check(caught >= 250, 'a frozen cold start can be caught for points');
  check(await goOut(), 'out of Mo\'s house');

  // the bell, and a sign
  await stand(490, 206);
  await page.waitForTimeout(500);
  await page.keyboard.press('e');
  check(/bell/i.test((await reader())?.title || ''), 'the bell has a sign');
  await page.click('#reader-actions button');
  check(await until(() => /whole village is up/.test(document.getElementById('reader-title').textContent), null, 30000), 'ringing it wakes the whole village');
  check(await G(() => window.__village.villagers.every((v) => v.state.status === 'awake')), 'every sandbox is running');
  await shot('bell');
  await page.keyboard.press('Escape');
  check((await ticked('made')) && (await ticked('library')) && (await ticked('maze')) && (await ticked('bell')) && !(await ticked('dare')), 'six of the seven are ticked by now');

  // the dare: Ziggy deletes his own computer, his house falls, and it comes back from its snapshot
  check(await wakeAt('ziggy'), 'Ziggy is up');
  await G(() => { const g = window.__village; const v = g.byId.ziggy; g.player.x = v.pos.x - 18; g.player.y = v.pos.y + 6; g.player.dir = 'right'; });
  await page.waitForTimeout(400);
  await page.keyboard.press('e');
  check((await until(() => window.__village.talking?.id === 'ziggy')) && (await page.locator('#dlg-asks .ask.dare').count()) === 1, 'he can be dared');
  await page.waitForTimeout(1200);
  await page.click('#dlg-asks .ask.dare');
  check(await until(() => /rm -rf/.test(document.getElementById('dlg-status').textContent), null, 8000), 'he types the command');
  check(await until(() => window.__village.byId.ziggy.state.status === 'rubble' && !window.__village.talking, null, 20000), 'and his house falls down');
  await page.waitForTimeout(300);
  await shot('rubble');
  check(await G(() => window.__village.villagers.every((v) => v.id === 'ziggy' || v.state.status === 'awake')), 'every other house still stands');
  check(await until(() => { const v = window.__village.byId.ziggy; return v.out > 0.9 && v.fellAt > 0; }, null, 5000), 'Ziggy stands beside what is left of it');
  check(/Only that one sandbox/.test(await G(() => document.getElementById('toasts').innerText)), 'the notice says only that sandbox is gone');
  await G(() => { const g = window.__village; const v = g.byId.ziggy; g.player.x = v.door.x; g.player.y = v.door.y + 16; });
  await page.waitForTimeout(400);
  check(/Rebuild Ziggy's house from its snapshot/.test(await prompt()), 'the rubble offers to rebuild from the snapshot');
  await page.keyboard.press('e');
  check(await until(() => { const st = window.__village.byId.ziggy.state; return st.status === 'awake' && st.woke_from === 'snapshot'; }, null, 20000), 'a new sandbox starts from it');
  check(await until(() => window.__village.house === null && window.__village.byId.ziggy.bubble?.text === 'We are so back.', null, 8000), 'and Ziggy is pleased');
  check((await ticked('dare')) && (await G(() => document.getElementById('almanac-count').textContent === '✓')), 'that was the last thing in the almanac');
  check(await until(() => !document.getElementById('overlay').hidden && !!document.querySelector('.on-modal.ending a.cta[href*="modal.com/docs"]'), null, 15000), 'which opens by itself with a last word and a link to the docs');
  await shot('ending');
  await page.keyboard.press('Escape');
  await page.click('#guide-toggle');
  check(/Every house is a Modal Sandbox/.test((await reader())?.text || ''), '"What is this?" explains what it stands for');
  await page.keyboard.press('Escape');

  // the calm default: no terminal text or corner commentary unless the hood is open
  check(await G(() => getComputedStyle(document.getElementById('feed-panel')).display === 'none'), 'no corner commentary by default');
  await page.keyboard.press('Tab');
  check(await G(() => !document.getElementById('hood').hidden && document.querySelectorAll('.hood-row').length === window.__village.villagers.length), '"Under the hood" lists every sandbox');
  await shot('hood');
  check(errors.length === 0, `no errors on the page${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await page.close();
}

async function phone(browser) {
  console.log('\nOn a phone:');
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { G, until, shot, reader, wakeAt, goIn } = helpers(page);
  const fits = () => G(() => document.documentElement.scrollWidth <= innerWidth + 1);
  const inside = (selector) => G((selector) => { const box = document.querySelector(selector)?.getBoundingClientRect(); return !!box && box.width > 0 && box.left >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1; }, selector);
  await page.goto(URL, { waitUntil: 'networkidle' });
  // this is a second browser, so a second visitor: none of what the first one did is here
  check(await G(() => { const g = window.__village; return g.mine.per_visitor && g.villagers.every((v) => v.state.status !== 'awake' && !v.state.wakes) && g.library.files.length === 0; }), 'a second visitor gets a village of their own, untouched');
  check(await inside('#welcome .card'), 'the title card fits the screen');
  check((await inside('#look-rows .look-row:nth-child(4) button:last-child')) && (await fits()), 'and so do the character arrows');
  await page.tap('#welcome-form button');
  check(await until(() => window.__village.talking?.id === 'mo', null, 40000), 'Mo comes over');
  await page.waitForTimeout(500);
  await shot('phone-welcome');
  check((await inside('#dlg-next')) && (await fits()), 'his talk box and its button fit');
  for (let i = 0; i < 8 && (await G(() => !!window.__village.talking)); i++) {
    await page.tap('#dlg-next');
    await page.waitForTimeout(300);
  }
  check(await until(() => !window.__village.talking), 'tapping through ends the welcome');
  check((await inside('#almanac-toggle')) && (await fits()), 'the almanac button fits the top of the screen');
  await page.tap('#almanac-toggle');
  check((await G(() => document.querySelectorAll('ul.almanac li').length === 7)) && (await fits()) && (await inside('#reader-close')), 'and its list fits too');
  await page.tap('#reader-close');
  // one tap on the far side of a house: the walk goes round it to the door
  await G(() => { const g = window.__village; const v = g.byId.bao; g.player.x = v.door.x; g.player.y = v.door.y - 100; g.target = null; });
  await page.waitForTimeout(500);
  const spot = await G(() => { const g = window.__village; const v = g.byId.bao; return { x: (v.door.x - Math.round(g.view.x)) * g.scale, y: (v.door.y + 18 - Math.round(g.view.y)) * g.scale }; });
  await page.touchscreen.tap(spot.x, spot.y);
  check(await until(() => { const g = window.__village; const v = g.byId.bao; return !g.target && Math.hypot(g.player.x - v.door.x, g.player.y - v.door.y - 18) < 8; }, null, 12000), 'a tap on the far side of a house walks you round to its door');
  check(await wakeAt('fennel'), 'a villager wakes');
  await G(() => { const g = window.__village; const v = g.byId.fennel; g.player.x = v.pos.x - 18; g.player.y = v.pos.y + 6; });
  await page.waitForTimeout(400);
  await page.tap('#prompt');
  check(await until(() => window.__village.talking?.id === 'fennel'), 'the yellow button starts a conversation');
  await page.waitForTimeout(1500);
  await shot('phone-talk');
  check(await G(() => document.activeElement?.id !== 'dlg-input'), 'the keyboard is not called up until the box is tapped');
  // the keyboard comes up over the bottom 300 px of the page (it does not resize the page)
  await page.tap('#dlg-input');
  await G(() => { const glass = window.visualViewport; Object.defineProperty(glass, 'height', { configurable: true, get: () => innerHeight - 300 }); glass.dispatchEvent(new Event('resize')); });
  await page.waitForTimeout(250);
  check(await G(() => document.body.classList.contains('keyboard') && document.getElementById('dlg-form').getBoundingClientRect().bottom <= innerHeight - 300 && document.getElementById('dialogue').getBoundingClientRect().top >= 0), 'with the keyboard up, the talk box stands on top of it');
  await G(() => { const glass = window.visualViewport; Object.defineProperty(glass, 'height', { configurable: true, get: () => innerHeight }); document.getElementById('dlg-input').blur(); glass.dispatchEvent(new Event('resize')); });
  await page.waitForTimeout(250);
  check(await G(() => !document.body.classList.contains('keyboard')), 'and comes back down when it goes');
  const covered = await G(() => {
    const say = document.querySelector('#dlg-form .send').getBoundingClientRect();
    const badge = document.getElementById('modal-badge').getBoundingClientRect();
    return !(say.right < badge.left || say.left > badge.right || say.bottom < badge.top || say.top > badge.bottom);
  });
  check(!covered && (await inside('#dlg-form .send')) && (await fits()), 'the Say button is on screen and not under the badge');
  await page.tap('#dlg-asks button');
  check(await until(() => !window.__village.replying && !!document.querySelector('#dlg-log .meta'), null, 30000), 'tapping a line gets an answer');
  await page.tap('#dlg-close');
  check(await wakeAt('mo'), 'Mo wakes');
  check(await goIn('mo'), 'into his house');
  await until(() => window.__village.house.things.some((thing) => thing.open), null, 15000);
  await G(() => { const g = window.__village; g.house.x = 146; g.house.y = 118; });
  await page.waitForTimeout(400);
  await page.tap('#prompt');
  check(await until(() => document.querySelectorAll('.md-terms button').length === 79), 'the glossary opens');
  await shot('phone-glossary');
  check((await fits()) && (await inside('#reader-close')), 'it fits, with its close button in reach');
  await page.locator('.md-terms button', { hasText: /^Tensor Core$/ }).tap();
  check(await until(() => /Tensor Core/.test(document.getElementById('reader-title').textContent)), 'a page opens');
  await page.waitForTimeout(500);
  check((await fits()) && (await inside('#reader-close')), 'a page with wide code in it still fits the screen');
  await shot('phone-page');
  await page.tap('#reader-close');
  await G(() => { const g = window.__village; g.house.x = 230; g.house.y = 170; });
  await page.waitForTimeout(400);
  await page.tap('#prompt');
  check(await until(() => /Collect every dot/.test(document.querySelector('.tv-status')?.textContent || '')), 'the game starts');
  check((await inside('canvas.tv-game')) || (await G(() => document.querySelector('canvas.tv-game').getBoundingClientRect().width <= innerWidth)), 'its screen fits');
  check(await G(() => getComputedStyle(document.querySelector('.tv-pad')).display !== 'none'), 'a direction pad is offered for thumbs');
  // every maze is different, and the first way tried may be a wall: go each way in turn until something is eaten
  const moved = () => G(() => /Score [1-9]/.test(document.querySelector('.tv-score').textContent) || /Caught/.test(document.querySelector('.tv-status').textContent));
  for (const way of ['left', 'up', 'right', 'down', 'left', 'up']) {
    if (await moved()) break;
    await page.locator(`.tv-pad .${way}`).dispatchEvent('pointerdown');
    await page.waitForTimeout(700);
  }
  await shot('phone-game');
  check(/Score [1-9]/.test(await G(() => document.querySelector('.tv-score').textContent)) || /Caught/.test(await G(() => document.querySelector('.tv-status').textContent)), 'and the pad plays it');
  check(errors.length === 0, `no errors on the page${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await context.close();
}

(async () => {
  let server = null;
  let browser = null;
  try {
    server = await startServer();
    browser = await chromium.launch();
    await desktop(browser);
    await phone(browser);
  } catch (error) {
    check(false, `the walk-through stopped: ${error.message.split('\n')[0]}`);
  } finally {
    await browser?.close();
    server?.kill();
  }
  console.log(failures.length ? `\n${failures.length} thing(s) failed.` : '\nAll good.');
  process.exit(failures.length ? 1 : 0);
})();
