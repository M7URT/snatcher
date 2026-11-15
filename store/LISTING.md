# Chrome Web Store listing: copy and paste

Everything the Developer Dashboard asks for, in the order it asks. Upload `dist/snatcher-<version>.zip` (made with `python build.py`).

---

## Package → Store listing

**Name**: SNATCHER (from the manifest)

**Summary** (from the manifest, 132 characters max):
> Send torrents and magnet links from any site to your own qBittorrent, Deluge, Transmission or ruTorrent, sorted into folders.

**Category**: Tools

**Language**: English

**Description**:

```
SNATCHER sends torrents from the page you're on straight to your own torrent client, at home or on a seedbox, without downloading the .torrent file and opening it yourself.

WORKS WITH
• qBittorrent (Web UI)
• Deluge (Web UI)
• Transmission
• ruTorrent

SEND THE WAY YOU LIKE
• Click a torrent or magnet link: a small picker shows where it will go. Press Snatch, or choose another folder first.
• Open the side panel (toolbar icon or Alt+Shift+S): every torrent on the page in one list, with size and seeders. Tick the ones you want and send them all at once.
• Right-click any torrent link → SNATCHER → pick a folder.

THE RIGHT FOLDER, AUTOMATICALLY
Set up folders such as "Linux ISOs", "Films" or "Software", each on any of your clients. SNATCHER reads the category next to each torrent and picks the folder for you, using rules you can change. If you pick a different folder by hand, it remembers that choice for that category next time.

NO DUPLICATES
SNATCHER checks what's already on your client, by name and by the torrent's info-hash, and skips anything you already have. The panel marks torrents that are already there.

ONLY TORRENTS
Ordinary downloads (.exe, .zip, .iso, .pdf…) are never touched. They download as usual.

PRIVATE BY DESIGN
• Your settings and passwords stay in your browser. SNATCHER has no servers, analytics or tracking.
• It only talks to your own clients and to the site the torrent link points to.
• It only runs on the sites you allow. Anywhere else, click its icon to use it once.

Open source: https://github.com/M7URT/snatcher
```

**Graphic assets** (all in `store/images/`):
- Screenshots (1280×800): `1-panel.png`, `2-picker.png`, `3-settings.png`
- Small promo tile (440×280): `promo-440x280.png`
- Store icon (128×128): `icons/icon128.png`

**Official URL**: none
**Homepage URL**: https://github.com/M7URT/snatcher
**Support URL**: https://github.com/M7URT/snatcher/issues

---

## Privacy practices

**Single purpose**:
> Send torrent and magnet links from web pages to a torrent client the user runs themself (qBittorrent, Deluge, Transmission or ruTorrent), into a folder chosen by the user's rules.

**Permission justifications**:

| Permission | Justification |
|---|---|
| storage | Saves the user's client addresses, logins, folders and rules on their computer. |
| contextMenus | Adds "SNATCHER → Send to <folder>" to the right-click menu on links. |
| notifications | Shows whether a batch of torrents was sent or failed. |
| scripting | Runs SNATCHER's link-finding script on the sites the user has allowed, and on the current tab when they click the toolbar icon. |
| activeTab | Lets the user run SNATCHER once on the current page by clicking its icon, without giving it access to that site permanently. |
| webRequest, webRequestAuthProvider | Answers the HTTP login (Basic/Digest) of the user's own torrent client web UI with the username and password they saved, for requests to that client's address only. |
| declarativeNetRequestWithHostAccess | qBittorrent rejects requests whose Origin isn't its own address. A session rule sets the Origin/Referer of SNATCHER's own requests to the user's qBittorrent address only. Pages the user visits are not affected. |
| Host permissions (optional) | Requested per site at runtime. The user grants each torrent client's address, and each site SNATCHER should run on, or every site if they choose. It's needed to log in to the user's client, and to download a .torrent file with the user's existing login for that site. |

**Remote code**: No, I am not using remote code.

**Data usage**: tick **Authentication information** (the user's own torrent-client login, stored locally and only sent to that client) and **Website content** (torrent links and their names read from pages the user allows). Then tick all three certifications:
- not sold to third parties
- not used for purposes unrelated to the single purpose
- not used for creditworthiness or lending

**Privacy policy URL**: https://github.com/M7URT/snatcher/blob/main/PRIVACY.md

---

## Distribution

Public, all regions. Free.

## Test instructions (for the reviewer)

```
SNATCHER needs a torrent client with a web interface. The quickest way to test:
1. Install qBittorrent (qbittorrent.org). In Tools → Options → Web UI, tick "Web User Interface", keep port 8080, and set a username and password.
2. In SNATCHER's settings, Add client → App: qBittorrent, address http://127.0.0.1:8080, with that username and password. Click Test connection and allow access when the browser asks.
3. Go to https://ubuntu.com/download/alternative-downloads and click the SNATCHER toolbar icon. The panel lists the .torrent links. Tick one and press Snatch. It appears in qBittorrent.
```
