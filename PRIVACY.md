# SNATCHER privacy policy

*Last updated: 15 November 2026*

SNATCHER is a browser extension that sends torrent and magnet links to a torrent client you run yourself: qBittorrent, Deluge, Transmission or ruTorrent, at home or on a seedbox. It has no servers of its own, and its developer never receives any of your data.

## What SNATCHER stores

Everything below is kept in your browser's extension storage, on your own computer:

- **Your client settings:** each client's name, web address, username and password, base folder and options. The password is needed to log in to the client's web interface on your behalf.
- **Folders and rules:** your destinations, the rules that pick a folder, the folders you chose by hand for a site's categories, and the list of sites you've allowed SNATCHER to run on.
- **A send history:** the name and link of each torrent you've sent (the last 3,000), with the time and folder. The panel uses it to mark torrents as "Sent before". Links from private trackers can include your personal passkey, so this history stays on your computer like everything else.
- **A connection log:** the login steps SNATCHER made with your clients, for troubleshooting. It never contains passwords.

None of this is sent to the developer or anyone else. Uninstalling SNATCHER deletes it all.

## What SNATCHER sends, and where

SNATCHER only makes network requests when you send something, open its panel, or test a connection:

- **To your own torrent clients**, at the addresses you entered: your login, the torrent (the .torrent file or magnet link), the folder and label you picked, and requests for the list of torrents already there, used to skip duplicates.
- **To the site a torrent link points to**, to download the .torrent file the same way your browser would, including your login cookies for that site. Nothing else is sent to it.

SNATCHER has no analytics, tracking, ads or third-party services. It doesn't load any code from the internet.

## What SNATCHER reads on web pages

On sites you've allowed, and on a page where you click SNATCHER's icon, it reads the links on the page, and the text around torrent links (name, category, size, seeders). It uses this to list the torrents and pick a folder. This stays in your browser and isn't stored, except for the send history above.

## Exports

**Export settings** saves your settings to a file you choose, including client passwords in plain text. Keep that file somewhere safe.

## Contact

Questions or problems: <https://github.com/M7URT/snatcher/issues>
