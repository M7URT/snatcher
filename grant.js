// Small window opened from the side panel: asks Chrome/Brave for permission to run on a site.
const q = new URLSearchParams(location.search);
const pattern = SN.sitePattern(q.get('url'));
const tabId = q.get('tab') ? Number(q.get('tab')) : null;
const host = pattern ? new URL(pattern.slice(0, -1)).hostname : '';
document.getElementById('host').textContent = host || 'this site';
document.getElementById('host2').textContent = host || 'this site';
if (!pattern) {
  document.getElementById('site').disabled = true;
  document.getElementById('msg').textContent = "SNATCHER can't run on this kind of page.";
}

async function ask(origins) {
  const ok = await chrome.permissions.request({ origins });
  if (!ok) { document.getElementById('msg').textContent = 'Not allowed — nothing changed.'; return; }
  if (tabId != null) await chrome.runtime.sendMessage({ type: 'siteGranted', tabId });
  window.close();
}
document.getElementById('site').onclick = () => ask([pattern]);
document.getElementById('all').onclick = () => ask(SN.ALL_SITES);
document.getElementById('no').onclick = () => window.close();
