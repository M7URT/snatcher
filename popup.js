// Popup: lists every torrent on the current tab with its auto-picked folder; tick and snatch.
const $ = id => document.getElementById(id);
let settings, tab, scan, items = [];

$('openOptions').onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
$('setupBtn').onclick = () => chrome.runtime.openOptionsPage();
$('dock').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'togglePanel', tabId: tab.id });
  window.close();
};

async function scanTab() {
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: 'scan' });
  } catch (e) {
    // Page was open before SNATCHER was installed/reloaded: inject now.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/common.js', 'content.js', 'panel.js'] });
    return await chrome.tabs.sendMessage(tab.id, { type: 'scan' });
  }
}

function destOptions(select, selectedId, autoId) {
  for (const d of settings.destinations) {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = SN.destinationLabel(settings, d) + (d.id === autoId ? ' (auto)' : '');
    if (d.id === selectedId) o.selected = true;
    select.appendChild(o);
  }
}

function render() {
  const list = $('list');
  list.innerHTML = '';
  const q = $('filter').value.trim().toLowerCase();
  for (const it of items) {
    if (q && !it.name.toLowerCase().includes(q) && !it.rowContext.toLowerCase().includes(q)) continue;
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<input type="checkbox"><div class="name"><div class="title"></div><div class="ctx"></div></div><select></select><div class="status"></div>`;
    const cb = row.querySelector('input');
    cb.checked = it.checked;
    cb.onchange = () => { it.checked = cb.checked; updateCount(); };
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = it.torrentUrl && (settings.preferTorrent || !it.magnetUrl) ? 'torrent' : 'magnet';
    const title = row.querySelector('.title');
    title.append(kind, document.createTextNode(it.name));
    title.title = it.name;
    row.querySelector('.ctx').textContent = it.why;
    row.querySelector('.ctx').title = it.rowContext;
    const sel = row.querySelector('select');
    destOptions(sel, it.destinationId, it.autoId);
    sel.classList.toggle('auto', it.destinationId === it.autoId && it.via !== 'default');
    sel.onchange = () => { it.destinationId = sel.value; it.checked = true; render(); updateCount(); };
    const st = row.querySelector('.status');
    st.className = 'status ' + (it.status || '');
    st.textContent = { sending: '…', done: '✓', error: '✕' }[it.status] || '';
    if (it.error) st.title = it.error;
    row.querySelector('.name').onclick = () => { cb.checked = !cb.checked; cb.onchange(); };
    list.appendChild(row);
  }
  updateCount();
}

function updateCount() {
  const n = items.filter(i => i.checked).length;
  $('count').textContent = `${n} of ${items.length} selected`;
  $('send').disabled = n === 0;
  $('send').textContent = n ? `Snatch ${n}` : 'Snatch selected';
  $('selectAll').checked = n && n === items.length;
}

$('filter').oninput = render;
$('selectAll').onchange = e => { items.forEach(i => { i.checked = e.target.checked; }); render(); };
$('setAll').onchange = e => {
  if (!e.target.value) return;
  items.filter(i => i.checked).forEach(i => { i.destinationId = e.target.value; });
  e.target.value = '';
  render();
};

$('send').onclick = async () => {
  const chosen = items.filter(i => i.checked && i.status !== 'done');
  if (!chosen.length) return;
  $('send').disabled = true;
  chosen.forEach(i => { i.status = 'sending'; i.error = ''; });
  render();
  const res = await chrome.runtime.sendMessage({
    type: 'sendItems',
    tabId: tab.id,
    items: chosen.map(({ key, name, torrentUrl, magnetUrl, destinationId }) => ({ key, name, torrentUrl, magnetUrl, destinationId }))
  });
  for (const r of (res && res.results) || []) {
    const it = items.find(i => i.key === r.key);
    if (it) { it.status = r.ok ? 'done' : 'error'; it.error = r.error || ''; if (r.ok) it.checked = false; }
  }
  render();
};

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type !== 'progress') return;
  const it = items.find(i => i.key === msg.key);
  if (it) { it.status = msg.status; it.error = msg.error || ''; render(); }
});

(async function init() {
  settings = await SN.getSettings();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!settings.clients.length) $('setup').classList.remove('hidden');

  try {
    scan = await scanTab();
  } catch (e) {
    $('empty').textContent = "Can't read this page (browser pages and the Web Store are off-limits).";
    $('empty').classList.remove('hidden');
    return;
  }

  const pagePick = SN.pickDestination(settings, scan.host, '', scan.pageContext);
  const pageDest = SN.findDestination(settings, pagePick.destinationId);
  $('section').textContent = pagePick.via === 'default' ? `${scan.host} · no section detected` : `${scan.host} · section looks like ${pageDest ? pageDest.name : '?'}`;
  $('section').title = scan.pageContext;

  items = scan.items.map(it => {
    const p = SN.pickDestination(settings, scan.host, it.rowContext, scan.pageContext, it.catKey);
    const why = p.via === 'learned' ? 'your usual folder · ' : p.via === 'row' ? 'from row: ' : p.via === 'page' ? 'from page section · ' : 'default · ';
    return { ...it, destinationId: p.destinationId, autoId: p.destinationId, via: p.via, why: why + it.rowContext.split(' | ').slice(0, 3).join(' · '), checked: false };
  });

  if (!items.length) { $('empty').classList.remove('hidden'); return; }
  destOptions($('setAll'), null, null);
  $('toolbar').classList.remove('hidden');
  $('footer').classList.remove('hidden');
  render();
})();
