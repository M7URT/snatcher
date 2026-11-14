// SNATCHER side panel: the multi-select checklist docked on the tracker page itself.
// Unlike the toolbar popup it stays open while you scroll, re-scans when the page loads more
// results, outlines ticked rows on the page, and reopens on the next page you visit in this tab.
(function () {
  if (window.__snatcherPanel) return;

  const API = () => window.__snatcher;
  const STATE_KEY = 'snatcher-panel';
  const ACCENT = '#e0573a';

  let built = false, isOpen = false, collapsed = false, sending = false;
  let root, panel, tab, listEl;
  let settings = null, info = null, items = [];
  let have = { have: {}, sent: {} }; // what's already on the seedbox / sent before
  let observer = null, rescanTimer = null;
  const marks = new Map(); // key -> { row, outline, offset }

  // ---------- state across page loads (this tab only) ----------

  function remember(value) {
    try { value ? sessionStorage.setItem(STATE_KEY, value) : sessionStorage.removeItem(STATE_KEY); } catch (e) { /* storage blocked */ }
  }
  function recalled() {
    try { return sessionStorage.getItem(STATE_KEY); } catch (e) { return null; }
  }

  // ---------- build ----------

  const CSS = `
    .sp { position: fixed; top: 0; right: 0; bottom: 0; width: 460px; max-width: 100vw; display: flex; flex-direction: column;
          background: #16181d; color: #e8e8ea; font: 13px/1.4 system-ui, sans-serif; border-left: 1px solid #33373f;
          box-shadow: -8px 0 30px rgba(0,0,0,.45); }
    .sp[hidden], .sp-tab[hidden] { display: none; }
    .sp-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #33373f; }
    .sp-brand { font-weight: 800; letter-spacing: .08em; color: ${ACCENT}; }
    .sp-sec { flex: 1; color: #9a9ca5; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sp button { flex: none; }
    .sp-icon { border: 0; background: none; color: #9a9ca5; font-size: 16px; cursor: pointer; padding: 2px 6px; border-radius: 4px; }
    .sp-icon:hover { color: #e8e8ea; background: #262931; }
    .sp-tools { display: flex; gap: 6px; align-items: center; padding: 8px 12px; border-bottom: 1px solid #33373f; }
    .sp-tools label { display: flex; gap: 4px; align-items: center; color: #9a9ca5; white-space: nowrap; }
    .sp input[type=search], .sp select { background: #1f2228; color: #e8e8ea; border: 1px solid #33373f; border-radius: 6px; padding: 5px 7px; font: inherit; min-width: 0; }
    .sp-filter { flex: 1; }
    .sp-setall { width: 120px; }
    .sp-list { flex: 1; overflow-y: auto; }
    .sp-item { display: grid; grid-template-columns: 18px 1fr 150px 16px; gap: 8px; align-items: start; padding: 8px 12px; border-bottom: 1px solid #262931; }
    .sp-item > input { margin-top: 3px; }
    .sp-item > .sp-st { margin-top: 4px; }
    .sp-item:hover { background: #1f2228; }
    .sp-item.on { background: #241c1a; }
    .sp-name { overflow: hidden; cursor: pointer; }
    .sp-title { overflow-wrap: break-word; line-height: 1.35; }
    .sp-seeds { color: #9a9ca5; font-size: 11px; margin-top: 2px; }
    .sp-seeds .zero { color: #e0574f; }
    .sp-size { color: #c9cbd2; }
    .sp-have { display: inline-block; margin-left: 6px; padding: 0 5px; border-radius: 3px; font-size: 10px; font-weight: 600;
               background: #1f3a2b; color: #6fd39b; }
    .sp-item.got .sp-title { color: #9a9ca5; }
    .sp-grip { position: absolute; left: -4px; top: 0; bottom: 0; width: 8px; cursor: ew-resize; }
    .sp-grip:hover, .sp-grip.drag { background: rgba(224,87,58,.5); }
    .sp-item select { width: 100%; }
    .sp-item select.auto { border-color: #5a4a2a; }
    .sp-st { text-align: center; font-weight: 700; }
    .sp-st.queued, .sp-st.sending { color: #9a9ca5; }
    .sp-st.done { color: #3fae6f; }
    .sp-st.error { color: #e0574f; cursor: help; }
    .sp-st.skipped { color: #6fd39b; cursor: help; }
    .sp-empty { padding: 24px; text-align: center; color: #9a9ca5; display: flex; flex-direction: column; gap: 12px; align-items: center; }
    .sp-empty[hidden] { display: none; }
    .sp-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-top: 1px solid #33373f; }
    .sp-count { color: #9a9ca5; }
    .sp-btn { padding: 8px 16px; border-radius: 6px; border: 1px solid ${ACCENT}; background: ${ACCENT}; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
    .sp-btn:disabled { opacity: .5; cursor: default; }
    .sp-tab { position: fixed; right: 0; top: 40%; writing-mode: vertical-rl; background: ${ACCENT}; color: #fff; cursor: pointer;
              font: 700 12px system-ui, sans-serif; letter-spacing: .08em; padding: 12px 6px; border-radius: 8px 0 0 8px;
              box-shadow: -4px 0 14px rgba(0,0,0,.35); }
  `;

  function build() {
    root = API().shadowHost();
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    panel = document.createElement('div');
    panel.className = 'sp';
    panel.innerHTML = `
      <div class="sp-grip" title="Drag to resize"></div>
      <div class="sp-head">
        <span class="sp-brand">SNATCHER</span><span class="sp-sec"></span>
        <button class="sp-icon sp-settings" title="Settings">⚙</button>
        <button class="sp-icon sp-min" title="Tuck away (keeps your ticks)">⇥</button>
        <button class="sp-icon sp-close" title="Close  (Alt+Shift+S)">×</button>
      </div>
      <div class="sp-tools">
        <label><input type="checkbox" class="sp-all"> All</label>
        <input type="search" class="sp-filter" placeholder="Filter: rivals 1080p -x265" title="All words must match, any order. &quot;exact phrase&quot; in quotes, -word to exclude.">
        <label title="Hide torrents whose seeder count is 0"><input type="checkbox" class="sp-seedonly"> Hide 0 seeds</label>
        <select class="sp-setall" title="Change the folder of every ticked torrent"><option value="">Set ticked to…</option></select>
        <button class="sp-icon sp-rescan" title="Re-scan the page">↻</button>
      </div>
      <div class="sp-list"></div>
      <div class="sp-empty" hidden></div>
      <div class="sp-foot"><span class="sp-count"></span><button class="sp-btn sp-send" disabled>Snatch</button></div>`;
    root.appendChild(panel);

    tab = document.createElement('div');
    tab.className = 'sp-tab';
    tab.hidden = true;
    tab.title = 'Open SNATCHER panel';
    root.appendChild(tab);

    listEl = panel.querySelector('.sp-list');
    const q = sel => panel.querySelector(sel);
    q('.sp-close').onclick = closePanel;
    q('.sp-min').onclick = () => setCollapsed(true);
    tab.onclick = () => setCollapsed(false);
    q('.sp-settings').onclick = () => chrome.runtime.sendMessage({ type: 'openOptions' });
    q('.sp-rescan').onclick = rescan;
    q('.sp-filter').oninput = render;
    q('.sp-all').onchange = e => {
      visible().filter(i => !e.target.checked || !haveLabel(i)).forEach(i => setChecked(i, e.target.checked));
      render();
    };
    q('.sp-setall').onchange = e => {
      if (!e.target.value) return;
      items.filter(i => i.checked).forEach(i => { i.destinationId = e.target.value; i.manual = true; });
      e.target.value = '';
      render();
    };
    q('.sp-send').onclick = sendTicked;
    q('.sp-seedonly').onchange = e => {
      settings.hideNoSeeders = e.target.checked;
      chrome.storage.local.set({ hideNoSeeders: e.target.checked });
      render();
    };
    wireResize(q('.sp-grip'));
    built = true;
  }

  function wireResize(grip) {
    grip.onmousedown = e => {
      e.preventDefault();
      grip.classList.add('drag');
      const move = ev => { panel.style.width = Math.max(360, Math.min(innerWidth - 40, innerWidth - ev.clientX)) + 'px'; };
      const up = () => {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
        grip.classList.remove('drag');
        chrome.storage.local.set({ panelWidth: parseInt(panel.style.width, 10) });
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
    };
  }

  // ---------- open / close ----------

  async function openPanel(startCollapsed) {
    settings = await SN.getSettings();
    if (!built) build();
    isOpen = true;
    panel.style.width = (settings.panelWidth || 520) + 'px';
    panel.querySelector('.sp-seedonly').checked = settings.hideNoSeeders !== false;
    fillSetAll();
    rescan();
    setCollapsed(!!startCollapsed);
    refreshHave();
    startObserver();
    document.addEventListener('pointerdown', onOutside, true);
  }

  // Clicking anywhere on the page outside the panel closes it (ticks are kept for next time).
  // Clicks on the page's own scrollbar don't count, so you can still drag-scroll.
  function onOutside(e) {
    if (!isOpen || collapsed) return;
    if (e.composedPath().includes(root.host)) return;
    const html = document.documentElement;
    if (e.clientX >= html.clientWidth || e.clientY >= html.clientHeight) return;
    closePanel();
  }

  function closePanel() {
    isOpen = false;
    if (built) { panel.hidden = true; tab.hidden = true; }
    remember(null);
    stopObserver();
    clearMarks();
    document.removeEventListener('pointerdown', onOutside, true);
  }

  function setCollapsed(value) {
    collapsed = value;
    panel.hidden = value;
    tab.hidden = !value;
    const n = items.filter(i => i.checked).length;
    tab.textContent = n ? `SNATCHER · ${n}` : 'SNATCHER';
    remember(value ? 'collapsed' : 'open');
  }

  function toggle() {
    if (!isOpen) openPanel(false);
    else if (collapsed) setCollapsed(false);
    else closePanel();
  }

  // ---------- already have it? ----------

  async function refreshHave() {
    try { have = (await chrome.runtime.sendMessage({ type: 'seedboxState' })) || have; } catch (e) { /* extension reloaded */ }
    if (isOpen) render();
  }

  function haveLabel(it) {
    if (it.status === 'done') return '';
    if (have.sent && have.sent[it.key]) return 'Sent before';
    const on = have.have && have.have[SN.normName(it.name)];
    return on ? `On ${on}` : '';
  }

  // ---------- data ----------

  function rescan() {
    info = API().scan();
    const old = new Map(items.map(i => [i.key, i]));
    const next = info.items.map(it => {
      const prev = old.get(it.key);
      if (prev) { old.delete(it.key); return Object.assign(prev, { name: it.name, rowContext: it.rowContext, seeders: it.seeders, size: it.size, catKey: it.catKey, catText: it.catText }); }
      const p = SN.pickDestination(settings, info.host, it.rowContext, info.pageContext, it.catKey, it.catText);
      const byRules = p.via === 'learned' ? SN.pickDestination({ ...settings, learned: {} }, info.host, it.rowContext, info.pageContext, '', it.catText).destinationId : p.destinationId;
      const where = { category: 'the category', row: 'this row', page: 'the page section' }[p.via];
      const why = p.via === 'learned' ? 'your usual folder for this category · ' : where ? `“${p.hit}” in ${where} · ` : 'default · ';
      return { ...it, destinationId: p.destinationId, autoId: p.destinationId, ruleAuto: byRules, via: p.via,
        why: why + it.rowContext.split(' | ').slice(0, 3).join(' · '), checked: false, status: '', error: '' };
    });
    // Anything queued or mid-send stays listed even if the page dropped its row.
    for (const prev of old.values()) if (prev.status === 'queued' || prev.status === 'sending') next.push(prev);
    items = next;

    const pick = SN.pickDestination(settings, info.host, '', info.pageContext);
    const dest = SN.findDestination(settings, pick.destinationId);
    const sec = panel.querySelector('.sp-sec');
    sec.textContent = pick.via === 'default' ? `${info.host} · no section detected` : `${info.host} · looks like ${dest ? dest.name : '?'}`;
    sec.title = info.pageContext;
    items.forEach(i => { if (i.checked) mark(i); });
    render();
  }

  // Torrents the seeder filter hides (count read as 0). Unknown counts are always shown.
  const dead = i => settings.hideNoSeeders !== false && i.seeders === 0 && !i.status;

  // Filter box: every word must appear, in any order. "quoted phrase" matches words together,
  // -word excludes. Dots, dashes and underscores count as spaces, so "rivals 1080p" finds
  // "Rivals.2024.S02E01.1080p.HEVC". Searches the name, the row's category text and the size.
  function filterFor(query) {
    const norm = t => ' ' + String(t || '').toLowerCase().replace(/[._\-+()[\]{}|/\\,:;]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
    const terms = [];
    query.replace(/(-?)"([^"]*)"|(-?)(\S+)/g, (_, n1, phrase, n2, word) => {
      const text = norm(phrase !== undefined ? phrase : word).trim();
      if (text) terms.push({ exclude: !!(n1 || n2), text });
      return '';
    });
    if (!terms.length) return () => true;
    return it => {
      const hay = norm(`${it.name} ${it.rowContext} ${it.size || ''}`);
      return terms.every(t => hay.includes(t.text) !== t.exclude);
    };
  }

  function visible() {
    const match = filterFor(panel.querySelector('.sp-filter').value);
    return items.filter(i => !dead(i) && match(i));
  }

  function setChecked(item, value) {
    item.checked = value;
    value ? mark(item) : unmark(item);
  }

  // ---------- render ----------

  function destSelect(item) {
    const sel = document.createElement('select');
    for (const d of settings.destinations) {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = SN.destinationLabel(settings, d) + (d.id === item.autoId ? ' (auto)' : '');
      o.selected = d.id === item.destinationId;
      sel.appendChild(o);
    }
    sel.classList.toggle('auto', item.destinationId === item.autoId && item.via !== 'default');
    sel.title = `Picked ${item.why}

Read from this row: ${item.rowContext}`;
    sel.disabled = item.status === 'queued' || item.status === 'sending';
    sel.onchange = () => {
      item.destinationId = sel.value;
      item.manual = true;
      setChecked(item, true);
      // Remember it for this tracker category, and move the other untouched torrents of that category too.
      if (item.catKey) {
        SN.learnDestination(info.host, item.catKey, sel.value, item.ruleAuto);
        items.forEach(o => { if (o !== item && o.catKey === item.catKey && !o.manual && !o.status) o.destinationId = sel.value; });
      }
      render();
    };
    return sel;
  }

  function fillSetAll() {
    const sel = panel.querySelector('.sp-setall');
    sel.length = 1;
    settings.destinations.forEach(d => sel.appendChild(new Option(SN.destinationLabel(settings, d), d.id)));
  }

  function render() {
    const scroll = listEl.scrollTop;
    listEl.textContent = '';
    const empty = panel.querySelector('.sp-empty');
    empty.hidden = true;

    if (!settings.clients.length) {
      empty.hidden = false;
      empty.innerHTML = 'No download client set up yet.<button class="sp-btn">Open settings</button>';
      empty.querySelector('button').onclick = () => chrome.runtime.sendMessage({ type: 'openOptions' });
    } else if (!items.length) {
      empty.hidden = false;
      empty.textContent = 'No torrent links found on this page. The panel re-scans when the page changes.';
    }

    for (const it of visible()) {
      const row = document.createElement('div');
      row.className = 'sp-item' + (it.checked ? ' on' : '');
      row.innerHTML = '<input type="checkbox"><div class="sp-name"><div class="sp-title"></div><div class="sp-seeds"></div></div><span class="sel"></span><div class="sp-st"></div>';
      const cb = row.querySelector('input');
      cb.checked = it.checked;
      cb.disabled = it.status === 'queued' || it.status === 'sending';
      cb.onchange = () => { setChecked(it, cb.checked); row.classList.toggle('on', cb.checked); updateFooter(); };

      const title = row.querySelector('.sp-title');
      // Allow line breaks after . _ - so release names wrap at their separators, not mid-word.
      it.name.split(/(?<=[._\-])/).forEach((part, i) => {
        if (i) title.appendChild(document.createElement('wbr'));
        title.appendChild(document.createTextNode(part));
      });
      title.title = 'Click to show it on the page';
      const seeds = row.querySelector('.sp-seeds');
      // Meta line: "1.01 GiB · 42 seeders" (whichever the tracker shows).
      const meta = [];
      if (it.size) meta.push(Object.assign(document.createElement('span'), { className: 'sp-size', textContent: it.size }));
      if (it.seeders !== null && it.seeders !== undefined) {
        meta.push(Object.assign(document.createElement('span'), {
          className: it.seeders === 0 ? 'zero' : '', textContent: `${it.seeders} seeder${it.seeders === 1 ? '' : 's'}` }));
      }
      meta.forEach((m, i) => { if (i) seeds.appendChild(document.createTextNode(' · ')); seeds.appendChild(m); });
      const got = haveLabel(it);
      if (got) {
        const tag = document.createElement('span');
        tag.className = 'sp-have';
        tag.textContent = got;
        seeds.appendChild(tag);
        row.classList.add('got');
      }
      if (!seeds.childNodes.length) seeds.remove();
      row.querySelector('.sp-name').onclick = () => reveal(it);
      row.querySelector('.sel').replaceWith(destSelect(it));

      const st = row.querySelector('.sp-st');
      st.className = 'sp-st ' + (it.status || '');
      st.textContent = { queued: '·', sending: '…', done: '✓', error: '✕', skipped: '=' }[it.status] || '';
      if (it.error) st.title = it.error;
      listEl.appendChild(row);
    }
    listEl.scrollTop = scroll;
    updateFooter();
  }

  function updateFooter() {
    const ticked = items.filter(i => i.checked && i.status !== 'done' && !dead(i));
    const vis = visible();
    const want = vis.filter(i => !haveLabel(i));
    panel.querySelector('.sp-all').checked = want.length > 0 && want.every(i => i.checked);
    const btn = panel.querySelector('.sp-send');
    if (sending) {
      const total = items.filter(i => ['queued', 'sending', 'done', 'error', 'skipped'].includes(i.status) && i.batch).length;
      const finished = items.filter(i => ['done', 'error', 'skipped'].includes(i.status) && i.batch).length;
      btn.disabled = true;
      btn.textContent = `Sending ${Math.min(finished + 1, total)} of ${total}…`;
    } else {
      btn.disabled = ticked.length === 0;
      btn.textContent = ticked.length ? `Snatch ${ticked.length}` : 'Snatch';
    }
    const done = items.filter(i => i.status === 'done').length;
    const hidden = items.filter(dead).length;
    panel.querySelector('.sp-count').textContent = `${items.filter(i => i.checked).length} ticked · ${items.length - hidden} shown` +
      (hidden ? ` · ${hidden} hidden (0 seeds)` : '') + (done ? ` · ${done} sent` : '');
    if (tab) tab.textContent = items.filter(i => i.checked).length ? `SNATCHER · ${items.filter(i => i.checked).length}` : 'SNATCHER';
  }

  // ---------- on-page highlighting ----------

  function mark(item, color) {
    const row = API().rowFor(item.key);
    if (!row) return;
    const prev = marks.get(item.key);
    if (prev && prev.row !== row) unmark(item); // page re-rendered the row
    if (!marks.has(item.key)) marks.set(item.key, { row, outline: row.style.outline, offset: row.style.outlineOffset });
    row.style.outline = `2px ${color === 'done' ? 'dashed #3fae6f' : 'solid ' + ACCENT}`;
    row.style.outlineOffset = '-2px';
  }

  function unmark(item) {
    const m = marks.get(item.key);
    if (!m) return;
    m.row.style.outline = m.outline;
    m.row.style.outlineOffset = m.offset;
    marks.delete(item.key);
  }

  function clearMarks() {
    for (const key of [...marks.keys()]) unmark({ key });
  }

  function reveal(item) {
    const row = API().rowFor(item.key);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const bg = row.style.backgroundColor;
    row.style.transition = 'background-color .3s';
    row.style.backgroundColor = 'rgba(224,87,58,.35)';
    setTimeout(() => { row.style.backgroundColor = bg; }, 900);
  }

  // ---------- sending ----------

  async function sendTicked() {
    const chosen = items.filter(i => i.checked && i.status !== 'done' && !dead(i));
    if (!chosen.length || sending) return;
    sending = true;
    items.forEach(i => { i.batch = false; });
    chosen.forEach(i => { i.status = 'queued'; i.error = ''; i.batch = true; });
    render();
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'sendItems', fromTab: true, notify: chosen.length > 1,
        items: chosen.map(({ key, name, torrentUrl, magnetUrl, destinationId }) => ({ key, name, torrentUrl, magnetUrl, destinationId }))
      });
    } catch (e) {
      res = { results: chosen.map(i => ({ key: i.key, ok: false, error: 'Extension was reloaded — refresh this page' })) };
    }
    for (const r of (res && res.results) || []) {
      const it = items.find(i => i.key === r.key);
      if (it) finish(it, r.ok ? 'done' : r.skipped ? 'skipped' : 'error', r.error);
    }
    sending = false;
    render();
    refreshHave();
    const results = (res && res.results) || [];
    const ok = results.filter(r => r.ok).length;
    const skipped = results.filter(r => r.skipped).length;
    const failed = results.length - ok - skipped;
    const extra = skipped ? ` · ${skipped} already there` : '';
    API().toast(failed ? `Snatched ${ok} of ${results.length}${extra} — hover ✕ in the panel for why` : `Snatched ${ok} of ${results.length}${extra}`, !failed);
  }

  function finish(it, status, error) {
    it.status = status;
    it.error = error || '';
    if (status === 'skipped') { it.checked = false; unmark(it); }
    if (status === 'done') { it.checked = false; unmark(it); mark(it, 'done'); }
  }

  function onProgress(msg) {
    const it = items.find(i => i.key === msg.key);
    if (!it || !isOpen) return;
    if (msg.status === 'sending') it.status = 'sending';
    else finish(it, msg.status, msg.error);
    render();
  }

  // ---------- re-scan when the page loads more results ----------

  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver(muts => {
      if (!muts.some(m => m.addedNodes.length || m.removedNodes.length)) return;
      clearTimeout(rescanTimer);
      rescanTimer = setTimeout(() => { if (isOpen) rescan(); }, 800);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) observer.disconnect();
    observer = null;
    clearTimeout(rescanTimer);
  }

  chrome.storage.onChanged.addListener(async () => {
    if (!isOpen) return;
    settings = await SN.getSettings();
    fillSetAll();
    render();
  });

  window.__snatcherPanel = { toggle, open: openPanel, close: closePanel, onProgress };

  // Reopen on the next page of this tab if it was left open, but only where there's something to grab.
  const was = recalled();
  if (was && API() && API().scan().items.length) openPanel(was === 'collapsed');
})();
