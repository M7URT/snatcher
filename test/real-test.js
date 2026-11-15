// See real-test.html. Extension pages can't run inline scripts, hence this file.
(async () => {
  const q = new URLSearchParams(location.search);
  const want = (q.get('clients') || 'qbittorrent,deluge').split(',');
  const dl = (q.get('dl') || '/downloads').replace(/\\/g, '/');
  const mock = q.get('mock') || 'http://127.0.0.1:8095';
  const out = [];
  const log = (name, pass, detail) => out.push({ name, pass: !!pass, detail });
  const all = {
    // No port in the address on purpose: SNATCHER should add the app's usual one.
    qbittorrent: { id: 'rq', type: 'qbittorrent', name: 'QBIT', url: 'http://127.0.0.1', username: 'admin', password: q.get('qbpass') || 'snatchertest1', baseDir: dl, sendLabels: true, startPaused: true },
    deluge: { id: 'rd', type: 'deluge', name: 'DELUGE', url: 'http://127.0.0.1', password: q.get('depass') || 'deluge', baseDir: dl, sendLabels: true, startPaused: true },
    transmission: { id: 'rt', type: 'transmission', name: 'TRANS', url: 'http://127.0.0.1', username: q.get('truser') || '', password: q.get('trpass') || '', baseDir: dl, sendLabels: true, startPaused: true }
  };
  const clients = want.map(w => all[w]).filter(Boolean);
  const destinations = clients.map(c => ({ id: 'd_' + c.id, name: 'TV_SHOWS ' + c.name, clientId: c.id, directory: 'TV_SHOWS', label: 'TV' }));
  await chrome.storage.local.set({ clients, destinations, defaultDestinationId: destinations[0].id, notifications: false, skipDuplicates: true });
  await new Promise(r => setTimeout(r, 1500)); // let the background worker pick up the change (header rules)

  const send = async (c, item, skip = true) => {
    await chrome.storage.local.set({ skipDuplicates: skip });
    const res = await chrome.runtime.sendMessage({ type: 'sendItems', notify: false, items: [{ key: item.key || item.torrentUrl || item.magnetUrl, destinationId: 'd_' + c.id, ...item }] });
    await chrome.storage.local.set({ skipDuplicates: true });
    return (res && res.results && res.results[0]) || { error: 'no answer' };
  };
  for (const c of clients) {
    const t = await chrome.runtime.sendMessage({ type: 'testClient', client: c });
    log(c.name + ' test connection', t && t.ok, t && (t.info || t.error));
    const tor = { name: 'Sample Show ' + c.id + ' S01E01 1080p', torrentUrl: mock + '/sample-real' + c.id + '.torrent' };
    let r = await send(c, tor);
    log(c.name + ' sends .torrent', r.ok, r.error || r.destination);
    r = await send(c, tor);
    log(c.name + ' skips same name', r.skipped, r.error);
    r = await send(c, { ...tor, name: 'Totally different title', key: 'x1' + c.id });
    log(c.name + ' skips same hash, other name', r.skipped, r.error);
    r = await send(c, { ...tor, name: 'Totally different title', key: 'x2' + c.id }, false);
    log(c.name + ' client itself reports duplicate', r.skipped, r.error);
    const h = { rq: 'B', rd: 'D', rt: 'E' }[c.id].repeat(40);
    const mag = { name: 'Magnet Thing ' + c.id, magnetUrl: 'magnet:?xt=urn:btih:' + h + '&dn=Magnet.Thing.' + c.id };
    r = await send(c, mag);
    log(c.name + ' sends magnet', r.ok, r.error);
    r = await send(c, { ...mag, name: 'renamed magnet', key: 'm2' + c.id });
    log(c.name + ' skips magnet by hash', r.skipped, r.error);
  }
  const st = await chrome.runtime.sendMessage({ type: 'seedboxState' });
  log('panel "On client" tags see the torrents', st && Object.keys(st.have || {}).length >= clients.length, JSON.stringify(st && st.have).slice(0, 300));
  document.getElementById('out').textContent = out.map(o => (o.pass ? 'PASS ' : 'FAIL ') + o.name + ' — ' + o.detail).join('\n');
  await fetch(mock + '/report', { method: 'POST', body: JSON.stringify(out) });
})().catch(e => fetch('http://127.0.0.1:8095/report', { method: 'POST', body: JSON.stringify([{ name: 'harness crashed', pass: false, detail: String(e.stack || e) }]) }));
