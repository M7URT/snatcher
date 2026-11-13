// SNATCHER background worker: uploads torrents to ruTorrent and owns the right-click menu.
importScripts('lib/common.js', 'lib/md5.js');

// ---------- ruTorrent ----------

function baseUrl(client) {
  let u = (client.url || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  u = u.replace(/\/+$/, '');
  // Optional "relative path" (Add Remote Torrent calls it ruTorrent Relative Path), e.g. /rutorrent
  const path = (client.path || '').trim().replace(/^\/+|\/+$/g, '');
  if (path && !u.toLowerCase().endsWith('/' + path.toLowerCase())) u += '/' + path;
  return u + '/';
}

// ---------- auth: Basic or Digest, whichever the server asks for ----------

const digestCache = {}; // client.id -> { scheme: 'basic' } | { scheme: 'digest', challenge, nc }

function basicHeader(client) {
  return 'Basic ' + btoa(unescape(encodeURIComponent(`${client.username}:${client.password || ''}`)));
}

function parseChallenge(header) {
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]*))/g;
  let m;
  while ((m = re.exec(header))) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  return out;
}

function digestHeader(client, method, url, ch, nc) {
  const u = new URL(url);
  const uri = u.pathname + u.search;
  const qop = (ch.qop || '').split(',').map(x => x.trim()).includes('auth') ? 'auth' : '';
  const cnonce = Math.random().toString(16).slice(2, 18);
  const ncHex = nc.toString(16).padStart(8, '0');
  let ha1 = SN_md5(`${client.username}:${ch.realm}:${client.password || ''}`);
  if (/md5-sess/i.test(ch.algorithm || '')) ha1 = SN_md5(`${ha1}:${ch.nonce}:${cnonce}`);
  const ha2 = SN_md5(`${method}:${uri}`);
  const response = qop
    ? SN_md5(`${ha1}:${ch.nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`)
    : SN_md5(`${ha1}:${ch.nonce}:${ha2}`);
  let h = `Digest username="${client.username}", realm="${ch.realm}", nonce="${ch.nonce}", uri="${uri}", response="${response}"`;
  if (ch.algorithm) h += `, algorithm=${ch.algorithm}`;
  if (ch.opaque) h += `, opaque="${ch.opaque}"`;
  if (qop) h += `, qop=${qop}, nc=${ncHex}, cnonce="${cnonce}"`;
  return h;
}

// ---------- connection log (Settings → Backup → Connection log) ----------
// Each login step: method, path, how it logged in, the server's answer. Never the password, and
// never the one-time Digest response hash.

let connLogBuf = null;
async function connLog(entry) {
  if (!connLogBuf) connLogBuf = (await chrome.storage.local.get('connLog')).connLog || [];
  connLogBuf.push({ at: new Date().toISOString().slice(11, 19), ...entry });
  if (connLogBuf.length > 40) connLogBuf.splice(0, connLogBuf.length - 40);
  chrome.storage.local.set({ connLog: connLogBuf });
}

function describeAuth(h) {
  if (!h) return 'no login';
  if (/^Basic/i.test(h)) return 'Basic (user:password)';
  return h.replace(/response="[^"]*"/, 'response="…"').replace(/cnonce="[^"]*"/, 'cnonce="…"');
}

// ---------- letting Brave do the login ----------
// Chromium has its own, battle-tested Digest/Basic login. When ruTorrent answers 401, Brave asks
// extensions for credentials (webRequest.onAuthRequired) and we hand over the ones stored in
// SNATCHER for that server. Brave then logs in and re-sends the upload itself, with no logged-in
// tab needed. It also logs you in automatically when you open ruTorrent in a tab.

const authTries = new Map(); // requestId -> attempts, so a wrong password can't loop forever

chrome.webRequest.onAuthRequired.addListener((details, callback) => {
  if (details.isProxy) { callback({}); return; }
  SN.getSettings().then(settings => {
    const client = settings.clients.find(c => c.username && sameOrigin(details.url, baseUrl(c)));
    if (!client) { callback({}); return; }
    const n = (authTries.get(details.requestId) || 0) + 1;
    authTries.set(details.requestId, n);
    setTimeout(() => authTries.delete(details.requestId), 60000);
    connLog({ step: 'Brave asked for login', client: client.name, path: pathOf(details.url), scheme: details.scheme, realm: details.realm, attempt: n });
    if (n > 1) {
      // Our credentials were already refused for this request: stop (extension requests) or let the
      // normal login box appear (your own tabs).
      callback(details.tabId === -1 ? { cancel: true } : {});
      return;
    }
    callback({ authCredentials: { username: client.username, password: client.password || '' } });
  }).catch(() => callback({}));
}, { urls: ['http://*/*', 'https://*/*'] }, ['asyncBlocking']);

