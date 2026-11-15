"""Fake Deluge, qBittorrent and Transmission web APIs for testing SNATCHER, all on one port.

Run:   python test/mock_clients.py            (port 8095)

  Deluge        http://127.0.0.1:8095/deluge        Web UI password: deluge
  qBittorrent   http://127.0.0.1:8095/qbit          admin / adminadmin
  Transmission  http://127.0.0.1:8095/tr            no login

Also serves the SNATCHER folder itself at /src/… (used by test/clients-test.html) and a sample
torrent at /sample.torrent. Torrents "added" are only remembered in memory.
"""
import base64, hashlib, json, os, re, secrets, sys, urllib.parse
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8095
LOG = []


def info_hash(data: bytes) -> str:
    """SHA-1 of the bencoded info dict, upper-case hex ('' if not a torrent)."""
    i = 0

    def skip():
        nonlocal i
        c = data[i:i + 1]
        if c == b'i':
            i = data.index(b'e', i) + 1
        elif c in (b'l', b'd'):
            i += 1
            while data[i:i + 1] != b'e':
                skip()
            i += 1
        else:
            colon = data.index(b':', i)
            i = colon + 1 + int(data[i:colon])
    try:
        if data[:1] != b'd':
            return ''
        i = 1
        while data[i:i + 1] != b'e':
            k0 = i; skip(); key = data[k0:i]
            v0 = i; skip()
            if key == b'4:info':
                return hashlib.sha1(data[v0:i]).hexdigest().upper()
    except Exception:
        pass
    return ''


def bencode(x):
    if isinstance(x, int):
        return b'i%de' % x
    if isinstance(x, str):
        x = x.encode()
    if isinstance(x, bytes):
        return b'%d:%s' % (len(x), x)
    if isinstance(x, list):
        return b'l' + b''.join(bencode(v) for v in x) + b'e'
    return b'd' + b''.join(bencode(k) + bencode(x[k]) for k in sorted(x)) + b'e'


def sample_torrent(name):
    return bencode({'announce': 'http://tracker.invalid/announce', 'info': {
        'name': name, 'piece length': 16384, 'pieces': hashlib.sha1(name.encode()).digest(), 'length': 1234}})


# In-memory torrents per app: hash -> {name, dir, label, paused}
STATE = {'deluge': {}, 'qbit': {}, 'tr': {}}
DELUGE_SESSIONS, QB_SESSIONS = set(), set()
DELUGE_CONNECTED = {'v': False}
TR_SESSION = secrets.token_hex(8)


def magnet_hash(uri):
    m = re.search(r'xt=urn:btih:([0-9a-fA-F]{40})', uri)
    return m.group(1).upper() if m else ''


