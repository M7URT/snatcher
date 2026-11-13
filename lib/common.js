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

  const DEFAULTS = {
    clients: [],               // {id, name, url, username, password, startPaused}
    defaultClientId: '',
    destinations: DEFAULT_DESTINATIONS,
    defaultDestinationId: 'd_other',
    rules: DEFAULT_RULES,      // {id, site, scope: row|page|any, match, destinationId}
    interceptClicks: true,     // hijack clicks on torrent links
    confirmOnClick: true,      // show the little picker instead of sending instantly
    preferTorrent: true,       // if a row has both .torrent and magnet, use the .torrent
    extraLinkPattern: '',      // extra regex for download links on odd trackers
    notifications: true,
    iconOpens: 'panel',        // toolbar icon opens the on-page side panel, or 'popup'
    hideNoSeeders: true,       // side panel hides rows whose seeder count is 0
    panelWidth: 520            // side panel width in px (drag its left edge)
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
  function pickDestination(settings, host, rowContext, pageContext) {
    const rules = (settings.rules || []).filter(r => r.match && siteMatches(r.site, host));
    const passes = [
      { text: rowContext || '', scopes: ['row', 'any'], via: 'row' },
      { text: pageContext || '', scopes: ['page', 'any'], via: 'page' }
    ];
    for (const pass of passes) {
      if (!pass.text) continue;
      for (const r of rules) {
        if (!pass.scopes.includes(r.scope || 'any')) continue;
        const re = safeRegex(r.match);
        if (re && re.test(pass.text) && findDestination(settings, r.destinationId)) {
          return { destinationId: r.destinationId, ruleId: r.id, via: pass.via };
        }
      }
    }
    return { destinationId: settings.defaultDestinationId, ruleId: null, via: 'default' };
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

  // A real .torrent is a bencoded dictionary: starts with "d" and contains "4:info".
  function looksLikeTorrent(buf) {
    const b = new Uint8Array(buf);
    if (b.length < 20 || b[0] !== 0x64) return false;
    const head = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, 4096)));
    return head.includes('4:info') || head.includes('8:announce') || head.includes('13:announce-list');
  }

  globalThis.SN = {
    uid, DEFAULTS, getSettings, saveSettings, siteMatches, safeRegex, pickDestination,
    findDestination, clientForDestination, destinationLabel, bufToB64, b64ToBytes, looksLikeTorrent
  };
})();
