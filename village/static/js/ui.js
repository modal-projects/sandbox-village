// The HTML panels around the canvas: toasts, the E-prompt, the conversation, the file reader,
// the inventory and the "under the hood" panel. Anything that came from a villager's files or
// from the model is inserted as text, never as HTML.

export const $ = (id) => document.getElementById(id);

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (value !== false && value != null) node.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children) if (child != null) node.append(child);
  return node;
}

export function toast(text, strong = '', ms = 4200, kind = '') {
  const node = el('div', { class: `toast ${kind}`.trim() }, strong ? el('b', { text: strong + ' ' }) : null, text);
  $('toasts').append(node);
  while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
  setTimeout(() => node.remove(), ms);
  return node;
}

let promptAction = null;
$('prompt').addEventListener('click', () => promptAction && promptAction());
export function setPrompt(text, action, hint = false, touch = false) {
  promptAction = action || null;
  const node = $('prompt');
  if (!text) {
    node.hidden = true;
    return;
  }
  node.hidden = false;
  node.classList.toggle('hint', hint);
  const label = (action && !touch ? 'E · ' : '') + text;
  if (node.textContent !== label) node.textContent = label;
}

export function dataUrl(entry) {
  if (entry.base64) return `data:${entry.mime};base64,${entry.base64}`;
  return null;
}

// ---- the village feed and the status line ----------------------------------------------------

const FEED_LINES = 4;
const FEED_SECONDS = 18; // a line fades after this long, so the corner is quiet when the village is

// A running list of what the village is up to. `kind` only picks the colour:
// sandbox (lifecycle), shell (a command run in a sandbox), say, walk, post.
export function feed(text, kind = 'say') {
  const list = $('feed-list');
  const line = el('li', { class: kind, text: text.length > 150 ? text.slice(0, 149) + '…' : text });
  list.append(line);
  while (list.children.length > FEED_LINES) list.firstChild.remove();
  $('feed-panel').hidden = false;
  setTimeout(() => {
    line.remove();
    if (!list.children.length) $('feed-panel').hidden = true;
  }, FEED_SECONDS * 1000);
}

const WEATHER_NAMES = { rain: 'rain', storm: 'a storm', snow: 'snow', fog: 'fog', blossom: 'petals' };

export function renderStatus(game) {
  const awake = game.villagers.filter((v) => v.state.status === 'awake').length;
  $('stat-sandboxes').textContent = `Sandboxes: ${awake} of ${game.villagers.length} running`;
  // one lamp per model (each on Modal's Model APIs), in that brain's colour
  const lamps = game.brains.map((brain) => {
    const lamp = el('span', { class: 'lamp brain', text: `${brain.label}: ${brain.requests ?? 0}${game.xray && brain.avg_ms ? ` · ${(brain.avg_ms / 1000).toFixed(1)} s` : ''}` });
    lamp.style.setProperty('--lamp', brain.color);
    return lamp;
  });
  // the weather is on screen already; who cast it is a detail for the hood
  const sky = game.xray && game.weather?.kind && game.weather.kind !== 'clear' ? el('span', { class: 'lamp sky', text: `${WEATHER_NAMES[game.weather.kind] || game.weather.kind}, cast by ${game.byId[game.weather.by]?.name || 'someone'}` }) : null;
  const text = lamps.map((lamp) => lamp.textContent).join('|') + (sky?.textContent || '');
  if ($('stat-brains').dataset.text !== text) {
    $('stat-brains').dataset.text = text;
    $('stat-brains').replaceChildren(el('span', { class: 'group', text: 'Model API calls:' }), ...lamps, ...(sky ? [sky] : []));
  }
}

