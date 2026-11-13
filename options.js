// Options page: clients, destinations, rules, behaviour, backup. Everything autosaves.
const $ = id => document.getElementById(id);
let s;
let saveTimer;

function save(keys) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const out = {};
    (keys || Object.keys(SN.DEFAULTS)).forEach(k => { out[k] = s[k]; });
    await SN.saveSettings(out);
    $('saved').textContent = 'Saved';
    setTimeout(() => { $('saved').textContent = ''; }, 1200);
  }, 300);
}

function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  children.forEach(c => e.append(c));
  return e;
}

function input(obj, key, attrs = {}) {
  const i = el('input', { value: obj[key] || '', ...attrs });
  i.oninput = () => { obj[key] = i.value; save(); if (attrs.onedit) attrs.onedit(i); };
  return i;
}

function check(obj, key) {
  const c = el('input', { type: 'checkbox', checked: !!obj[key] });
  c.onchange = () => { obj[key] = c.checked; save(); };
  return c;
}

// Defaults to on when the setting has never been saved.
function sendLabelsCheck(c) {
  const box = el('input', { type: 'checkbox', checked: c.sendLabels !== false });
  box.onchange = () => { c.sendLabels = box.checked; save(); };
  return box;
}

function select(obj, key, options, onchange) {
  const sel = el('select');
  options.forEach(([v, t]) => sel.append(el('option', { value: v, textContent: t, selected: (obj[key] || '') === v })));
  sel.onchange = () => { obj[key] = sel.value; save(); if (onchange) onchange(); };
  return sel;
}

const clientOptions = () => [['', 'Default client'], ...s.clients.map(c => [c.id, c.name || '(unnamed)'])];
const destOptions = () => s.destinations.map(d => [d.id, d.name || '(unnamed)']);

// ---------- clients ----------

function renderClients() {
  const box = $('clients');
  box.innerHTML = '';
  if (!s.clients.length) box.append(el('p', { className: 'help', textContent: 'No clients yet — add your seedbox / local ruTorrent.' }));
  s.clients.forEach((c, idx) => {
    const result = el('span', { className: 'result' });
    const test = el('button', { textContent: 'Test connection', className: 'small' });
    test.onclick = async () => {
      result.className = 'result'; result.textContent = 'Testing…';
      const r = await chrome.runtime.sendMessage({ type: 'testClient', client: c });
      result.className = 'result ' + (r.ok ? 'ok' : 'bad');
      result.textContent = r.ok ? '✓ ' + r.info : '✕ ' + r.error;
    };
    const del = el('button', { textContent: 'Remove', className: 'small danger' });
    del.onclick = () => {
      if (!confirm(`Remove client "${c.name}"?`)) return;
      s.clients.splice(idx, 1);
      if (s.defaultClientId === c.id) s.defaultClientId = (s.clients[0] || {}).id || '';
      s.destinations.forEach(d => { if (d.clientId === c.id) d.clientId = ''; });
      save(); renderAll();
    };
    const def = el('input', { type: 'radio', name: 'defClient', checked: s.defaultClientId === c.id });
    def.onchange = () => { s.defaultClientId = c.id; save(); };
    box.append(el('div', { className: 'client' }, [
      el('label', {}, ['Name', input(c, 'name', { placeholder: 'Seedbox', onedit: refreshClientSelects })]),
      el('label', {}, ['ruTorrent URL', input(c, 'url', { placeholder: 'https://box.example.com:12345' })]),
      el('label', {}, ['Username', input(c, 'username', { autocomplete: 'off' })]),
      el('label', {}, ['Password', input(c, 'password', { type: 'password', autocomplete: 'new-password' })]),
      el('label', {}, ['Relative path', input(c, 'path', { placeholder: '/rutorrent' })]),
      el('label', {}, ['Default label', input(c, 'defaultLabel', { placeholder: 'used when a folder has no label' })]),
      el('label', { style: 'grid-column: span 2', title: 'Folder names like TV_SHOWS are put inside this. Copy it from ruTorrent: select a torrent → General tab → Save path (drop the torrent name at the end).' },
        ['Base folder (full path on the server)', input(c, 'baseDir', { placeholder: '/home/you/downloads' })]),
      el('div', { className: 'actions' }, [
        el('label', {}, [def, 'Default client']),
        el('label', {}, [check(c, 'startPaused'), 'Add paused']),
        el('label', { title: 'Untick if ruTorrent autotools AutoMove (or another label rule) moves new torrents and breaks them.' }, [sendLabelsCheck(c), 'Send labels']),
        el('label', { title: 'Let ruTorrent download the .torrent itself instead of SNATCHER uploading it. Only works if the link contains your passkey.' }, [check(c, 'alwaysUrl'), 'Always send URL']),
        test, result, el('span', { className: 'spacer' }), del
      ])
    ]));
  });
}