function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch (e) { return false; }
}
function pathOf(u) {
  try { const x = new URL(u); return x.pathname + x.search; } catch (e) { return u; }
}

// fetch() to ruTorrent with the right login.
//  1. Brave's own login (credentials: 'include'), fed by onAuthRequired above.
//  2. Fallback: SNATCHER's own Digest/Basic (credentials: 'omit'), for browsers where (1) is
//     unavailable. Uploads get a fresh challenge with a body-less GET first, because an upload
//     refused with 401 leaves unread bytes on the connection and the next request gets HTTP 400.
// Without a username, the browser's own session (cookies / saved login) is used as-is.
async function authFetch(client, url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const go = async (auth, { probe = false, browser = false, timeout = 30000 } = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const m = probe ? 'GET' : method;
    const how = browser ? 'Brave login' : 'SNATCHER login';
    try {
      const res = await fetch(url, { ...opts, method: m, body: probe ? undefined : opts.body,
        credentials: browser || !client.username ? 'include' : 'omit', signal: ctrl.signal,
        headers: { ...(opts.headers || {}), ...(auth ? { Authorization: auth } : {}) } });
      connLog({ step: how, client: client.name, method: m, path: pathOf(url),
        sent: browser ? '(Brave handles it)' : describeAuth(auth), status: res.status,
        challenge: res.status === 401 ? (res.headers.get('WWW-Authenticate') || '(none)') : undefined });
      return res;
    } catch (e) {
      connLog({ step: how, client: client.name, method: m, path: pathOf(url),
        error: e.name === 'AbortError' ? `no answer in ${timeout / 1000}s` : String(e.message || e) });
      if (e.name === 'AbortError') throw new Error(`${client.name}: no answer from the server within ${timeout / 1000} seconds`);
      throw new Error(`${client.name}: couldn't reach the server (${e.message})`);
    } finally {
      clearTimeout(timer);
    }
  };
  if (!client.username) return go(null);

  // 1. Let Brave log in.
  let first = null;
  try { first = await go(null, { browser: true, timeout: 20000 }); } catch (e) { /* fall back below */ }
  if (first && first.status !== 401 && first.status !== 400) return first;

  // 2. Fallback: SNATCHER's own login.
  const learn = www => {
    if (/^\s*Digest/i.test(www)) digestCache[client.id] = { scheme: 'digest', challenge: parseChallenge(www.replace(/^\s*Digest\s+/i, '')), nc: 0, at: Date.now() };
    else if (/^\s*Basic/i.test(www) || !www) digestCache[client.id] = { scheme: 'basic', at: Date.now() };
  };
  const loginHeader = () => {
    const c = digestCache[client.id];
    if (!c) return null;
    return c.scheme === 'basic' ? basicHeader(client) : digestHeader(client, method, url, c.challenge, ++c.nc);
  };
  const upload = method !== 'GET';
  const probe = async () => {
    for (let i = 0; i < 2; i++) { // a first 400 here just clears junk left on the connection
      const p = await go(null, { probe: true });
      if (p.status === 401) { learn(p.headers.get('WWW-Authenticate') || ''); return; }
      if (p.status !== 400) return;
    }
  };
  const fresh = c => c && (c.scheme === 'basic' || Date.now() - c.at < 240000);
  if (!fresh(digestCache[client.id])) await probe();

  let res = await go(loginHeader());
  if (res.status === 401) {
    const www = res.headers.get('WWW-Authenticate') || '';
    if (upload) await probe(); else learn(www);
    res = await go(loginHeader());
    if (res.status === 401) {
      delete digestCache[client.id];
      res.snatcherAuth = /^\s*Digest/i.test(www) ? 'Digest' : /^\s*Basic/i.test(www) ? 'Basic' : 'unknown';
    }
  }
  return res;
}