const seconds = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`);
const facts = (...rows) => el('dl', { class: 'facts' }, ...rows.filter(Boolean).flatMap(([name, value]) => [el('dt', { text: name }), el('dd', { text: value })]));

// `brain` is the endpoint being looked at; `brains` is all of them, for the comparison line.
// A landmark's sign: a big picture of the thing, what it means in plain words, and the one
// line that says what it is on Modal. Anything in `more` is folded away under "The numbers".
export function signpost({ picture, kicker, headline, plain = [], modal, stat, more = [], note }) {
  const numbers = more.filter(Boolean);
  return [
    el(
      'div',
      { class: 'signpost' },
      picture ? el('div', { class: 'scene' }, picture) : null,
      el(
        'div',
        { class: 'says' },
        kicker ? el('div', { class: 'kicker', text: kicker }) : null,
        el('h3', { class: 'headline', text: headline }),
        ...plain.map((text) => el('p', { text })),
        stat ? el('p', { class: 'stat', text: stat }) : null,
      ),
    ),
    modal ? el('div', { class: 'on-modal' }, el('img', { src: 'brand/modal-mark.svg', alt: '' }), el('p', {}, el('b', { text: 'On Modal: ' }), modal)) : null,
    numbers.length ? el('details', { class: 'source' }, el('summary', { text: 'The numbers' }), ...numbers) : null,
    note || null,
  ];
}

const listed = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

export function brainBody(brain, brains, byId, picture, note) {
  const recent = (brain.recent || []).slice().reverse();
  const names = (brain.villagers || []).map((id) => byId[id]?.name || id);
  const calls = brain.requests ?? 0;
  return signpost({
    picture,
    kicker: 'Modal Model APIs',
    headline: names.length ? `The brain ${names.length === 1 ? `${names[0]} uses` : `${names.length} villagers share`}.` : 'A brain nobody is using right now.',
    plain: [
      names.length ? `${listed(names)} ${names.length === 1 ? 'thinks' : 'think'} with this tower. None of them has a brain of their own.` : 'No villager is wired to this tower at the moment.',
      'When one of them thinks, dots run between them and the tower: a question going out and the answer coming back.',
    ],
    stat: `${calls} thought${calls === 1 ? '' : 's'} so far${brain.avg_ms ? ` · about ${seconds(brain.avg_ms)} each` : ''}`,
    modal: `an AI model (${brain.label || '?'}) that Modal hosts and anyone can call, here under the name "${brain.endpoint || '?'}". The village only sends requests: it runs no model and owns no GPU.`,
    more: [
      brain.available === false ? el('p', { class: 'err', text: 'This endpoint has not been created, so the villagers wired to it are thinking with the other tower for now.' }) : null,
      facts(
        ['endpoint', brain.endpoint || '?'],
        ['model', brain.model || '?'],
        ['reasoning', brain.effort || '?'],
        ['signed in with', brain.auth || '?'],
        ['requests so far', String(calls)],
        ['tokens in / out', `${brain.tokens_in ?? 0} / ${brain.tokens_out ?? 0}`],
        ['average reply', seconds(brain.avg_ms)],
      ),
      recent.length
        ? el(
            'table',
            { class: 'calls' },
            el('tr', {}, el('th', { text: 'latest calls' }), el('th', { text: 'time' }), el('th', { text: 'tokens in' }), el('th', { text: 'out' })),
            ...recent.map((call) => el('tr', {}, el('td', { text: byId[call.who]?.name || call.who }), el('td', { text: seconds(call.ms) }), el('td', { text: String(call.tokens_in) }), el('td', { text: String(call.tokens_out) }))),
          )
        : null,
    ],
    note,
  });
}

const TOOL_NOTES = {
  bash: 'run any command in their own sandbox',
  write_file: 'write a file in their home',
  give_item: 'hand a file to whoever they are with',
  cast_weather: 'change the weather for the whole village',
  install: 'stand one of her SVG files on a pedestal',
  village_census: 'read the true state of every sandbox',
  play_tune: 'play notes the whole village hears',
  plant: 'add a plant to garden.txt',
};

// The card on a villager's mailbox.
export function aboutBody(v, brain) {
  const st = v.state;
  const running = st.status === 'awake' ? `running now: ${st.sandbox_id}` : st.status === 'rubble' ? 'wrecked (the system files are gone)' : 'not running';
  const kept = v.ephemeral ? 'never. This home is not snapshotted: when the sandbox stops, everything in it is gone' : st.snapshots.length ? `${st.snapshots.length} snapshot${st.snapshots.length === 1 ? '' : 's'} kept` : 'no snapshot yet';
  const tool = (name, own) => el('li', { class: own ? 'own' : '' }, el('code', { text: name }), ` ${TOOL_NOTES[name] || ''}`, own ? el('span', { class: 'tag', text: `only ${v.name}` }) : null);
  return [
    el('h3', { text: 'Brain' }),
    facts(['model', `${brain.label || '?'} (${brain.model || '?'})`], ['endpoint', `${brain.endpoint || '?'}, on Modal's Model APIs`]),
    el('h3', { text: 'Sandbox' }),
    facts(['runs on', st.runtime || v.runtime || '?'], ['right now', running], ['saved', kept], ['woken', `${st.wakes} time${st.wakes === 1 ? '' : 's'}${st.wake_ms != null ? `, last in ${seconds(st.wake_ms)}` : ''}`], ['size', 'a quarter of a CPU, 512 MiB, no network in or out']),
    el('h3', { text: 'Tools' }),
    el('ul', { class: 'tools' }, ...(v.tools || []).map((name) => tool(name, true)), ...(v.common_tools || []).map((name) => tool(name, false))),
    v.exhibit ? el('h3', { text: `On show: ${v.exhibit}` }) : null,
    v.exhibit ? el('pre', { text: st.exhibit || '(empty)' }) : null,
    v.exhibit ? el('p', { class: 'muted small', text: `The last lines of a file in ${v.name}'s sandbox${st.status === 'awake' ? '' : ', as it was when the sandbox last stopped'}. Go inside to read the rest.` }) : null,
  ];
}