function refreshClientSelects() {
  document.querySelectorAll('select[data-kind=client]').forEach(sel => {
    [...sel.options].forEach(o => {
      const c = s.clients.find(x => x.id === o.value);
      if (c) o.textContent = c.name || '(unnamed)';
    });
  });
}

function refreshDestSelects() {
  document.querySelectorAll('select[data-kind=dest]').forEach(sel => {
    [...sel.options].forEach(o => {
      const d = s.destinations.find(x => x.id === o.value);
      if (d) o.textContent = d.name || '(unnamed)';
    });
  });
}

$('addClient').onclick = () => {
  const c = { id: SN.uid(), name: s.clients.length ? `Client ${s.clients.length + 1}` : 'Seedbox', url: '', username: '', password: '', startPaused: false };
  s.clients.push(c);
  if (!s.defaultClientId) s.defaultClientId = c.id;
  save(); renderAll();
};

// ---------- destinations ----------

function moveButtons(arr, idx, rerender) {
  const up = el('button', { textContent: '↑', className: 'small', disabled: idx === 0 });
  const down = el('button', { textContent: '↓', className: 'small', disabled: idx === arr.length - 1 });
  up.onclick = () => { [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]]; save(); rerender(); };
  down.onclick = () => { [arr[idx + 1], arr[idx]] = [arr[idx], arr[idx + 1]]; save(); rerender(); };
  return [up, down];
}

function renderDests() {
  const tb = $('dests').querySelector('tbody');
  tb.innerHTML = '';
  s.destinations.forEach((d, idx) => {
    const def = el('input', { type: 'radio', name: 'defDest', checked: s.defaultDestinationId === d.id });
    def.onchange = () => { s.defaultDestinationId = d.id; save(); };
    const cs = select(d, 'clientId', clientOptions());
    cs.dataset.kind = 'client';
    const del = el('button', { textContent: '✕', className: 'small danger', title: 'Remove' });
    del.onclick = () => {
      const used = s.rules.filter(r => r.destinationId === d.id).length;
      if (!confirm(`Remove "${d.name}"?${used ? ` ${used} rule(s) point at it and will be removed too.` : ''}`)) return;
      s.destinations.splice(idx, 1);
      s.rules = s.rules.filter(r => r.destinationId !== d.id);
      if (s.defaultDestinationId === d.id) s.defaultDestinationId = (s.destinations[0] || {}).id || '';
      save(); renderAll();
    };
    tb.append(el('tr', {}, [
      el('td', { className: 'c' }, [def]),
      el('td', {}, [input(d, 'name', { onedit: refreshDestSelects })]),
      el('td', {}, [cs]),
      el('td', {}, [input(d, 'directory', { placeholder: '(ruTorrent default)' })]),
      el('td', {}, [input(d, 'label')]),
      el('td', { className: 'c' }, [check(d, 'notAddPath')]),
      el('td', { className: 'nowrap' }, [...moveButtons(s.destinations, idx, renderAll), del])
    ]));
  });
}

