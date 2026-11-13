// SNATCHER content script: finds torrent links on the page, works out which section each
// one belongs to, intercepts clicks, and fetches .torrent files with the page's own cookies.
(function () {
  if (window.__snatcherLoaded) return;
  window.__snatcherLoaded = true;

  let settings = null;
  let lastRightClicked = null;
  const OVERLAY_ID = 'snatcher-overlay-host';

  SN.getSettings().then(s => { settings = s; });
  chrome.storage.onChanged.addListener(() => SN.getSettings().then(s => { settings = s; }));

  // ---------- link detection ----------

  const DOWNLOAD_RE = /\.torrent(?:$|[?#])|download\.php|\/download(?:\/|\?|$)|\/dl\/|\/down\.php|action=download|torrent_pass=|passkey=|get_?torrent|\/torrents?\/\d+\/download/i;

  function linkKind(a) {
    if (!a || !a.href || a.closest('#' + OVERLAY_ID)) return null;
    const href = a.href;
    if (href.startsWith('magnet:')) return 'magnet';
    if (!/^https?:/i.test(href)) return null;
    if (DOWNLOAD_RE.test(href)) return 'torrent';
    if (settings && settings.extraLinkPattern) {
      const re = SN.safeRegex(settings.extraLinkPattern);
      if (re && re.test(href)) return 'torrent';
    }
    return null;
  }

  // How many distinct torrent (and magnet) links live inside an element.
  function downloadCount(el) {
    const t = new Set(), m = new Set();
    el.querySelectorAll('a[href]').forEach(x => {
      const k = linkKind(x);
      if (k === 'torrent') t.add(x.href); else if (k === 'magnet') m.add(x.href);
    });
    return Math.max(t.size, m.size);
  }

  // The "row" of a link = the biggest ancestor that still holds only this one torrent.
  // Works for table-based trackers (<tr>) and div/card-based ones alike.
  function rowOf(a) {
    const tr = a.closest('tr');
    if (tr && downloadCount(tr) <= 1) return tr;
    let best = a.parentElement || a;
    let el = best.parentElement;
    for (let i = 0; el && el !== document.body && i < 8; i++, el = el.parentElement) {
      if (downloadCount(el) > 1) break;
      best = el;
    }
    return best;
  }

  function clean(t) { return (t || '').replace(/\s+/g, ' ').trim(); }

  function titleFor(row, a) {
    const candidates = [...row.querySelectorAll('a[href]')]
      .filter(x => !linkKind(x) && clean(x.textContent).length > 3)
      .map(x => ({ x, text: clean(x.textContent), score: clean(x.textContent).length + (/details|torrents?[\/.?]|[?&]id=/i.test(x.href) ? 200 : 0) }))
      .sort((p, q) => q.score - p.score);
    if (candidates.length) return candidates[0].text;
    const own = clean(a.getAttribute('title') || a.textContent);
    if (own.length > 3 && !/^(download|dl|get|torrent)$/i.test(own)) return own;
    if (a.href.startsWith('magnet:')) {
      const dn = new URLSearchParams(a.href.slice(a.href.indexOf('?') + 1)).get('dn');
      if (dn) return dn;
    }
    try {
      const last = decodeURIComponent(new URL(a.href).pathname.split('/').pop() || '');
      if (last) return last;
    } catch (e) { /* ignore */ }
    return a.href;
  }

  // Links that point at a tracker category: browse.php?cat=5, /torrents?categories[]=2,
  // /torrents?categoryIds[0]=3, /cat/tv, ?c41=1, /section/…
  const CAT_HREF = /categor|[?&](cats?|type|types)(\[\d*\])?=|\/cats?\/|[?&]c\d+=|section|browse/i;

  // Just the row's category, e.g. "TV :: Boxsets": category link text, data-category, "cat" cells.
  function catTextFor(row) {
    const bits = [];
    row.querySelectorAll('a[href]').forEach(el => {
      if (CAT_HREF.test(el.getAttribute('href') || '')) bits.push(clean(el.textContent));
    });
    row.querySelectorAll('[data-category], [class*="categor" i], [class*="cat" i]').forEach(el => {
      bits.push(el.getAttribute('data-category') || '');
      const t = clean(el.textContent);
      if (t.length < 60) bits.push(t);
    });
    return [...new Set(bits.map(clean).filter(b => b && b.length < 60))].join(' | ').slice(0, 300);
  }

  // Category hints living inside the row: icon alt/title, category links, cells with "cat" classes.
  function rowContextFor(row, title) {
    const bits = [catTextFor(row)];
    row.querySelectorAll('img[alt], img[title], [title]').forEach(el => {
      const t = el.getAttribute('alt') || el.getAttribute('title');
      if (t && t.length < 80) bits.push(t);
    });
    row.querySelectorAll('a[href]').forEach(el => {
      if (CAT_HREF.test(el.getAttribute('href') || '')) {
        bits.push(clean(el.textContent), el.getAttribute('href'));
      }
    });
    row.querySelectorAll('[class*="cat" i], [data-category]').forEach(el => {
      bits.push(el.getAttribute('data-category') || '', clean(el.textContent).slice(0, 80));
    });
    bits.push(title);
    return [...new Set(bits.map(clean).filter(Boolean))].join(' | ').slice(0, 1000);
  }

  // A stable id for the row's tracker category, used to remember folders you pick by hand:
  // the category link (e.g. "browse.php?cat=5"), else the category icon text, else a "cat" cell.
  function categoryKeyFor(row) {
    for (const a of row.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (/categor|[?&](cats?|types?)(\[\d*\])?=|\/cats?\/|[?&]c\d+=/i.test(href)) {
        try { const u = new URL(href, location.href); return 'link:' + u.pathname + u.search; } catch (e) { return 'link:' + href; }
      }
    }
    const img = row.querySelector('img[alt], img[title]');
    const alt = img && clean(img.getAttribute('alt') || img.getAttribute('title'));
    if (alt && alt.length < 60 && !/download|magnet|bookmark|free|new|seed|leech/i.test(alt)) return 'icon:' + alt;
    const cat = row.querySelector('[data-category], [class*="cat" i]');
    const t = cat && clean(cat.getAttribute('data-category') || cat.textContent);
    if (t && t.length < 60) return 'cat:' + t;
    return '';
  }

  function pageContext() {
    const bits = [document.title, decodeURIComponent(location.pathname + location.search)];
    const sel = 'h1, h2, .breadcrumb, .breadcrumbs, [class*="breadcrumb" i], nav .active, .active, .selected, .current, [aria-current]';
    document.querySelectorAll(sel).forEach((el, i) => {
      if (i < 25) bits.push(clean(el.textContent).slice(0, 120));
    });
    document.querySelectorAll('select option:checked').forEach((o, i) => {
      if (i < 10 && o.value) bits.push(clean(o.textContent));
    });
    return [...new Set(bits.map(clean).filter(Boolean))].join(' | ').slice(0, 2000);
  }

  // ---------- seeders ----------
  // Tables: find the column whose header says Seeders/Seeds/S/↑ (text, icon alt or title) and read
  // that cell. Other layouts: an element whose class/title mentions "seed". null = couldn't tell.

  const seedColCache = new WeakMap();
  const SEED_HEAD = /^(s|se|sd|seeds?|seeders?|seeding|↑|▲|⬆)$|seed/i;

  function cellsWithIndex(tr) {
    const out = [];
    let col = 0;
    for (const cell of tr.cells) {
      out.push({ cell, col });
      col += cell.colSpan || 1;
    }
    return out;
  }

  function headerLabel(cell) {
    const bits = [cell.textContent, cell.getAttribute('title') || ''];
    cell.querySelectorAll('img, [title], [aria-label]').forEach(e => bits.push(e.getAttribute('alt') || '', e.getAttribute('title') || '', e.getAttribute('aria-label') || ''));
    return bits.map(clean).filter(Boolean);
  }

  // Index of the column whose header passes `test(labels)`, or -1. Cached per table.
  function headerColumn(table, cache, test) {
    if (cache.has(table)) return cache.get(table);
    let found = -1;
    // Header rows only (thead, or rows made of <th>, or the first row) so a torrent named "…Seed…" can't match.
    const headRows = [...table.querySelectorAll('thead tr'), ...[...table.rows].slice(0, 3).filter((tr, i) => i === 0 || tr.querySelector('th'))];
    outer: for (const tr of headRows) {
      for (const { cell, col } of cellsWithIndex(tr)) {
        if (test(headerLabel(cell))) { found = col; break outer; }
      }
    }
    cache.set(table, found);
    return found;
  }

  function seedColumn(table) {
    return headerColumn(table, seedColCache,
      labels => labels.some(l => SEED_HEAD.test(l)) && !labels.some(l => /leech|peer.*leech/i.test(l)));
  }

  // ---------- size ----------
  // "1.01 GiB", "943,92 MB", "1.2GB", "700 MiB" — from a Size column, a size-classed element, or the row text.

  const SIZE_RE = /(\d+(?:[.,]\d+)?)\s*(bytes|[KMGTP]i?B)\b/i;
  const sizeColCache = new WeakMap();

  function sizeText(text) {
    const m = String(text || '').match(SIZE_RE);
    return m ? `${m[1]} ${m[2].length > 2 ? m[2][0].toUpperCase() + m[2].slice(1) : m[2].toUpperCase()}` : null;
  }

  function sizeFor(row) {
    if (row.tagName === 'TR') {
      const table = row.closest('table');
      const col = table ? headerColumn(table, sizeColCache, labels => labels.some(l => /^(size|taille|größe|grosse|tamaño)$|\bsize\b/i.test(l))) : -1;
      if (col >= 0) {
        const hit = cellsWithIndex(row).find(c => c.col === col);
        const s = hit && sizeText(hit.cell.textContent);
        if (s) return s;
      }
    }
    const el = row.querySelector('[data-size], [class*="size" i], [title*="size" i]');
    const s = el && sizeText(el.getAttribute('data-size') || el.textContent || el.getAttribute('title'));
    if (s) return s;
    // Last resort: the row's own text, ignoring the torrent's name (a title like "…4GB…" isn't its size).
    const name = [...row.querySelectorAll('a[href]')].map(a => a.textContent).sort((x, y) => y.length - x.length)[0] || '';
    return sizeText(row.textContent.replace(name, ' '));
  }

  function toNumber(text) {
    const m = String(text || '').replace(/[,\s]/g, '').match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  }

  function seedersFor(row) {
    if (row.tagName === 'TR') {
      const table = row.closest('table');
      const col = table ? seedColumn(table) : -1;
      if (col >= 0) {
        const hit = cellsWithIndex(row).find(c => c.col === col);
        if (hit) { const n = toNumber(hit.cell.textContent); if (n !== null) return n; }
      }
    }
    const el = row.querySelector('[data-seeders], [class*="seed" i], [title*="seed" i]');
    if (el) return toNumber(el.getAttribute('data-seeders') || el.textContent || el.getAttribute('title'));
    return null;
  }

  function itemForLink(a) {
    const row = rowOf(a);
    const kind = linkKind(a);
    const name = titleFor(row, a);
    const item = { key: a.href, name, torrentUrl: '', magnetUrl: '', rowContext: rowContextFor(row, name), seeders: seedersFor(row), size: sizeFor(row), catKey: categoryKeyFor(row), catText: catTextFor(row) };
    if (kind === 'magnet') item.magnetUrl = a.href; else item.torrentUrl = a.href;
    // grab the sibling link of the other kind from the same row
    row.querySelectorAll('a[href]').forEach(x => {
      const k = linkKind(x);
      if (k === 'magnet' && !item.magnetUrl) item.magnetUrl = x.href;
      if (k === 'torrent' && !item.torrentUrl) item.torrentUrl = x.href;
    });
    return item;
  }

  const rowsByKey = new Map(); // item key -> its row element, for the side panel

  function scan() {
    const byRow = new Map();
    document.querySelectorAll('a[href]').forEach(a => {
      const kind = linkKind(a);
      if (!kind) return;
      const row = rowOf(a);
      let item = byRow.get(row);
      if (!item) {
        const name = titleFor(row, a);
        item = { key: '', name, torrentUrl: '', magnetUrl: '', rowContext: rowContextFor(row, name), seeders: seedersFor(row), size: sizeFor(row), catKey: categoryKeyFor(row), catText: catTextFor(row) };
        byRow.set(row, item);
      }
      if (kind === 'magnet' && !item.magnetUrl) item.magnetUrl = a.href;
      if (kind === 'torrent' && !item.torrentUrl) item.torrentUrl = a.href;
    });
    const seen = new Set();
    const items = [];
    rowsByKey.clear();
    for (const [row, item] of byRow.entries()) {
      item.key = item.torrentUrl || item.magnetUrl;
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      rowsByKey.set(item.key, row);
      items.push(item);
    }
    return { host: location.hostname, pageContext: pageContext(), items };
  }

  // ---------- fetching .torrent with the tracker's cookies ----------

  async function fetchTorrent(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`Tracker returned HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (!SN.looksLikeTorrent(buf)) throw new Error('Download was not a .torrent file (logged out, or ratio/limit page?)');
    let filename = '';
    const cd = res.headers.get('content-disposition') || '';
    const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    if (m) { try { filename = decodeURIComponent(m[1]); } catch (e) { filename = m[1]; } }
    return { b64: SN.bufToB64(buf), filename };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'scan') {
      sendResponse(scan());
    } else if (msg.type === 'fetchTorrent') {
      fetchTorrent(msg.url)
        .then(r => sendResponse({ ok: true, ...r }))
        .catch(e => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    } else if (msg.type === 'contextForLink') {
      let a = lastRightClicked && lastRightClicked.href === msg.url ? lastRightClicked : null;
      if (!a) a = [...document.querySelectorAll('a[href]')].find(x => x.href === msg.url);
      const item = a ? itemForLink(a) : { key: msg.url, name: msg.url, torrentUrl: msg.url.startsWith('magnet:') ? '' : msg.url, magnetUrl: msg.url.startsWith('magnet:') ? msg.url : '', rowContext: '' };
      sendResponse({ host: location.hostname, pageContext: pageContext(), item });
    } else if (msg.type === 'toast') {
      toast(msg.text, msg.ok);
    } else if (msg.type === 'togglePanel') {
      if (window.__snatcherPanel) window.__snatcherPanel.toggle();
      sendResponse({ ok: !!window.__snatcherPanel });
    } else if (msg.type === 'progress') {
      if (window.__snatcherPanel) window.__snatcherPanel.onProgress(msg);
    }
  });

  document.addEventListener('contextmenu', e => {
    lastRightClicked = e.target.closest && e.target.closest('a[href]');
  }, true);

  // ---------- click interception ----------

  document.addEventListener('click', e => {
    if (!settings || !settings.interceptClicks) return;
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // Alt/Ctrl/Shift-click = normal behaviour
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || !linkKind(a)) return;
    if (!settings.clients.length) return; // not set up yet: don't get in the way
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const item = itemForLink(a);
    const pick = SN.pickDestination(settings, location.hostname, item.rowContext, pageContext(), item.catKey, item.catText);
    item.destinationId = pick.destinationId;
    if (settings.confirmOnClick) showPicker(item, pick, e.clientX, e.clientY);
    else send([item]);
  }, true);

  async function send(items) {
    const res = await chrome.runtime.sendMessage({ type: 'sendItems', items, fromTab: true });
    const r = res && res.results && res.results[0];
    if (r) toast(r.ok ? `Sent: ${r.name} → ${r.destination}` : `Failed: ${r.error}`, r.ok);
    return r;
  }

  // ---------- in-page UI (shadow DOM so tracker CSS can't break it) ----------

  function shadowHost() {
    let host = document.getElementById(OVERLAY_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = OVERLAY_ID;
      host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;';
      document.documentElement.appendChild(host);
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
        :host { all: initial; }
        .box { position: fixed; width: 320px; background: #1b1d22; color: #e8e8ea; font: 13px/1.4 system-ui, sans-serif;
               border: 1px solid #3a3d45; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.45); padding: 12px; }
        .name { font-weight: 600; margin: 0 22px 8px 0; word-break: break-word; max-height: 3.6em; overflow: hidden; }
        .why { color: #9a9ca5; font-size: 11px; margin-bottom: 8px; }
        select { width: 100%; padding: 6px; background: #262931; color: #e8e8ea; border: 1px solid #444852; border-radius: 6px; font: inherit; }
        .row { display: flex; gap: 6px; margin-top: 10px; }
        button { flex: 1; padding: 7px; border-radius: 6px; border: 1px solid #444852; background: #262931; color: #e8e8ea; cursor: pointer; font: inherit; }
        button.primary { background: #e0573a; border-color: #e0573a; color: #fff; font-weight: 600; }
        button:disabled { opacity: .6; cursor: default; }
        .x { position: absolute; top: 6px; right: 8px; flex: none; border: 0; background: none; font-size: 16px; padding: 2px 6px; }
        .toast { position: fixed; right: 16px; bottom: 16px; max-width: 360px; padding: 10px 14px; border-radius: 8px;
                 font: 13px/1.4 system-ui, sans-serif; color: #fff; box-shadow: 0 6px 20px rgba(0,0,0,.35); }
        .ok { background: #2f8f5b; } .bad { background: #b3392b; }
      </style>`;
    }
    return host.shadowRoot;
  }

  function showPicker(item, pick, x, y) {
    const root = shadowHost();
    root.querySelectorAll('.box').forEach(b => b.remove());
    const box = document.createElement('div');
    box.className = 'box';
    box.style.left = Math.max(8, Math.min(x - 160, innerWidth - 336)) + 'px';
    box.style.top = Math.max(8, Math.min(y + 12, innerHeight - 190)) + 'px';
    const why = pick.via === 'learned' ? 'Your usual folder for this category'
      : pick.via === 'default' ? 'No rule matched — using default'
      : `Matched “${pick.hit}” in ${pick.via === 'category' ? 'the category' : pick.via === 'row' ? 'this row' : 'the page section'}`;
    box.innerHTML = `<button class="x" title="Close">×</button><div class="name"></div><div class="why"></div>
      <select></select>
      <div class="row"><button class="primary send">Snatch</button><button class="normal">Download normally</button></div>`;
    box.querySelector('.name').textContent = item.name;
    box.querySelector('.why').textContent = why;
    const select = box.querySelector('select');
    settings.destinations.forEach(d => {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = SN.destinationLabel(settings, d) + (d.id === pick.destinationId ? '  (auto)' : '');
      if (d.id === pick.destinationId) o.selected = true;
      select.appendChild(o);
    });
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = ev => {
      if (ev.key === 'Escape') close();
      else if (ev.key === 'Enter') { ev.preventDefault(); box.querySelector('.send').click(); }
    };
    document.addEventListener('keydown', onKey, true);
    box.querySelector('.x').onclick = close;
    box.querySelector('.normal').onclick = () => { close(); location.href = item.torrentUrl || item.magnetUrl; };
    box.querySelector('.send').onclick = async ev => {
      ev.target.disabled = true;
      ev.target.textContent = 'Sending…';
      item.destinationId = select.value;
      if (select.value !== pick.destinationId || pick.via === 'learned') {
        const auto = pick.via === 'learned'
          ? SN.pickDestination({ ...settings, learned: {} }, location.hostname, item.rowContext, pageContext(), '', item.catText).destinationId
          : pick.destinationId;
        SN.learnDestination(location.hostname, item.catKey, select.value, auto);
      }
      close();
      await send([item]);
    };
    root.appendChild(box);
    select.focus();
  }

  // Shared with panel.js (same content-script world).
  window.__snatcher = {
    scan, shadowHost, toast, linkKind,
    rowFor: key => rowsByKey.get(key),
    settings: () => settings,
    overlayId: OVERLAY_ID
  };

  function toast(text, ok) {
    const root = shadowHost();
    const t = document.createElement('div');
    t.className = 'toast ' + (ok ? 'ok' : 'bad');
    t.textContent = text;
    root.appendChild(t);
    setTimeout(() => t.remove(), ok ? 3500 : 7000);
  }
})();