// ---- conversation ---------------------------------------------------------------------------

// One exchange at a time, as in a handheld game: what you said, then their answer typed out a
// letter at a time. The terminal pane beside it only shows with "Under the hood" open.
const TYPE_MS = 24; // per letter

const COARSE = matchMedia('(pointer: coarse)').matches; // a finger, not a mouse: no keyboard until asked for

export const dialogue = {
  villager: null,
  scripted: null, // set while a villager is saying written lines (see `script`)
  voice: null,
  advance: () => {},
  reply: null, // the paragraph being typed into
  queue: '', // letters still to type
  timer: null,
  waiting: [], // callbacks for when the typing has caught up
  letters: 0,
  handlers: { send: null, close: null, blip: null },

  open(v, intro, brain) {
    $('dlg-brain').replaceChildren(...(brain ? [`thinks with ${brain.label}`, el('span', { class: 'wide' }, ', on', el('img', { src: 'brand/modal-mark.svg', alt: 'Modal' }), 'Modal Model APIs')] : []));
    $('dlg-brain').style.setProperty('--lamp', brain?.color || '#7fee64');
    const fresh = this.villager !== v;
    if (fresh) {
      this.flush();
      $('dlg-log').replaceChildren();
      $('feed').replaceChildren(el('div', { class: 'empty', text: `Nothing yet. When ${v.name} does something, every command run in their sandbox shows up here.` }));
    }
    this.villager = v;
    // a few things worth saying to this villager: click one, or press its number
    // (the last one, for a villager who can be dared, is the dare: see dareHome in main.js)
    const lines = [...(v.asks || []), ...(v.dare ? [v.dare] : [])];
    $('dlg-asks').replaceChildren(
      ...lines.map((line, index) => el('button', { type: 'button', class: line === v.dare ? 'ask dare' : 'ask', onclick: () => this.handlers.send?.(line) }, el('kbd', { text: String(index + 1) }), line)),
    );
    $('dlg-asks').hidden = !(v.asks || []).length;
    $('dlg-name').textContent = v.name;
    $('dlg-role').textContent = `the ${v.role}`;
    $('dlg-tab').style.setProperty('--who', v.color);
    $('feed-title').textContent = `${v.name}'s sandbox`;
    $('dialogue').hidden = false;
    document.body.classList.add('talking');
    this.setStatus('');
    if (fresh && intro) {
      this.reply = el('p', { class: 'them' });
      $('dlg-log').replaceChildren(this.reply);
      this.appendSay(intro);
    } else if (!$('dlg-log').children.length) {
      $('dlg-log').replaceChildren(el('p', { class: 'them', text: 'Yes?' }));
    }
    // With a keyboard, the box is ready to type in (and a number picks a line). On a phone that
    // would throw the on-screen keyboard up over the lines on offer: it waits to be tapped.
    if (!COARSE) $('dlg-input').focus();
  },
  // A few written lines from a villager, one at a time (Mo's welcome). No model, no reply box:
  // just "Next". Resolves when the last line has been read, or the box is closed.
  script(v, lines, brain = null) {
    return new Promise((resolve) => {
      let at = -1;
      this.flush();
      this.villager = null; // so their next real conversation starts with their greeting
      this.scripted = { resolve };
      $('dlg-brain').replaceChildren();
      $('dlg-name').textContent = v.name;
      $('dlg-role').textContent = `the ${v.role}`;
      $('dlg-tab').style.setProperty('--who', v.color);
      $('dialogue').classList.add('scripted');
      $('dialogue').hidden = false;
      document.body.classList.add('talking');
      this.setStatus('');
      this.advance = () => {
        if (this.typing) return this.flush();
        at += 1;
        if (at >= lines.length) return this.close();
        this.reply = el('p', { class: 'them' });
        $('dlg-log').replaceChildren(this.reply);
        this.villager = v;
        this.appendSay(lines[at]);
        this.villager = null;
        this.voice = v;
        $('dlg-next').textContent = at === lines.length - 1 ? `Thanks, ${v.name}` : 'Next';
      };
      this.advance();
    });
  },
  close() {
    this.flush();
    if (this.scripted) {
      const { resolve } = this.scripted;
      this.scripted = null;
      this.voice = null;
      $('dialogue').classList.remove('scripted');
      $('dlg-log').replaceChildren();
      resolve();
    }
    $('dialogue').hidden = true;
    document.body.classList.remove('talking');
    $('dlg-input').blur();
  },
  get isOpen() {
    return !$('dialogue').hidden;
  },
  setBusy(busy) {
    $('dialogue').classList.toggle('busy', busy);
    $('dlg-form').querySelector('button').disabled = busy;
    for (const button of $('dlg-asks').querySelectorAll('button')) button.disabled = busy;
  },
  setStatus(text, working = false) {
    const node = $('dlg-status');
    node.textContent = text;
    node.classList.toggle('working', working);
  },
  addYou(name, text) {
    this.flush();
    this.reply = el('p', { class: 'them' });
    $('dlg-log').replaceChildren(el('p', { class: 'you', text: `${name}: ${text}` }), this.reply);
  },
  appendSay(text) {
    if (!this.reply) return;
    this.queue += text;
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TYPE_MS);
  },
  get typing() {
    return this.queue.length > 0;
  },
  tick() {
    if (!this.queue || !this.reply) return this.caughtUp();
    // a long backlog (the model answered faster than anyone reads) types quicker
    const count = this.queue.length > 160 ? 3 : this.queue.length > 60 ? 2 : 1;
    const next = this.queue.slice(0, count);
    this.queue = this.queue.slice(count);
    this.reply.textContent += next;
    this.letters += count;
    if (/[a-z0-9]/i.test(next) && this.letters % 3 < count) this.handlers.blip?.(this.villager || this.voice);
    this.scroll();
    if (!this.queue) this.caughtUp();
  },
  caughtUp() {
    clearInterval(this.timer);
    this.timer = null;
    for (const done of this.waiting.splice(0)) done();
  },
  // Show the rest at once: a click on the words, or closing the box.
  flush() {
    if (this.reply && this.queue) this.reply.textContent += this.queue;
    this.queue = '';
    this.caughtUp();
  },
  // Resolves once everything said so far is on screen.
  settled() {
    return this.typing ? new Promise((resolve) => this.waiting.push(resolve)) : Promise.resolve();
  },
  error(text) {
    $('dlg-log').append(el('p', { class: 'err', text }));
    this.scroll();
  },
  async finish(meta) {
    await this.settled();
    if (this.reply && !this.reply.textContent.trim()) this.reply.remove();
    this.reply = null;
    if (meta) $('dlg-log').append(el('p', { class: 'meta', text: meta }));
    this.scroll();
  },
  scroll() {
    $('dlg-log').scrollTop = $('dlg-log').scrollHeight;
  },
  feedCall(event) {
    const feed = $('feed');
    feed.querySelector('.empty')?.remove();
    const isFile = event.name === 'write_file';
    const details = el(
      'details',
      { id: `call-${event.id}`, open: isFile ? false : null },
      el('summary', {}, el('span', { class: 'ms working' }), (event.name === 'bash' ? '$ ' : '› ') + event.summary),
      event.detail && event.detail !== event.summary ? el('pre', { class: 'code', text: event.detail }) : null,
    );
    feed.append(details);
    feed.scrollTop = feed.scrollHeight;
  },
  feedResult(event) {
    const details = document.getElementById(`call-${event.id}`);
    if (!details) return;
    details.classList.add(event.ok ? 'ok' : 'bad');
    const ms = details.querySelector('.ms');
    ms.classList.remove('working');
    ms.textContent = `${event.ms} ms`;
    details.append(el('pre', { text: event.output }));
    if (!event.ok) details.open = true;
    $('feed').scrollTop = $('feed').scrollHeight;
  },
};