$('addDest').onclick = () => {
  s.destinations.push({ id: SN.uid(), name: 'New folder', clientId: '', directory: '', label: '', notAddPath: false });
  save(); renderAll();
};

// ---------- rules ----------

function renderRules() {
  const tb = $('rules').querySelector('tbody');
  tb.innerHTML = '';
  s.rules.forEach((r, idx) => {
    const ds = select(r, 'destinationId', destOptions(), runTest);
    ds.dataset.kind = 'dest';
    const match = input(r, 'match', { placeholder: 'movies|films', onedit: i => { i.classList.toggle('bad', !SN.safeRegex(i.value)); runTest(); } });
    match.classList.toggle('bad', !SN.safeRegex(r.match));
    const del = el('button', { textContent: '✕', className: 'small danger', title: 'Remove' });
    del.onclick = () => { s.rules.splice(idx, 1); save(); renderRules(); runTest(); };
    tb.append(el('tr', {}, [
      el('td', { style: 'width:150px' }, [input(r, 'site', { placeholder: '*' })]),
      el('td', { style: 'width:120px' }, [select(r, 'scope', [['any', 'Row or page'], ['row', 'Row only'], ['page', 'Page only']], runTest)]),
      el('td', {}, [match]),
      el('td', { style: 'width:170px' }, [ds]),
      el('td', { className: 'nowrap' }, [...moveButtons(s.rules, idx, () => { renderRules(); runTest(); }), del])
    ]));
  });
}

$('addRule').onclick = () => {
  s.rules.push({ id: SN.uid(), site: '*', scope: 'any', match: '', destinationId: s.destinations[0] ? s.destinations[0].id : '' });
  save(); renderRules();
};

function runTest() {
  const t = $('testText').value;
  if (!t) { $('testResult').textContent = ''; return; }
  const p = SN.pickDestination(s, '', t, '');
  const d = SN.findDestination(s, p.destinationId);
  $('testResult').textContent = p.ruleId ? `→ ${d ? d.name : '?'} (rule #${s.rules.findIndex(r => r.id === p.ruleId) + 1})` : `→ ${d ? d.name : '?'} (no rule matched, default)`;
}
$('testText').oninput = runTest;

// ---------- behaviour ----------

document.querySelectorAll('[data-opt]').forEach(i => {
  const k = i.dataset.opt;
  if (i.type === 'checkbox') i.onchange = () => { s[k] = i.checked; save(); };
  else i.oninput = () => { s[k] = i.value; i.classList.toggle('bad', !!i.value && !SN.safeRegex(i.value)); save(); };
});

function renderBehaviour() {
  document.querySelectorAll('[data-opt]').forEach(i => {
    if (i.type === 'checkbox') i.checked = !!s[i.dataset.opt]; else i.value = s[i.dataset.opt] || '';
  });
}

// ---------- backup ----------