// First bit of an unexpected error page, so "HTTP 400" comes with the server's own words.
async function serverSays(res) {
  try {
    const t = (await res.clone().text()).replace(/<(script|style)[\s\S]*?<\/(script|style)>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return t ? ` — server said: "${t.slice(0, 160)}"` : '';
  } catch (e) { return ''; }
}

// Readable reason for a final 401/403, so a failed login says which login type was tried.
function loginError(client, res) {
  const how = res.snatcherAuth ? ` (server asked for a ${res.snatcherAuth} login and rejected SNATCHER's answer)` : '';
  return `${client.name}: login rejected, HTTP ${res.status}${how} — check the username and password in SNATCHER settings`;
}

// rtorrent needs an absolute path. Folder names like "TV_SHOWS" are joined onto the server's
// base folder (e.g. /home/user/downloads/TV_SHOWS). Without a base folder a bare name is NOT
// sent — ruTorrent would hand rtorrent a path it can't use and the torrent can't start.
function fullDirectory(client, directory) {
  const d = (directory || '').trim();
  if (!d) return '';
  if (d.startsWith('/') || d.startsWith('~')) return d;
  const base = (client.baseDir || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error(`${client.name}: folder "${d}" isn't a full path — set the server's Base folder in SNATCHER settings`);
  return `${base}/${d}`;
}

// POST to ruTorrent's php/addtorrent.php. Sends either the .torrent bytes or a URL/magnet.
async function addToRutorrent(client, dest, payload) {
  const form = new FormData();
  if (payload.b64) {
    const blob = new Blob([SN.b64ToBytes(payload.b64)], { type: 'application/x-bittorrent' });
    let fname = payload.filename || (payload.name || 'snatched').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 150);
    if (!/\.torrent$/i.test(fname)) fname += '.torrent';
    form.append('torrent_file', blob, fname);
  } else {
    form.append('url', payload.url);
  }
  const dir = fullDirectory(client, dest.directory);
  if (dir) form.append('dir_edit', dir);
  // "Send labels" off: no label at all (ruTorrent autotools AutoMove acts on any labelled torrent).
  const label = client.sendLabels === false ? '' : (dest.label || client.defaultLabel);
  if (label) form.append('label', label);
  if (dest.notAddPath) form.append('not_add_path', '1');
  if (client.startPaused) form.append('torrents_start_stopped', '1');

  const res = await authFetch(client, baseUrl(client) + 'php/addtorrent.php?json=1', { method: 'POST', body: form });
  if (res.status === 401 || res.status === 403) throw new Error(loginError(client, res));
  if (res.status === 404) throw new Error(`${client.name}: addtorrent.php not found — check the ruTorrent URL`);
  if (!res.ok) throw new Error(`${client.name}: HTTP ${res.status}${await serverSays(res)}`);

  const text = await res.text();
  // Newer ruTorrent answers {"result":"Success"}; older builds redirect to ...?result[]=Success
  let result = '';
  try { result = String(JSON.parse(text).result || ''); } catch (e) { /* not JSON */ }
  if (!result) {
    const m = (res.url + ' ' + text).match(/result(?:%5B%5D|\[\])?=(\w+)/i);
    if (m) result = m[1];
    else if (/addTorrentSuccess|Success/.test(text)) result = 'Success';
    else if (/addTorrentFailed|Failed/.test(text)) result = 'Failed';
  }
  connLog({ step: 'ruTorrent answer', client: client.name, folder: dir || '(default)', label: label || '(none)',
    sent: payload.b64 ? 'torrent file' : 'link', result: result || (text.replace(/\s+/g, ' ').slice(0, 120) || '(empty)') });
  if (/^success$/i.test(result)) return true;
  if (/^FailedDirectory$/i.test(result)) {
    throw new Error(`${client.name}: ruTorrent refused the folder "${dir}" — it doesn't exist there or is outside the folders ruTorrent may use. Run "Check folders on server" in SNATCHER settings.`);
  }
  if (result) throw new Error(`${client.name}: ruTorrent said "${result}"`);
  if (/<form[^>]+(login|password)/i.test(text)) throw new Error(`${client.name}: got a login page — check credentials`);
  // Some setups return an empty 200 on success.
  return true;
}

async function testClient(client) {
  const res = await authFetch(client, baseUrl(client) + 'php/getsettings.php');
  if (res.status === 401 || res.status === 403) return { ok: false, error: loginError(client, res) };
  if (res.status === 404) {
    const root = await authFetch(client, baseUrl(client));
    const t = root.ok ? await root.text() : '';
    if (/rutorrent/i.test(t)) return { ok: true, info: 'ruTorrent found (settings endpoint missing, adding should still work)' };
    return { ok: false, error: `Not found (HTTP 404) — URL should point at the ruTorrent folder` };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}${await serverSays(res)}` };
  const t = await res.text();
  if (/<form[^>]+(login|password)/i.test(t)) return { ok: false, error: 'Got a login page instead of ruTorrent' };
  return { ok: true, info: 'Connected to ruTorrent' };
}

// ---------- folders on the server (ruTorrent _getdir plugin) ----------

// Lists sub-folders of `dir`. Newer ruTorrent answers JSON {path, directories}; older builds an HTML table.
async function listDir(client, dir) {
  const url = baseUrl(client) + 'plugins/_getdir/listdir.php?dir=' + encodeURIComponent(dir) + '&time=' + Date.now();
  const res = await authFetch(client, url);
  if (res.status === 404) throw new Error('ruTorrent folder browser (_getdir plugin) not available');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  try {
    const j = JSON.parse(text);
    return { path: String(j.path || ''), dirs: (j.directories || []).filter(d => d !== '..' && d !== '.') };
  } catch (e) { /* older HTML answer */ }
  const dirs = [];
  const re = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').trim().replace(/\/$/, '');
    if (name && name !== '..' && name !== '.') dirs.push(name);
  }
  return { path: dir, dirs };
}

// For every destination: does its folder exist on its server?  -> { destId: { ok, path, note } }
async function checkFolders() {
  const settings = await SN.getSettings();
  const out = {};
  const listings = new Map(); // "clientId|parent" -> Promise<{path, dirs}>
  for (const d of settings.destinations) {
    const client = SN.clientForDestination(settings, d);
    if (!client) { out[d.id] = { ok: false, note: 'no server' }; continue; }
    let full;
    try { full = fullDirectory(client, d.directory); } catch (e) { out[d.id] = { ok: false, note: 'set the Base folder' }; continue; }
    if (!full) { out[d.id] = { ok: true, path: '(ruTorrent default)', note: 'default folder' }; continue; }
    const clean = full.replace(/\/+$/, '');
    const parent = clean.slice(0, clean.lastIndexOf('/')) || '/';
    const name = clean.slice(clean.lastIndexOf('/') + 1);
    const key = client.id + '|' + parent;
    if (!listings.has(key)) listings.set(key, listDir(client, parent));
    try {
      const listing = await listings.get(key);
      if (listing.path && listing.path.replace(/\/+$/, '') !== parent.replace(/\/+$/, '')) {
        out[d.id] = { ok: false, path: clean, note: `ruTorrent won't list ${parent}` };
      } else {
        const exact = listing.dirs.includes(name);
        const nearly = !exact && listing.dirs.find(x => x.toLowerCase() === name.toLowerCase());
        out[d.id] = exact ? { ok: true, path: clean }
          : { ok: false, path: clean, note: nearly ? `not found — did you mean "${nearly}"?` : 'not found on server' };
      }
    } catch (e) {
      out[d.id] = { ok: false, path: clean, note: String(e.message || e) };
    }
  }
  return out;
}