$('dlg-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('dlg-input');
  const text = input.value.trim();
  if (!text || $('dlg-form').querySelector('button').disabled) return;
  input.value = '';
  if (COARSE) input.blur(); // the keyboard goes away, so the answer can be seen
  dialogue.handlers.send?.(text);
});
// With nothing typed yet, a number picks that suggestion.
$('dlg-input').addEventListener('keydown', (event) => {
  if (event.target.value || !/^[1-9]$/.test(event.key)) return;
  const button = $('dlg-asks').querySelectorAll('button')[Number(event.key) - 1];
  if (!button) return;
  event.preventDefault();
  if (!button.disabled) button.click();
});
$('dlg-log').addEventListener('click', () => dialogue.flush());
$('dlg-next').addEventListener('click', () => dialogue.advance());
$('dlg-close').addEventListener('click', () => dialogue.handlers.close?.());

// ---- reader (files, items, websites) --------------------------------------------------------

export const reader = {
  onClose: null,
  open({ title, sub = '', body, actions = [], onClose = null }) {
    $('reader-title').textContent = title;
    $('reader-sub').textContent = sub;
    $('reader-body').replaceChildren(...(Array.isArray(body) ? body : [body]).filter(Boolean));
    $('reader-actions').replaceChildren(
      ...actions.map((action) => el('button', { text: action.label, onclick: action.run })),
    );
    this.onClose = onClose;
    $('overlay').hidden = false;
  },
  close() {
    if ($('overlay').hidden) return;
    $('overlay').hidden = true;
    $('reader-body').replaceChildren();
    const done = this.onClose;
    this.onClose = null;
    done?.();
  },
  get isOpen() {
    return !$('overlay').hidden;
  },
};
$('reader-close').addEventListener('click', () => reader.close());
$('overlay').addEventListener('pointerdown', (event) => {
  if (event.target === $('overlay')) reader.close();
});

