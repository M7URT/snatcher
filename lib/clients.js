// SNATCHER download-client adapters. Loaded by the background worker after background helpers
// (baseUrl, authFetch, connLog, fullDirectory, serverSays, loginError, addToRutorrent…) exist.
//
// Every adapter has:
//   test(client)               -> { ok, info | error }
//   add(client, dest, payload) -> { ok: true } | { duplicate: true }   (throws on failure)
//   list(client)               -> [{ hash, name }]   torrents already on the client
//   listDir(client, dir)       -> { path, dirs }     (ruTorrent only: folder check)
// payload is { b64, filename, name } (.torrent file) or { url, name } (magnet or link).

// ---------- shared ----------

// fetch() with the browser's cookies (session logins), a timeout and a connection-log line.
async function plainFetch(client, url, opts = {}, timeout = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { credentials: 'include', ...opts, signal: ctrl.signal });
    connLog({ step: 'request', client: client.name, method: opts.method || 'GET', path: pathOf(url), status: res.status });
    return res;
  } catch (e) {
    connLog({ step: 'request', client: client.name, method: opts.method || 'GET', path: pathOf(url),
      error: e.name === 'AbortError' ? `no answer in ${timeout / 1000}s` : String(e.message || e) });
    if (e.name === 'AbortError') throw new Error(`${client.name}: no answer from the server within ${timeout / 1000} seconds`);
    throw new Error(`${client.name}: couldn't reach the server (${e.message}) — check the address`);
  } finally {
    clearTimeout(timer);
  }
}

// The client's address without a trailing slash, with the default port added when none is given.
function rootUrl(client) {
  const type = SN.CLIENT_TYPES[client.type] || {};
  let u = baseUrl(client).replace(/\/+$/, '');
  try {
    const x = new URL(u);
    if (!x.port && type.port && !/^https:/.test(u) && !(client.url || '').match(/:\d+/)) { x.port = type.port; u = x.toString().replace(/\/+$/, ''); }
  } catch (e) { /* leave as is */ }
  return u;
}

function labelFor(client, dest) {
  return client.sendLabels === false ? '' : (dest.label || client.defaultLabel || '');
}

const upperHash = h => String(h || '').toUpperCase();

// ---------- ruTorrent ----------

const rutorrent = {
  test: client => testClient(client),
  async add(client, dest, payload) {
    await addToRutorrent(client, dest, payload);
    return { ok: true };
  },
  async list(client) {
    const res = await authFetch(client, baseUrl(client) + 'plugins/httprpc/action.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'mode=list'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    // Keyed by info-hash; each value is [is_open, is_hash_checking, is_hash_checked, state, name, ...]
    return Object.entries(j.t || {}).map(([hash, v]) => ({ hash: upperHash(hash), name: Array.isArray(v) ? String(v[4] || '') : '' }));
  },
  listDir: (client, dir) => listDir(client, dir)
};

// ---------- Deluge (Web UI JSON-RPC at /json) ----------

let delugeId = 0;
const delugeLoggedIn = {}; // client.id -> true once logged in this session

function delugeUrl(client) {
  return rootUrl(client).replace(/\/json$/i, '') + '/json';
}

async function delugeRaw(client, method, params) {
  const res = await plainFetch(client, delugeUrl(client), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ method, params, id: ++delugeId })
  });
  if (res.status === 404) throw new Error(`${client.name}: Deluge Web UI not found at ${delugeUrl(client)} — check the address`);
  if (!res.ok) throw new Error(`${client.name}: HTTP ${res.status}${await serverSays(res)}`);
  let j;
  try { j = await res.json(); } catch (e) { throw new Error(`${client.name}: that address didn't answer like Deluge`); }
  return j;
}

async function delugeLogin(client) {
  const j = await delugeRaw(client, 'auth.login', [client.password || '']);
  if (j.result !== true) throw new Error(`${client.name}: Deluge refused the password — use the Web UI password`);
  // The Web UI has to be connected to a Deluge daemon. Connect to the first one if it isn't.
  const c = await delugeRaw(client, 'web.connected', []);
  if (c.result !== true) {
    const hosts = (await delugeRaw(client, 'web.get_hosts', [])).result || [];
    if (!hosts.length) throw new Error(`${client.name}: the Deluge Web UI has no daemon to connect to — open the Web UI's Connection Manager`);
    await delugeRaw(client, 'web.connect', [hosts[0][0]]);
  }
  delugeLoggedIn[client.id] = true;
}