// ---------- what's already on the seedbox / already sent ----------

const listCache = {}; // client.id -> { at, names: [] }

// Names of every torrent on a client, via ruTorrent's httprpc plugin (cached for a minute).
async function torrentNames(client) {
  const hit = listCache[client.id];
  if (hit && Date.now() - hit.at < 60000) return hit.names;
  const res = await authFetch(client, baseUrl(client) + 'plugins/httprpc/action.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'mode=list'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  // Each torrent is [is_open, is_hash_checking, is_hash_checked, state, name, ...] keyed by hash.
  const names = Object.values(j.t || {}).map(v => Array.isArray(v) ? String(v[4] || '') : '').filter(Boolean);
  listCache[client.id] = { at: Date.now(), names };
  return names;
}

async function seedboxState() {
  const settings = await SN.getSettings();
  const have = {}; // normalised name -> client name
  await Promise.all(settings.clients.filter(c => !c.isTest).map(async c => {
    try { (await torrentNames(c)).forEach(n => { have[SN.normName(n)] = c.name; }); } catch (e) { /* httprpc missing: history only */ }
  }));
  const { sentHistory = {} } = await chrome.storage.local.get('sentHistory');
  return { have, sent: sentHistory };
}

async function recordSent(item, destination) {
  const { sentHistory = {} } = await chrome.storage.local.get('sentHistory');
  sentHistory[item.key] = { name: item.name, at: Date.now(), to: destination };
  const keys = Object.keys(sentHistory);
  if (keys.length > 3000) keys.sort((a, b) => sentHistory[a].at - sentHistory[b].at).slice(0, keys.length - 3000).forEach(k => delete sentHistory[k]);
  await chrome.storage.local.set({ sentHistory });
}

// ---------- getting the .torrent bytes ----------

async function getTorrentPayload(item, tabId, preferTorrent) {
  const useMagnet = item.magnetUrl && (!item.torrentUrl || !preferTorrent);
  if (useMagnet) return { url: item.magnetUrl, name: item.name };

  const errors = [];
  // 1) fetch from inside the tracker tab: same origin, so the tracker's cookies are sent.
  if (tabId != null) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'fetchTorrent', url: item.torrentUrl });
      if (r && r.ok) return { b64: r.b64, filename: r.filename, name: item.name };
      if (r) errors.push(r.error);
    } catch (e) { errors.push(String(e.message || e)); }
  }
  // 2) fetch from the extension (works for cross-domain download hosts).
  try {
    const res = await fetch(item.torrentUrl, { credentials: 'include' });
    const buf = await res.arrayBuffer();
    if (res.ok && SN.looksLikeTorrent(buf)) return { b64: SN.bufToB64(buf), name: item.name };
    errors.push(`HTTP ${res.status}${res.ok ? ' (not a torrent)' : ''}`);
  } catch (e) { errors.push(String(e.message || e)); }
  // 3) magnet if we have one
  if (item.magnetUrl) return { url: item.magnetUrl, name: item.name };
  // 4) hand the URL to ruTorrent and let it download (works when the URL contains a passkey).
  return { url: item.torrentUrl, name: item.name, note: errors.join('; ') };
}