export function fileBody(entry) {
  const nodes = [];
  const url = dataUrl(entry);
  if (url && entry.mime.startsWith('image/')) nodes.push(el('img', { class: 'picture', src: url, alt: entry.name }));
  if (typeof entry.text === 'string') nodes.push(el('pre', { text: entry.text + (entry.truncated ? '\n\n[... the rest is too long to show ...]' : '') }));
  else if (!url) nodes.push(el('p', { class: 'muted', text: 'This is not something you can read.' }));
  return nodes;
}

// ---- Markdown, as much of it as the glossary uses --------------------------------------------
// Everything is built as DOM nodes from text: nothing from a page is ever inserted as HTML.
// `onLink(path)` is called for links to other glossary pages; other links open in a new tab.

const INLINE = /`([^`]+)`|!?\[((?:[^\[\]]|\[[^\]]*\])+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])/;

function inline(text, onLink) {
  const nodes = [];
  let rest = text;
  while (rest) {
    const found = INLINE.exec(rest);
    if (!found) {
      nodes.push(rest);
      break;
    }
    if (found.index) nodes.push(rest.slice(0, found.index));
    const [whole, code, label, url, strong, star, under] = found;
    if (code != null) nodes.push(el('code', { text: code }));
    else if (label != null) nodes.push(link(label, url, onLink));
    else if (strong != null) nodes.push(el('b', {}, ...inline(strong, onLink)));
    else nodes.push(el('i', {}, ...inline(star ?? under, onLink)));
    rest = rest.slice(found.index + whole.length);
  }
  return nodes;
}

function link(label, url, onLink) {
  const inside = inline(label, onLink);
  const page = /^\/gpu-glossary(\/[^#?]*)?/.exec(url);
  if (page) {
    const path = `gpu-glossary${page[1] && page[1] !== '/' ? page[1] : '/readme'}.md`;
    return el('button', { type: 'button', class: 'md-link', onclick: () => onLink?.(path) }, ...inside);
  }
  const href = url === '/' ? 'https://modal.com' : /^https?:\/\//.test(url) ? url : null;
  return href ? el('a', { href, target: '_blank', rel: 'noopener' }, ...inside) : el('span', {}, ...inside);
}

const picture = (url) => (url.startsWith('themed-image://') ? `https://modal-cdn.com/gpu-glossary/light-${url.slice(15)}` : /^https:\/\//.test(url) ? url : null);