async function deluge(client, method, params) {
  if (!delugeLoggedIn[client.id]) await delugeLogin(client);
  let j = await delugeRaw(client, method, params);
  if (j.error && /auth|not authenticated/i.test(j.error.message || '') || (j.error && j.error.code === 1)) {
    await delugeLogin(client);
    j = await delugeRaw(client, method, params);
  }
  if (j.error) {
    const err = new Error(`${client.name}: Deluge said "${j.error.message || 'error'}"`);
    err.deluge = j.error.message || '';
    throw err;
  }
  return j.result;
}

const delugeAdapter = {
  async test(client) {
    delete delugeLoggedIn[client.id];
    await delugeLogin(client);
    let v = '';
    try { v = await deluge(client, 'daemon.get_version', []); } catch (e) { /* older daemons */ }
    return { ok: true, info: `Connected to Deluge${v ? ' ' + v : ''}` };
  },
  async add(client, dest, payload) {
    const dir = fullDirectory(client, dest.directory);
    const options = { add_paused: !!client.startPaused };
    if (dir) options.download_location = dir;
    let hash;
    try {
      if (payload.b64) {
        const fname = (payload.filename || payload.name || 'snatched').replace(/[\\/:*?"<>|]+/g, '_') + (/\.torrent$/i.test(payload.filename || '') ? '' : '.torrent');
        hash = await deluge(client, 'core.add_torrent_file', [fname, payload.b64, options]);
      } else if (/^magnet:/i.test(payload.url)) {
        hash = await deluge(client, 'core.add_torrent_magnet', [payload.url, options]);
      } else {
        hash = await deluge(client, 'core.add_torrent_url', [payload.url, options]);
      }
    } catch (e) {
      if (/already/i.test(e.deluge || '')) return { duplicate: true };
      throw e;
    }
    connLog({ step: 'Deluge answer', client: client.name, folder: dir || '(default)', result: hash ? 'added' : '(no hash)' });
    // Labels need Deluge's Label plugin; labels there are lower-case letters, digits, - and _.
    const label = labelFor(client, dest).toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
    if (label && hash) {
      try { await deluge(client, 'label.add', [label]); } catch (e) { /* exists already, or no Label plugin */ }
      try { await deluge(client, 'label.set_torrent', [hash, label]); } catch (e) { connLog({ step: 'Deluge label skipped', client: client.name, note: e.deluge || String(e.message) }); }
    }
    return { ok: true };
  },
  async list(client) {
    const r = await deluge(client, 'core.get_torrents_status', [{}, ['name']]);
    return Object.entries(r || {}).map(([hash, v]) => ({ hash: upperHash(hash), name: (v && v.name) || '' }));
  }
};

// ---------- qBittorrent (Web API v2) ----------
// qBittorrent refuses requests whose Origin isn't its own address (CSRF protection), so
// background.js adds a header rule (declarativeNetRequest) that gives SNATCHER's requests to each
// qBittorrent client that client's own Origin/Referer.

function qbUrl(client, path) {
  return rootUrl(client).replace(/\/api\/v2.*$/i, '') + '/api/v2/' + path;
}

async function qbLogin(client) {
  const res = await plainFetch(client, qbUrl(client, 'auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: client.username || '', password: client.password || '' }).toString()
  });
  const t = (await res.text()).trim();
  if (res.status === 403) throw new Error(`${client.name}: qBittorrent has temporarily banned this address after failed logins — wait, then check the password`);
  if (res.status === 404) throw new Error(`${client.name}: qBittorrent Web UI not found at that address`);
  if (!res.ok || /fail/i.test(t)) throw new Error(`${client.name}: qBittorrent refused the login (${t || 'HTTP ' + res.status}) — check the username and password`);
}

async function qb(client, path, opts = {}) {
  let res = await plainFetch(client, qbUrl(client, path), opts);
  if (res.status === 403 || res.status === 401) {
    await qbLogin(client);
    res = await plainFetch(client, qbUrl(client, path), opts);
  }
  if (res.status === 401) throw new Error(`${client.name}: qBittorrent said Unauthorized — in qBittorrent's Web UI options, check "Enable Host header validation" lists this address`);
  if (res.status === 403) throw new Error(`${client.name}: qBittorrent login didn't stick — check the username and password`);
  return res;
}

const qbAdapter = {
  async test(client) {
    await qbLogin(client);
    const res = await qb(client, 'app/version');
    const v = res.ok ? (await res.text()).trim() : '';
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, info: `Connected to qBittorrent ${v}` };
  },
  async add(client, dest, payload) {
    const form = new FormData();
    if (payload.b64) {
      let fname = (payload.filename || payload.name || 'snatched').replace(/[\\/:*?"<>|]+/g, '_');
      if (!/\.torrent$/i.test(fname)) fname += '.torrent';
      form.append('torrents', new Blob([SN.b64ToBytes(payload.b64)], { type: 'application/x-bittorrent' }), fname);
    } else {
      form.append('urls', payload.url);
    }
    const dir = fullDirectory(client, dest.directory);
    if (dir) { form.append('savepath', dir); form.append('autoTMM', 'false'); }
    if (client.startPaused) { form.append('paused', 'true'); form.append('stopped', 'true'); } // v4 / v5 names
    const label = labelFor(client, dest);
    if (label) form.append('category', label);
    const res = await qb(client, 'torrents/add', { method: 'POST', body: form });
    const t = (await res.text()).trim();
    connLog({ step: 'qBittorrent answer', client: client.name, folder: dir || '(default)', category: label || '(none)', result: t || `HTTP ${res.status}` });
    if (res.status === 415) throw new Error(`${client.name}: qBittorrent says that isn't a valid torrent`);
    if (res.status === 409) return { duplicate: true }; // qBittorrent 5.x: already in the list
    if (!res.ok) throw new Error(`${client.name}: HTTP ${res.status}${t ? ` — ${t.slice(0, 120)}` : ''}`);
    // qBittorrent 5.x answers JSON {success_count, failure_count, pending_count, …}; older ones "Ok." / "Fails."
    let j = null;
    try { j = JSON.parse(t); } catch (e) { /* plain text */ }
    if (j && typeof j === 'object') {
      if ((j.success_count || 0) + (j.pending_count || 0) > 0) return { ok: true };
      return { duplicate: true, maybe: true };
    }
    if (/^fails/i.test(t)) return { duplicate: true, maybe: true }; // older qBittorrent: "Fails." for duplicates
    return { ok: true };
  },
  async list(client) {
    const res = await qb(client, 'torrents/info');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).map(t => ({ hash: upperHash(t.hash), name: t.name || '' }));
  }
};

// ---------- Transmission (RPC) ----------

const trSession = {}; // client.id -> X-Transmission-Session-Id

function trUrl(client) {
  const u = rootUrl(client);
  if (/\/rpc$/i.test(u)) return u;
  if (/\/web$/i.test(u)) return u.replace(/\/web$/i, '/rpc');
  return u + '/transmission/rpc';
}

async function transmission(client, method, args = {}) {
  const call = () => authFetch(client, trUrl(client), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(trSession[client.id] ? { 'X-Transmission-Session-Id': trSession[client.id] } : {}) },
    body: JSON.stringify({ method, arguments: args })
  });
  let res = await call();
  if (res.status === 409) { // first call of a session: Transmission hands out its anti-CSRF id
    trSession[client.id] = res.headers.get('X-Transmission-Session-Id') || '';
    res = await call();
  }
  if (res.status === 401 || res.status === 403) throw new Error(loginError(client, res));
  if (res.status === 404) throw new Error(`${client.name}: Transmission RPC not found at ${trUrl(client)} — check the address`);
  if (!res.ok) throw new Error(`${client.name}: HTTP ${res.status}${await serverSays(res)}`);
  let j;
  try { j = await res.json(); } catch (e) { throw new Error(`${client.name}: that address didn't answer like Transmission`); }
  if (j.result !== 'success') throw new Error(`${client.name}: Transmission said "${j.result}"`);
  return j.arguments || {};
}

