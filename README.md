# SNATCHER

A Brave/Chrome extension (Manifest V3) that sends `.torrent` and magnet links from the page you're browsing to your ruTorrent clients. It picks the folder from the section you're in, and you can always change it.

It's just a conduit: it doesn't host, index or link to any content. It moves a torrent file you can already open into a client you own.

## Install (Brave)

1. Open `brave://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick the `C:\SNATCHER` folder
4. The settings page opens. Add your client(s), then pin the SNATCHER icon to the toolbar.

After you edit any file, click the ↻ reload button on the SNATCHER card in `brave://extensions`, then refresh the tracker tab.

## Quick setup from Add Remote Torrent

1. In SNATCHER settings click **Import from Add Remote Torrent…** and pick your exported `Add Remote Torrent_settings.json`.
2. You get your servers (URL, relative path, login), one folder per entry in *Available Download Directories* (folder name used as both the directory and the label), auto-detect rules for those folders, and your extra link-catching patterns.
3. Click **Test connection** on the server.

The import replaces your current clients, folders and rules, but keeps the test server.

### Two per-server settings that matter

- **Base folder (full path on the server)**, e.g. `/downloads`. Folder names like `TV_SHOWS` are sent as `/downloads/TV_SHOWS`. A bare name would be put inside ruTorrent's *default* folder instead (giving `/downloads/TV_SHOWS/TV_SHOWS`), and that torrent can't start. Folders written as full paths are sent unchanged.
- **Send labels**: untick it if ruTorrent's *Autotools → AutoMove* is on with a catch-all filter like `/.*/`. AutoMove grabs any labelled torrent as soon as it's added and moves it while it's still empty, which leaves it stuck on "Pausing". With labels off, the folder alone decides where it goes, the same as Add Remote Torrent.

## Test server (no seedbox needed)

```
python test/mock_rutorrent.py
```

By default it asks for a Digest login, the same as dediseedbox. Add `--basic` to test a Basic-login seedbox instead. Then click **+ Add test server** in settings. That adds `TEST (local mock)` at `http://127.0.0.1:8090` with path `/rutorrent`, user `test` and password `snatcher-test`, plus a **TEST (mock server)** folder. Anything you send to that folder is printed in the terminal (folder, label, paused, file or magnet), and uploaded `.torrent` files are saved to `test/received/`. Nothing is downloaded.

## Setup

**1. Clients.** Add one entry per ruTorrent:
| Field | What to put |
|---|---|
| ruTorrent URL | The address you open ruTorrent at, e.g. `https://yourbox.seedbox.net/rutorrent/` or `http://192.168.1.10/rutorrent/` |
| Username / Password | The HTTP login for ruTorrent. It's the same one Add Remote Torrent / Xirvik's extension asked for |

Click **Test connection**. ✓ means you're good.

**2. Destinations.** Named folders such as Movies, Foreign Movies, TV Shows and Apps. Each one has:
- **Client**: which box it goes to (or "Default client")
- **Directory**: the path on that box, e.g. `/home/you/torrents/movies`. Copy it from ruTorrent's *Add torrent → Base directory* field.
- **Label**: the ruTorrent label.

**3. Rules.** These map what's on the page to a destination. Starter rules for TV, Foreign, Movies and Apps are already there. Each rule is a case-insensitive regex:
- `foreign|non-english` → Foreign Movies
- `\bS\d{1,2}E\d{1,3}\b|tv|episodes?|series` → TV Shows
- Restrict a rule to one tracker with **Site**, e.g. `*.mytracker.org`. Trackers often use category IDs, so a rule like `cat=17` with Site `mytracker.org` works.

Rules run top to bottom and the first match wins. A match on the torrent's **own row** (category icon, category link, title) beats a match on the **page** (title, URL, headings, highlighted menu tab). So a mixed "browse all" page still sorts per torrent.

Use the tester box under the rules to try out text, and hover the grey line under each torrent in the popup to see what SNATCHER read from that row.

## Using it

- **Click a download/magnet link** to get a small picker with the detected folder already selected. Press Enter or click **Snatch**. Alt/Ctrl/Shift-click downloads the file normally. In settings you can switch off the picker so clicks send straight away.
- **Side panel (toolbar icon or Alt+Shift+S)**: a checklist of every torrent on the page, docked on the right. It stays open while you scroll.
  - Tick what you want (or **All** / filter, then **All**), adjust any folder or use **Set ticked to…**, then press **Snatch N**. Everything is sent one after another with no more clicks.
  - Ticked rows get an orange outline on the page, and sent rows a green dashed one. Click a name to scroll to it.
  - Failures show ✕ (hover for why) and stay ticked, so one more click retries them.
  - It re-scans when the page loads more results. If you leave it open it comes back on the next page in that tab; **⇥** tucks it into a small tab on the edge.
  - Settings → Behaviour can switch the toolbar icon back to the small popup. The shortcut can be changed at `brave://extensions/shortcuts`.
- **Toolbar popup**: lists every torrent on the page with its auto-picked folder. Tick the ones you want (or All), change any folder, then click **Snatch N**. Each row shows ✓/✕ when done (hover ✕ for the error).
- **Right-click any link → SNATCHER** to auto-detect, or send to a specific destination.

## How it gets the torrent

1. It downloads the `.torrent` from inside the tracker tab, so your tracker login cookies are used. That's why private trackers work.
2. If that fails, it tries from the extension itself.
3. Then it falls back to the row's magnet, if there is one.
4. As a last resort it gives ruTorrent the URL to fetch itself (works when the link has your passkey in it).

Uploads go to ruTorrent's `php/addtorrent.php` with `dir_edit` (folder), `label`, and optionally `not_add_path` / `torrents_start_stopped`.

## Notes

- Settings, including passwords, live in `chrome.storage.local` on this machine only and are not synced. **Export settings** writes them, passwords included, to a JSON file. Keep it private.
- The extension asks for access to all sites so it works on any tracker and any seedbox URL.
- If a tracker's download links aren't spotted, add a regex for them under *Behaviour → Extra download-link pattern*.
- `test/fake-tracker.html` is a dummy page used to check detection. It stubs out the extension APIs and isn't part of the extension.