export function markdown(source, onLink) {
  let text = source.replace(/\r/g, '');
  if (text.startsWith('---')) text = text.slice(text.indexOf('\n---', 3) + 4); // front matter: the title is shown by the window
  const lines = text.split('\n');
  const out = [];
  let para = [];
  const flush = () => {
    if (!para.length) return;
    const block = para.join(' ').trim();
    para = [];
    if (!block) return;
    const figure = /^!\[([\s\S]*)\]\(([^)\s]+)\)$/.exec(block);
    if (figure) {
      const src = picture(figure[2]);
      const image = src ? el('img', { src, alt: '', loading: 'lazy' }) : null;
      image?.addEventListener('error', () => image.remove()); // offline: the caption still says what it showed
      out.push(el('figure', { class: 'md-figure' }, image, el('figcaption', {}, ...inline(figure[1], onLink))));
    } else out.push(el('p', {}, ...inline(block, onLink)));
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      flush();
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i]);
      out.push(el('pre', { class: 'md-code', text: code.join('\n') }));
    } else if (/^<pre[\s>]/.test(line)) {
      flush();
      while (i < lines.length && !lines[i].includes('</pre>')) i++; // the banner drawn in block letters: skipped
    } else if (/^#{1,6}\s/.test(line)) {
      flush();
      out.push(el(line.startsWith('# ') || line.startsWith('## ') ? 'h3' : 'h4', {}, ...inline(line.replace(/^#+\s*/, ''), onLink)));
    } else if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      for (; i < lines.length && (/^\s*(?:[-*]|\d+\.)\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length)); i++) {
        if (/^\s*(?:[-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, ''));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
      }
      i--;
      out.push(el(ordered ? 'ol' : 'ul', { class: 'md-list' }, ...items.map((item) => el('li', {}, ...inline(item, onLink)))));
    } else if (line.startsWith('|')) {
      flush();
      const rows = [];
      for (; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i]);
      i--;
      out.push(el('pre', { class: 'md-code', text: rows.join('\n') }));
    } else if (line.startsWith('>')) {
      flush();
      const quote = [];
      for (; i < lines.length && lines[i].startsWith('>'); i++) quote.push(lines[i].replace(/^>\s?/, ''));
      i--;
      out.push(el('blockquote', {}, ...inline(quote.join(' '), onLink)));
    } else if (!line.trim()) flush();
    else para.push(line.trim());
  }
  flush();
  return el('div', { class: 'md' }, ...out);
}

// ---- inventory ------------------------------------------------------------------------------

