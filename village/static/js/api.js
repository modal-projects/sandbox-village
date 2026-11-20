// Calls to the game server. The optional access key comes from ?key=... and is remembered for
// the browser tab.

const params = new URLSearchParams(location.search);
let key = params.get('key') || '';
try {
  if (key) sessionStorage.setItem('village-key', key);
  else key = sessionStorage.getItem('village-key') || '';
} catch {
  /* storage can be blocked; the key in the URL still works */
}

// Which village is this browser's? Its ID is made up on the first visit and kept, so coming back
// finds the same villagers as they were left. (Private windows, and browsers that block storage,
// get a new village each time.)
//
// A big deployment runs several web containers, each holding a share of the villages. The first
// character of a village's ID says which (village/villages.py does the same sum), so a new ID is
// made to point at a container with room, and every request goes straight to that container.
const tail = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((byte) => (byte % 36).toString(36)).join('');
const shardOf = (id, count) => (count > 1 ? parseInt(id[0], 36) % count : 0);
export let village = '';
let base = ''; // where this village's container is ('' when it is the one the page came from)
let shards = { count: 1, mine: 0, urls: [''], room: [] };
let fresh = false; // made up just now: nothing is lost by making up another

function place(shard) {
  base = shard === shards.mine ? '' : shards.urls[shard] || '';
}

function settle() {
  let id = '';
  try {
    id = localStorage.getItem('village-id') || '';
  } catch {
    /* storage can be blocked: a village for this visit only */
  }
  fresh = !/^[a-z0-9]{8,40}$/.test(id);
  if (fresh) id = newId();
  village = id;
  place(shardOf(id, shards.count));
}

// A new village goes in the first container that is less than 60% full: the first is the one
// kept running, so on a quiet day nobody waits for another to start. Once they are all busier
// than that (or the one tried turned out to be full), it is chosen at random, the emptier the
// likelier.
function newId(not = -1) {
  let shard = 0;
  if (shards.count > 1) {
    const space = shards.room.map((one, n) => (n === not ? 0 : Math.max(0, (one.room_for ?? 1) - (one.in_use ?? 0))));
    shard = not < 0 ? shards.room.findIndex((one) => (one.in_use ?? 0) < 0.6 * (one.room_for ?? 1)) : -1;
    if (shard < 0) {
      let pick = Math.random() * space.reduce((sum, one) => sum + one, 0);
      shard = space.findIndex((one) => (pick -= one) < 0);
    }
    if (shard < 0) shard = Math.floor(Math.random() * shards.count);
  }
  const id = shard.toString(36) + tail(15);
  try {
    localStorage.setItem('village-id', id);
  } catch {
    /* fine */
  }
  return id;
}

const ready = (async () => {
  try {
    const response = await fetch('/api/shards', { headers: key ? { 'x-village-key': key } : {} });
    if (response.ok) shards = await response.json();
  } catch {
    /* an older server, or none: one container, here */
  }
  settle();
})();

function headers() {
  return { 'content-type': 'application/json', 'x-village': village, ...(key ? { 'x-village-key': key } : {}) };
}

async function request(path, options = {}) {
  await ready;
  const response = await fetch(base + path, { ...options, headers: headers() });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.detail || response.statusText);
    error.status = response.status;
    error.code = data.error;
    throw error;
  }
  return data;
}

// The first request of a visit. A brand-new village that lands in a full container is simply
// made again somewhere else.
async function world() {
  for (let tries = 0; ; tries++) {
    try {
      return await request('/api/world');
    } catch (error) {
      if (error.code !== 'full' || !fresh || tries >= shards.count - 1) throw error;
      village = newId(shardOf(village, shards.count));
      place(shardOf(village, shards.count));
    }
  }
}

const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const api = {
  world,
  state: (after = 0, near = [], active = false) => request(`/api/state?after=${after}&near=${encodeURIComponent(near.join(','))}&active=${active ? 1 : 0}`),
  brains: () => request('/api/brains'),
  installation: (id) => request(`/api/installations/${encodeURIComponent(id)}`),
  wake: (id) => post(`/api/villagers/${id}/wake`),
  wakeAll: () => post('/api/wake-all'),
  arcade: (id, move) => post(`/api/villagers/${id}/arcade`, { move }),
  library: () => request('/api/library'),
  libraryFile: (by, name) => request(`/api/library/${encodeURIComponent(by)}/${encodeURIComponent(name)}`),
  sleep: (id) => post(`/api/villagers/${id}/sleep`),
  dare: (id) => post(`/api/villagers/${id}/dare`),
  rebuild: (id, snapshot) => post(`/api/villagers/${id}/rebuild`, { snapshot }),
  files: (id) => request(`/api/villagers/${id}/files`),
  file: (id, path) => request(`/api/villagers/${id}/file?path=${encodeURIComponent(path)}`),
};

// One conversational turn, as an async stream of events (server-sent events over a POST).
export async function* talkStream(id, message, player, look) {
  await ready;
  const response = await fetch(`${base}/api/villagers/${id}/talk`, { method: 'POST', headers: headers(), body: JSON.stringify({ message, player, look }) });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    yield { type: 'error', message: data.message || `The village did not answer (${response.status}).` };
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      if (chunk.startsWith('data: ')) {
        try {
          yield JSON.parse(chunk.slice(6));
        } catch {
          /* skip a malformed event */
        }
      }
    }
  }
}
