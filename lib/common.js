// Shared helpers used by the content script, background worker, popup and options page.
// Exposed as globalThis.SN so every context can load it with a plain <script> / importScripts.
(function () {
  if (globalThis.SN) return;

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  // Starter destinations/rules. clientId "" means "use the default client".
  // Rules are checked top to bottom; the first match wins. Put the specific ones
  // (Foreign Movies) above the general ones (Movies).
  const DEFAULT_DESTINATIONS = [
    { id: 'd_movies',  name: 'Movies',         clientId: '', directory: '', label: 'Movies',  notAddPath: false },
    { id: 'd_foreign', name: 'Foreign Movies', clientId: '', directory: '', label: 'Foreign', notAddPath: false },
    { id: 'd_tv',      name: 'TV Shows',       clientId: '', directory: '', label: 'TV',      notAddPath: false },
    { id: 'd_apps',    name: 'Apps',           clientId: '', directory: '', label: 'Apps',    notAddPath: false },
    { id: 'd_other',   name: 'Other',          clientId: '', directory: '', label: '',        notAddPath: false }
  ];

  const DEFAULT_RULES = [
    { id: 'r1', site: '*', scope: 'any', match: 'foreign|non[- ]?english|world cinema', destinationId: 'd_foreign' },
    { id: 'r2', site: '*', scope: 'any', match: '\\bS\\d{1,2}E\\d{1,3}\\b|\\bS\\d{1,2}\\b(?=.*complete)|\\btv\\b|episodes?|series|season|anime', destinationId: 'd_tv' },
    { id: 'r3', site: '*', scope: 'any', match: 'movies?|films?|cinema|\\b(19|20)\\d\\d\\b.*\\b(1080p|2160p|720p)\\b', destinationId: 'd_movies' },
    { id: 'r4', site: '*', scope: 'any', match: '\\bapps?\\b|applications?|software|programs?|0day|windows|macos|linux', destinationId: 'd_apps' }
  ];

  // Download apps SNATCHER can send to. "path" = what goes after the address by default.
  const CLIENT_TYPES = {
    rutorrent:    { name: 'ruTorrent',    port: '',     help: 'The address you open ruTorrent at.' },
    deluge:       { name: 'Deluge',       port: '8112', help: 'The Deluge Web UI address (usually port 8112). Password = the Web UI password.' },
    qbittorrent:  { name: 'qBittorrent',  port: '8080', help: 'The qBittorrent Web UI address (Tools → Options → Web UI).' },
    transmission: { name: 'Transmission', port: '9091', help: 'The Transmission web address (usually port 9091).' }
  };

  const DEFAULTS = {
    clients: [],               // {id, type, name, url, username, password, path, baseDir, startPaused, sendLabels, alwaysUrl}
    defaultClientId: '',
    destinations: DEFAULT_DESTINATIONS,
    defaultDestinationId: 'd_other',
    rules: DEFAULT_RULES,      // {id, site, scope: row|page|any, match, destinationId}
    interceptClicks: true,     // hijack clicks on torrent links
    confirmOnClick: true,      // show the little picker instead of sending instantly
    preferTorrent: true,       // if a row has both .torrent and magnet, use the .torrent
    extraLinkPattern: '',      // extra regex for download links on odd trackers
    notifications: true,
    skipDuplicates: true,      // don't send a torrent that's already on the client it's going to
    iconOpens: 'panel',        // toolbar icon opens the on-page side panel, or 'popup'
    hideNoSeeders: true,       // side panel hides rows whose seeder count is 0
    panelWidth: 520,           // side panel width in px (drag its left edge)
    learned: {}                // { host: { categoryKey: destinationId } } — folders you picked by hand
  };

  async function getSettings() {
    const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
    const s = {};
    for (const k of Object.keys(DEFAULTS)) {
      s[k] = stored[k] === undefined ? structuredClone(DEFAULTS[k]) : stored[k];
    }
    return s;
  }

  async function saveSettings(partial) {
    await chrome.storage.local.set(partial);
  }

  // "*.example.org" / "tracker.net" / "*" matched against a hostname.
  function siteMatches(pattern, host) {
    pattern = (pattern || '*').trim().toLowerCase();
    host = (host || '').toLowerCase();
    if (!pattern || pattern === '*') return true;
    return pattern.split(/[,\s]+/).filter(Boolean).some(p => {
      if (p === '*') return true;
      const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      return re.test(host) || host.endsWith('.' + p.replace(/^\*\./, ''));
    });
  }

  function safeRegex(src) {
    try { return new RegExp(src, 'i'); } catch (e) { return null; }
  }

  // Decide which destination an item belongs in.
  // item.rowContext = category text / title from the torrent's own row
  // pageContext     = title, URL, breadcrumbs, active nav of the whole page
  // Row matches beat page matches, so a mixed "browse all" page still routes per row.
  // catText = just the tracker's own category for the row (e.g. "TV :: Boxsets"). It's checked on its
  // own first, so a word in the title or tags ("Windows", "app") can't beat the real category.
  // Returns { destinationId, ruleId, via, hit } — hit is the text the rule matched.
  function pickDestination(settings, host, rowContext, pageContext, catKey, catText) {
    // A folder you picked by hand for this tracker category beats the rules.
    const learned = catKey && settings.learned && settings.learned[host] && settings.learned[host][catKey];
    if (learned && findDestination(settings, learned)) return { destinationId: learned, ruleId: null, via: 'learned' };
    const rules = (settings.rules || []).filter(r => r.match && siteMatches(r.site, host));
    const passes = [
      { text: catText || '', scopes: ['row', 'any'], via: 'category' },
      { text: rowContext || '', scopes: ['row', 'any'], via: 'row' },
      { text: pageContext || '', scopes: ['page', 'any'], via: 'page' }
    ];
    for (const pass of passes) {
      if (!pass.text) continue;
      for (const r of rules) {
        if (!pass.scopes.includes(r.scope || 'any')) continue;
        const re = safeRegex(r.match);
        const m = re && pass.text.match(re);
        if (m && findDestination(settings, r.destinationId)) {
          return { destinationId: r.destinationId, ruleId: r.id, via: pass.via, hit: m[0] };
        }
      }
    }
    return { destinationId: settings.defaultDestinationId, ruleId: null, via: 'default' };
  }

  // Remember (or forget) a hand-picked folder for a tracker category. Returns the updated map.
  async function learnDestination(host, catKey, destinationId, autoId) {
    if (!host || !catKey) return;
    const { learned = {} } = await chrome.storage.local.get('learned');
    learned[host] = learned[host] || {};
    if (destinationId && destinationId !== autoId) learned[host][catKey] = destinationId;
    else delete learned[host][catKey];
    if (!Object.keys(learned[host]).length) delete learned[host];
    await chrome.storage.local.set({ learned });
    return learned;
  }

  // "Rivals 2024 S02E04 1080p x265-ELiTE" and "Rivals.2024.S02E04.1080p.x265-ELiTE" -> same key.
  function normName(name) {
    return String(name || '').toLowerCase().replace(/\.(torrent|mkv|mp4|avi)$/, '').replace(/[^a-z0-9]+/g, '');
  }

  function findDestination(settings, id) {
    return (settings.destinations || []).find(d => d.id === id) || null;
  }

  function clientForDestination(settings, dest) {
    const id = (dest && dest.clientId) || settings.defaultClientId;
    return (settings.clients || []).find(c => c.id === id) || (settings.clients || [])[0] || null;
  }

  function destinationLabel(settings, dest) {
    if (!dest) return '(none)';
    const c = clientForDestination(settings, dest);
    return c && settings.clients.length > 1 ? `${dest.name} → ${c.name}` : dest.name;
  }

  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Info-hash (40 hex, upper case) of a .torrent: SHA-1 of the bencoded "info" dictionary.
  // The same id every torrent client uses, so it spots duplicates whatever the name.
  async function infoHash(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let i = 0;
    const skip = () => { // moves i past one bencoded value
      const c = b[i];
      if (c === 0x69) { const e = b.indexOf(0x65, i); if (e < 0) throw 0; i = e + 1; return; }                 // i...e
      if (c === 0x6c || c === 0x64) { i++; while (b[i] !== 0x65) { if (i >= b.length) throw 0; skip(); } i++; return; } // l/d...e
      let n = 0;                                                                 // <len>:<bytes>
      while (b[i] !== 0x3a) { if (b[i] < 0x30 || b[i] > 0x39) throw 0; n = n * 10 + b[i++] - 0x30; }
      i += n + 1;
    };
    try {
      if (b[0] !== 0x64) return '';
      i = 1;
      while (i < b.length && b[i] !== 0x65) {
        const keyStart = i;
        skip();
        const key = new TextDecoder('latin1').decode(b.subarray(keyStart, i));
        const valStart = i;
        skip();
        if (key === '4:info') {
          const digest = await crypto.subtle.digest('SHA-1', b.slice(valStart, i));
          return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
        }
      }
    } catch (e) { /* not valid bencode */ }
    return '';
  }

  // Info-hash from a magnet link (hex or base32 btih), upper-case hex, or ''.
  function magnetHash(uri) {
    const m = /xt=urn:btih:([a-z0-9]+)/i.exec(uri || '');
    if (!m) return '';
    const h = m[1];
    if (/^[0-9a-f]{40}$/i.test(h)) return h.toUpperCase();
    if (!/^[a-z2-7]{32}$/i.test(h)) return '';
    let bits = '';
    for (const ch of h.toUpperCase()) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch).toString(2).padStart(5, '0');
    return bits.match(/.{4}/g).map(x => parseInt(x, 2).toString(16)).join('').toUpperCase();
  }

  // A real .torrent is a bencoded dictionary: starts with "d" and contains "4:info".
  function looksLikeTorrent(buf) {
    const b = new Uint8Array(buf);
    if (b.length < 20 || b[0] !== 0x64) return false;
    const head = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, 4096)));
    return head.includes('4:info') || head.includes('8:announce') || head.includes('13:announce-list');
  }

  globalThis.SN = {
    uid, DEFAULTS, getSettings, saveSettings, siteMatches, safeRegex, pickDestination, learnDestination, normName,
    findDestination, clientForDestination, destinationLabel, bufToB64, b64ToBytes, looksLikeTorrent, infoHash, magnetHash, CLIENT_TYPES
  };
})();