const trAdapter = {
  async test(client) {
    const a = await transmission(client, 'session-get', { fields: ['version'] });
    return { ok: true, info: `Connected to Transmission ${a.version || ''}`.trim() };
  },
  async add(client, dest, payload) {
    const args = { paused: !!client.startPaused };
    if (payload.b64) args.metainfo = payload.b64; else args.filename = payload.url;
    const dir = fullDirectory(client, dest.directory);
    if (dir) args['download-dir'] = dir;
    const label = labelFor(client, dest);
    if (label) args.labels = [label];
    const a = await transmission(client, 'torrent-add', args);
    connLog({ step: 'Transmission answer', client: client.name, folder: dir || '(default)', result: a['torrent-duplicate'] ? 'duplicate' : 'added' });
    if (a['torrent-duplicate']) return { duplicate: true };
    return { ok: true };
  },
  async list(client) {
    const a = await transmission(client, 'torrent-get', { fields: ['hashString', 'name'] });
    return (a.torrents || []).map(t => ({ hash: upperHash(t.hashString), name: t.name || '' }));
  }
};

const ADAPTERS = { rutorrent, deluge: delugeAdapter, qbittorrent: qbAdapter, transmission: trAdapter };
const adapterFor = client => ADAPTERS[(client && client.type) || 'rutorrent'] || rutorrent;