$('export').onclick = () => {
  const blob = new Blob([JSON.stringify({ snatcher: 1, ...s }, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'snatcher-settings.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// Auto-detect rules for Add Remote Torrent style folder names. Checked in this order, so the
// specific folders (4K_TV, TV_FOREIGN, MOVIES XMAS HALLMARK…) sit above the general ones.
// Only rules whose folder exists in the import are kept.
const EP = '(\\bS\\d{1,2}E\\d{1,3}\\b|\\bS\\d{1,2}\\b|\\btv\\b|episodes?|series|season)';
const ART_RULES = [
  ['XXX', '\\bxxx\\b|adult|porn|\\b18\\+'],
  ['MOVIES XMAS HALLMARK', 'hallmark'],
  ['TV_XMAS', `(xmas|christmas).*${EP}|${EP}.*(xmas|christmas)`],
  ['MOVIES XMAS', 'xmas|christmas'],
  ['TV_FOREIGN', `foreign.*${EP}|${EP}.*foreign`],
  ['MOVIES FOREIGN', 'foreign|non[- ]?english|world cinema'],
  ['TV_ANIME', `anime.*${EP}|${EP}.*anime`],
  ['MOVIES ANIME', 'anime'],
  ['TV DOCUMENTARY', `docu.*${EP}|${EP}.*docu`],
  ['MOVIES DOCUMENTARY', 'docu'],
  ['MOVIES ANIMATION', 'animation|animated|cartoon'],
  ['MOVIES KIDS', '\\bkids\\b|children|family'],
  ['MOVIES 3D', '\\b3d\\b|half[- ]?sbs|\\bh?sbs\\b'],
  ['4K_TV', `(2160p|\\b4k\\b|\\buhd\\b).*${EP}|${EP}.*(2160p|\\b4k\\b|\\buhd\\b)`],
  ['4K', '2160p|\\b4k\\b|\\buhd\\b'],
  ['STAND UP', 'stand[- ]?up|comedy special'],
  ['GIGS', 'concerts?|\\blive at\\b|\\bgigs?\\b|music ?videos?|\\bmvid\\b'],
  ['AUDIOBOOKS', 'audio ?books?|\\bm4b\\b'],
  ['BOOKS', 'e-?books?|\\bbooks?\\b|\\bepub\\b|\\bmobi\\b|magazines?|comics?'],
  ['GAMES_NINTENDO', 'nintendo|\\bswitch\\b|\\bnsp\\b|\\bxci\\b|\\bwii\\b|\\b3ds\\b'],
  ['GAMES_EMULATORS', 'emulat|\\broms?\\b|retro|\\bmame\\b|\\bpsx\\b|\\bps[12]\\b|\\bsega\\b'],
  ['GAMES_PC', '\\bgames?\\b|\\bgog\\b|fitgirl|\\bdodi\\b|codex|skidrow|\\bdlc\\b'],
  ['APPZ', '\\bapps?\\b|appz|software|applications?|programs?|0day|windows|macos|\\bx64\\b'],
  ['MOVIES OLDIES', 'oldies|classics?'],
  ['TV_SHOWS', EP],
  ['MOVIES', 'movies?|films?|cinema|bluray|web-?dl|remux|1080p|720p']
];

// Convert an "Add Remote Torrent" settings export into SNATCHER settings (replaces clients/folders/rules).
function fromAddRemoteTorrent(data) {
  const servers = (data.servers || []).filter(x => /rutorrent/i.test(x.clientType || 'rutorrent'));
  if (!servers.length) throw new Error('No ruTorrent servers found in that file');
  const clients = servers.map(x => ({
    id: x.id || SN.uid(),
    name: x.name || 'ruTorrent',
    url: x.url || '',
    path: x.ruTorrentrelativepath || '',
    username: x.useBasicAuth && x.basicAuthUsername ? x.basicAuthUsername : (x.username || ''),
    password: x.useBasicAuth && x.basicAuthUsername ? x.basicAuthPassword : (x.password || ''),
    defaultLabel: x.category || '',
    startPaused: !!x.addPaused,
    alwaysUrl: !!x.rutorrentalwaysurl
  }));
  const destinations = [];
  servers.forEach((x, i) => {
    const mapped = {};
    (x.labelDirectoryMap || '').split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([^=]+?)\s*=\s*(.+?)\s*$/);
      if (m) mapped[m[1]] = m[2];
    });
    const dirs = (x.downloadDirectories || '').split(',').map(t => t.trim()).filter(Boolean);
    Object.keys(mapped).forEach(l => { if (!dirs.includes(l)) dirs.push(l); });
    dirs.forEach(dir => destinations.push({
      id: 'd_' + SN.uid(),
      name: servers.length > 1 ? `${dir} (${clients[i].name})` : dir,
      folder: dir,
      clientId: clients[i].id,
      directory: mapped[dir] || dir,
      label: dir,
      notAddPath: !!x.rutorrentdontaddnamepath
    }));
  });
  const first = clients[0].id;
  const byFolder = name => destinations.find(d => d.clientId === first && d.folder.toUpperCase() === name);
  const rules = ART_RULES.filter(([name]) => byFolder(name))
    .map(([name, match]) => ({ id: SN.uid(), site: '*', scope: 'any', match, destinationId: byFolder(name).id }));
  destinations.forEach(d => delete d.folder);
  const def = destinations.find(d => d.label === servers[0].category) || destinations[0];
  const patterns = (data.linkCatchingPatterns || []).map(p => p.pattern).filter(p => p && SN.safeRegex(p));
  const active = clients.find(c => c.id === data.activeServerId) || clients[0];
  return {
    clients, destinations, rules,
    defaultClientId: active.id,
    defaultDestinationId: def ? def.id : '',
    extraLinkPattern: patterns.join('|'),
    interceptClicks: data.catchfrompage !== false,
    confirmOnClick: data.advancedAddDialog !== 'never'
  };
}

$('import').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    let incoming;
    if (data.snatcher) incoming = data;
    else if (Array.isArray(data.servers)) {
      incoming = fromAddRemoteTorrent(data);
      if (!confirm(`Import ${incoming.clients.length} server(s), ${incoming.destinations.length} folders and ${incoming.rules.length} auto-detect rules from Add Remote Torrent?\nThis replaces your current clients, folders and rules.`)) { e.target.value = ''; return; }
    } else throw new Error('Not a SNATCHER or Add Remote Torrent settings file');
    // Keep the local test server (and its folder) across imports.
    const keepTest = s.clients.filter(c => c.isTest && !(incoming.clients || []).some(x => x.id === c.id));
    const keepTestDests = s.destinations.filter(d => keepTest.some(c => c.id === d.clientId));
    for (const k of Object.keys(SN.DEFAULTS)) if (incoming[k] !== undefined) s[k] = incoming[k];
    s.clients = [...s.clients, ...keepTest];
    s.destinations = [...s.destinations, ...keepTestDests];
    await SN.saveSettings(Object.fromEntries(Object.keys(SN.DEFAULTS).map(k => [k, s[k]])));
    renderAll();
    alert('Settings imported. Click "Test connection" on each server to check it.');
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
  e.target.value = '';
};