// `spriteUrl(item)` returns a small pixel-art version of a picture item, once it has loaded.
export function renderInventory(items, onPick, spriteUrl) {
  const node = $('inventory');
  node.hidden = items.length === 0;
  node.replaceChildren(
    ...items.map((item) => {
      const url = spriteUrl(item);
      return el('button', { class: 'slot', title: item.label, onclick: () => onPick(item) }, url ? el('img', { src: url, alt: item.label }) : el('span', { text: item.label }));
    }),
  );
}

// ---- under the hood -------------------------------------------------------------------------

export function renderHood(game, handlers) {
  const info = game.info || {};
  const brains = game.brains.map((brain) => `${brain.label} on "${brain.endpoint}" (${brain.requests ?? 0} requests, ${(brain.tokens_in ?? 0) + (brain.tokens_out ?? 0)} tokens)`);
  $('hood-summary').textContent = `Homes: one Modal Sandbox each (runtime: ${game.runtime || '?'}). Brains, each a model on Modal's Model APIs: ${brains.join('; ') || '?'}. ${info.mode || ''}${game.mine?.per_visitor ? `. This village (${game.mine.id}) is this browser's own: ${game.mine.in_use} of ${game.mine.room_for} villages are in use` : ''}`;
  const rows = game.villagers.map((v) => {
    const st = v.state;
    const shown = v.pending === 'waking' ? 'waking' : v.pending === 'sleeping' ? 'going to sleep' : st.status;
    const options = [
      el('option', { value: '', text: v.ephemeral ? 'Never snapshotted…' : 'Restore a snapshot…' }),
      ...st.snapshots.map((snap, index) =>
        el('option', { value: snap.id, text: `${index === 0 ? 'latest' : new Date(snap.at * 1000).toLocaleTimeString()} · ${snap.files} files` }),
      ),
      el('option', { value: 'fresh', text: 'Brand-new home (day one)' }),
    ];
    const select = el('select', { 'aria-label': `Restore ${v.name}'s home`, onchange: (event) => event.target.value && handlers.restore(v, event.target.value) }, ...options);
    return el(
      'div',
      { class: 'hood-row' },
      el('div', { class: 'head' }, el('span', { class: 'dot', style: `background:${v.color}` }), `${v.name} the ${v.role}`, el('span', { class: `state ${shown.split(' ')[0]}`, text: shown })),
      el(
        'dl',
        {},
        el('dt', { text: 'brain' }),
        el('dd', { text: game.brains.find((brain) => brain.key === v.brain)?.label || v.brain }),
        el('dt', { text: 'runs on' }),
        el('dd', { text: st.runtime || '?' }),
        el('dt', { text: 'own tool' }),
        el('dd', { text: (v.tools || []).join(', ') || 'none' }),
        el('dt', { text: 'sandbox' }),
        el('dd', { text: st.sandbox_id || 'none (asleep: nothing is running)' }),
        el('dt', { text: 'snapshot' }),
        el('dd', { text: v.ephemeral ? 'never taken: this home is thrown away' : st.snapshot_id ? `${st.snapshot_id}${st.snapshot_ms != null ? `  (saved in ${seconds(st.snapshot_ms)})` : ''}` : 'none yet' }),
        el('dt', { text: 'last wake' }),
        el('dd', { text: st.wake_ms == null ? '—' : `${seconds(st.wake_ms)} from ${st.woke_from === 'snapshot' ? 'snapshot' : 'an empty image (first boot)'} · ${st.wakes} wakes` }),
        el('dt', { text: 'files' }),
        el('dd', { text: st.files == null ? '—' : String(st.files) }),
        st.mail ? el('dt', { text: 'post held' }) : null,
        st.mail ? el('dd', { text: `${st.mail} file(s) waiting for the next wake` }) : null,
      ),
      el(
        'div',
        { class: 'actions' },
        el('button', { text: 'Send to bed', disabled: st.status !== 'awake' || !!v.pending, onclick: () => handlers.bed(v) }),
        st.status === 'rubble' ? select : null,
      ),
    );
  });
  $('hood-list').replaceChildren(...rows);
}