async function sendItems(items, tabId, notify = true) {
  const settings = await SN.getSettings();
  const results = [];
  if (!settings.clients.length) {
    return { results: items.map(i => ({ key: i.key, name: i.name, ok: false, error: 'No download client set up — open SNATCHER options' })) };
  }
  for (const item of items) {
    const dest = SN.findDestination(settings, item.destinationId) || SN.findDestination(settings, settings.defaultDestinationId) || settings.destinations[0];
    const client = SN.clientForDestination(settings, dest);
    const r = { key: item.key, name: item.name, destination: SN.destinationLabel(settings, dest) };
    progress(item.key, 'sending', '', tabId);
    try {
      if (!client) throw new Error('Destination has no client');
      // "Always send URL": let ruTorrent download the .torrent itself (needs a passkey in the link).
      const payload = client.alwaysUrl && item.torrentUrl
        ? { url: item.torrentUrl, name: item.name }
        : await getTorrentPayload(item, tabId, settings.preferTorrent);
      await addToRutorrent(client, dest, payload);
      r.ok = true;
      await recordSent(item, r.destination);
      delete listCache[client.id];
    } catch (e) {
      r.ok = false;
      r.error = String(e.message || e);
    }
    progress(item.key, r.ok ? 'done' : 'error', r.error, tabId);
    results.push(r);
  }
  if (notify) notifySummary(settings, results);
  return { results };
}

// Progress goes to the popup (runtime message) and to the page's side panel (tab message).
function progress(key, status, error, tabId) {
  const msg = { type: 'progress', key, status, error };
  chrome.runtime.sendMessage(msg).catch(() => { /* popup closed */ });
  if (tabId != null) chrome.tabs.sendMessage(tabId, msg).catch(() => { /* tab gone */ });
}

function notifySummary(settings, results) {
  if (!settings.notifications || !results.length) return;
  const ok = results.filter(r => r.ok);
  const bad = results.filter(r => !r.ok);
  let title, message;
  if (results.length === 1) {
    const r = results[0];
    title = r.ok ? `Snatched → ${r.destination}` : 'Snatch failed';
    message = r.ok ? r.name : `${r.name}\n${r.error}`;
  } else {
    title = `Snatched ${ok.length} of ${results.length}`;
    message = bad.length ? `Failed: ${bad.map(b => b.name).slice(0, 3).join(', ')}\n${bad[0].error}` : 'All sent.';
  }
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message: message.slice(0, 300) });
}