$('importArt').onchange = $('import').onchange;

// One-click client pointing at test/mock_rutorrent.py on this PC.
$('addTest').onclick = () => {
  if (s.clients.some(c => c.isTest)) { alert('The test server is already in the list.'); return; }
  const c = { id: 'c_test', isTest: true, name: 'TEST (local mock)', url: 'http://127.0.0.1:8090', path: '/rutorrent', username: 'test', password: 'snatcher-test', defaultLabel: 'TEST', baseDir: '/home/test/downloads', startPaused: true, alwaysUrl: false };
  s.clients.push(c);
  if (!s.defaultClientId) s.defaultClientId = c.id;
  if (!s.destinations.some(d => d.clientId === c.id)) {
    s.destinations.push({ id: 'd_test', name: 'TEST (mock server)', clientId: c.id, directory: 'TEST_DOWNLOADS', label: 'TEST', notAddPath: false });
  }
  save(); renderAll();
};

$('reset').onclick = () => {
  if (!confirm('Replace your destinations and rules with the starter set? Clients are kept.')) return;
  s.destinations = structuredClone(SN.DEFAULTS.destinations);
  s.rules = structuredClone(SN.DEFAULTS.rules);
  s.defaultDestinationId = SN.DEFAULTS.defaultDestinationId;
  save(); renderAll();
};

function renderAll() { renderClients(); renderDests(); renderRules(); renderBehaviour(); runTest(); }

SN.getSettings().then(x => { s = x; renderAll(); });