def magnet_name(uri):
    q = urllib.parse.parse_qs(uri.split('?', 1)[-1])
    return (q.get('dn') or ['magnet'])[0]


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body=b'', ctype='text/plain', headers=None):
        if isinstance(body, (dict, list)):
            body, ctype = json.dumps(body).encode(), 'application/json'
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def cookies(self):
        out = {}
        for part in (self.headers.get('Cookie') or '').split(';'):
            if '=' in part:
                k, v = part.strip().split('=', 1)
                out[k] = v
        return out

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return self.rfile.read(n) if n else b''

    def multipart(self, raw):
        msg = BytesParser(policy=email_policy).parsebytes(
            b'Content-Type: ' + self.headers['Content-Type'].encode() + b'\r\n\r\n' + raw)
        fields = {}
        for part in msg.iter_parts():
            name = part.get_param('name', header='content-disposition')
            fields.setdefault(name, []).append(part.get_payload(decode=True))
        return fields

    # ---------- GET ----------
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == '/sample.torrent' or re.match(r'^/sample-\w+\.torrent$', path):
            name = 'Sample.Show.S01E01.1080p' if path == '/sample.torrent' else path[8:-8]
            return self.send(200, sample_torrent(name), 'application/x-bittorrent')
        if path == '/log':
            return self.send(200, LOG)
        if path == '/state':
            return self.send(200, STATE)
        if path.startswith('/src/'):
            f = os.path.normpath(os.path.join(ROOT, path[5:]))
            if not f.startswith(ROOT) or not os.path.isfile(f):
                return self.send(404, 'not found')
            ctype = 'text/html' if f.endswith('.html') else 'text/javascript' if f.endswith('.js') else 'application/octet-stream'
            return self.send(200, open(f, 'rb').read(), ctype + '; charset=utf-8')
        if path.startswith('/qbit/api/v2/'):
            return self.qbit(path[len('/qbit/api/v2/'):], b'')
        self.send(404, 'not found')

    # ---------- POST ----------
    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        raw = self.body()
        if path == '/report':
            LOG.append(json.loads(raw or b'null'))
            print('REPORT', raw.decode()[:2000], flush=True)
            return self.send(200, 'ok')
        if path == '/deluge/json':
            return self.deluge(json.loads(raw))
        if path.startswith('/qbit/api/v2/'):
            return self.qbit(path[len('/qbit/api/v2/'):], raw)
        if path == '/tr/transmission/rpc':
            return self.transmission(raw)
        self.send(404, 'not found')

    # ---------- Deluge ----------
    def deluge(self, req):
        m, p, rid = req.get('method'), req.get('params') or [], req.get('id')
        ok = lambda r: self.send(200, {'result': r, 'error': None, 'id': rid})
        err = lambda msg, code=2: self.send(200, {'result': None, 'error': {'message': msg, 'code': code}, 'id': rid})
        if m == 'auth.login':
            if p and p[0] == 'deluge':
                sid = secrets.token_hex(8)
                DELUGE_SESSIONS.add(sid)
                return self.send(200, {'result': True, 'error': None, 'id': rid}, headers={'Set-Cookie': f'_session_id={sid}; Path=/deluge/json'})
            return ok(False)
        if self.cookies().get('_session_id') not in DELUGE_SESSIONS:
            return err('Not authenticated', 1)
        if m == 'web.connected':
            return ok(DELUGE_CONNECTED['v'])
        if m == 'web.get_hosts':
            return ok([['host1', '127.0.0.1', 58846, 'Online']])
        if m == 'web.connect':
            DELUGE_CONNECTED['v'] = True
            return ok([])
        if not DELUGE_CONNECTED['v']:
            return err('Not connected to a daemon')
        if m == 'daemon.get_version':
            return ok('2.1.1-mock')
        if m in ('core.add_torrent_file', 'core.add_torrent_magnet', 'core.add_torrent_url'):
            if m == 'core.add_torrent_file':
                data = base64.b64decode(p[1]); h = info_hash(data)
                name = re.search(rb'4:name(\d+):', data)
                name = data[name.end():name.end() + int(name.group(1))].decode() if name else p[0]
            else:
                h, name = magnet_hash(p[0]) or hashlib.sha1(p[0].encode()).hexdigest().upper(), magnet_name(p[0])
            opts = p[-1] if p and isinstance(p[-1], dict) else {}
            if h in STATE['deluge']:
                return err('Torrent already in session (%s).' % h.lower())
            STATE['deluge'][h] = {'name': name, 'dir': opts.get('download_location'), 'paused': opts.get('add_paused'), 'label': ''}
            return ok(h.lower())
        if m == 'core.get_torrents_status':
            return ok({h.lower(): {'name': t['name']} for h, t in STATE['deluge'].items()})
        if m == 'label.add':
            return ok(None)
        if m == 'label.set_torrent':
            STATE['deluge'][p[0].upper()]['label'] = p[1]
            return ok(None)
        return err('Unknown method ' + str(m))

    # ---------- qBittorrent ----------
    def qbit(self, path, raw):
        origin = self.headers.get('Origin')
        if origin and urllib.parse.urlparse(origin).netloc != self.headers.get('Host'):
            return self.send(401, 'Unauthorized')  # qBittorrent's CSRF protection
        if path == 'auth/login':
            f = urllib.parse.parse_qs(raw.decode())
            if f.get('username') == ['admin'] and f.get('password') == ['adminadmin']:
                sid = secrets.token_hex(8)
                QB_SESSIONS.add(sid)
                return self.send(200, 'Ok.', headers={'Set-Cookie': f'SID={sid}; HttpOnly; path=/'})
            return self.send(200, 'Fails.')
        if self.cookies().get('SID') not in QB_SESSIONS:
            return self.send(403, 'Forbidden')
        if path == 'app/version':
            return self.send(200, 'v5.0.0-mock')
        if path == 'torrents/info':
            return self.send(200, [{'hash': h.lower(), 'name': t['name']} for h, t in STATE['qbit'].items()])
        if path == 'torrents/add':
            f = self.multipart(raw)
            items = []
            for data in f.get('torrents', []):
                name = re.search(rb'4:name(\d+):', data)
                items.append((info_hash(data), data[name.end():name.end() + int(name.group(1))].decode() if name else '?'))
            for u in (f.get('urls') or [b''])[0].decode().split('\n'):
                if u.strip():
                    items.append((magnet_hash(u) or hashlib.sha1(u.encode()).hexdigest().upper(), magnet_name(u)))
            if not items:
                return self.send(415, 'Torrent file is not valid')
            val = lambda k: (f.get(k) or [b''])[0].decode()
            new = 0
            for h, name in items:
                if h not in STATE['qbit']:
                    STATE['qbit'][h] = {'name': name, 'dir': val('savepath'), 'label': val('category'), 'paused': val('stopped') or val('paused')}
                    new += 1
            # Answer like qBittorrent 5.x (checked against a real 5.3.0): JSON counts, 409 when nothing was new
            if not new:
                return self.send(409, 'Conflict')
            return self.send(200, {'added_torrent_ids': [], 'failure_count': len(items) - new, 'pending_count': 0, 'success_count': new})
        return self.send(404, 'Not Found')

    # ---------- Transmission ----------
    def transmission(self, raw):
        if self.headers.get('X-Transmission-Session-Id') != TR_SESSION:
            return self.send(409, '<h1>409: Conflict</h1>', 'text/html', {'X-Transmission-Session-Id': TR_SESSION})
        req = json.loads(raw)
        m, a = req.get('method'), req.get('arguments') or {}
        if m == 'session-get':
            return self.send(200, {'result': 'success', 'arguments': {'version': '4.0.6-mock'}})
        if m == 'torrent-get':
            return self.send(200, {'result': 'success', 'arguments': {'torrents': [{'hashString': h.lower(), 'name': t['name']} for h, t in STATE['tr'].items()]}})
        if m == 'torrent-add':
            if 'metainfo' in a:
                data = base64.b64decode(a['metainfo']); h = info_hash(data)
                name = re.search(rb'4:name(\d+):', data)
                name = data[name.end():name.end() + int(name.group(1))].decode() if name else '?'
            else:
                h, name = magnet_hash(a.get('filename', '')) or hashlib.sha1(a.get('filename', '').encode()).hexdigest().upper(), magnet_name(a.get('filename', ''))
            if h in STATE['tr']:
                return self.send(200, {'result': 'success', 'arguments': {'torrent-duplicate': {'hashString': h.lower(), 'name': name}}})
            STATE['tr'][h] = {'name': name, 'dir': a.get('download-dir'), 'label': (a.get('labels') or [''])[0], 'paused': a.get('paused')}
            return self.send(200, {'result': 'success', 'arguments': {'torrent-added': {'hashString': h.lower(), 'name': name}}})
        return self.send(200, {'result': 'method name not recognized'})


if __name__ == '__main__':
    print(f'Mock Deluge / qBittorrent / Transmission on http://127.0.0.1:{PORT}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