// ---------- messages ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'sendItems') {
    const tabId = msg.fromTab ? sender.tab && sender.tab.id : msg.tabId;
    const notify = msg.notify !== undefined ? msg.notify : !msg.fromTab;
    sendItems(msg.items, tabId, notify).then(sendResponse);
    return true;
  }
  if (msg.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
  }
  if (msg.type === 'togglePanel' && msg.tabId != null) {
    togglePanel(msg.tabId);
  }
  if (msg.type === 'checkFolders') {
    checkFolders().then(sendResponse).catch(e => sendResponse({ error: String(e.message || e) }));
    return true;
  }
  if (msg.type === 'seedboxState') {
    seedboxState().then(sendResponse).catch(() => sendResponse({ have: {}, sent: {} }));
    return true;
  }
  if (msg.type === 'testClient') {
    testClient(msg.client).then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
});

// ---------- right-click menu ----------

async function buildMenus() {
  const settings = await SN.getSettings();
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'sn_root', title: 'SNATCHER', contexts: ['link'] });
  chrome.contextMenus.create({ id: 'sn_auto', parentId: 'sn_root', title: 'Snatch (auto-detect folder)', contexts: ['link'] });
  chrome.contextMenus.create({ id: 'sn_sep', parentId: 'sn_root', type: 'separator', contexts: ['link'] });
  for (const d of settings.destinations) {
    chrome.contextMenus.create({ id: 'sn_dest_' + d.id, parentId: 'sn_root', title: 'Send to ' + SN.destinationLabel(settings, d), contexts: ['link'] });
  }
}

// ---------- side panel: toolbar icon + Alt+Shift+S ----------

const PAGE_SCRIPTS = ['lib/common.js', 'content.js', 'panel.js'];

async function togglePanel(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'togglePanel' });
    if (r && r.ok) return;
  } catch (e) { /* no content script in this tab yet */ }
  // Tab was open before SNATCHER was (re)loaded: inject, then toggle.
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: PAGE_SCRIPTS });
    await chrome.tabs.sendMessage(tabId, { type: 'togglePanel' });
  } catch (e) { /* browser page or Web Store: nothing we can do */ }
}

async function applyIconMode() {
  const s = await SN.getSettings();
  await chrome.action.setPopup({ popup: s.iconOpens === 'popup' ? 'popup.html' : '' });
}

chrome.action.onClicked.addListener(tab => togglePanel(tab.id)); // only fires when no popup is set
chrome.commands.onCommand.addListener(async command => {
  if (command !== 'toggle-panel') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) togglePanel(tab.id);
});
applyIconMode();

chrome.runtime.onInstalled.addListener(details => {
  buildMenus();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(buildMenus);
chrome.storage.onChanged.addListener(changes => {
  if (changes.destinations || changes.clients) buildMenus();
  if (changes.iconOpens) applyIconMode();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!String(info.menuItemId).startsWith('sn_')) return;
  const settings = await SN.getSettings();
  let ctx = null;
  try { ctx = await chrome.tabs.sendMessage(tab.id, { type: 'contextForLink', url: info.linkUrl }); } catch (e) { /* no content script */ }
  const isMagnet = info.linkUrl.startsWith('magnet:');
  const item = (ctx && ctx.item) || { key: info.linkUrl, name: info.linkText || info.linkUrl, torrentUrl: isMagnet ? '' : info.linkUrl, magnetUrl: isMagnet ? info.linkUrl : '', rowContext: '' };

  if (info.menuItemId === 'sn_auto') {
    const host = ctx ? ctx.host : new URL(tab.url).hostname;
    item.destinationId = SN.pickDestination(settings, host, item.rowContext, ctx ? ctx.pageContext : tab.title).destinationId;
  } else {
    item.destinationId = String(info.menuItemId).replace('sn_dest_', '');
  }
  const { results } = await sendItems([item], tab.id, false);
  const r = results[0];
  chrome.tabs.sendMessage(tab.id, { type: 'toast', ok: r.ok, text: r.ok ? `Sent: ${r.name} → ${r.destination}` : `Failed: ${r.error}` }).catch(() => {});
});
