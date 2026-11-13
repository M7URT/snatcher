"""Tiny fake ruTorrent for testing SNATCHER without touching your real seedbox.

Run:   python test/mock_rutorrent.py            (Digest login, like dediseedbox)
       python test/mock_rutorrent.py --basic    (Basic login, like many other seedboxes)
Then in SNATCHER settings click "+ Add test server" (http://127.0.0.1:8090, path /rutorrent,
user "test", password "snatcher-test") and press "Test connection".

Every add is printed here (folder, label, file or URL), and uploaded .torrent files are saved
to test/received/. Nothing is downloaded or seeded.
"""
import base64
import hashlib
import secrets
import json
import os
import sys
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("MOCK_PORT", "8090"))
USER, PASSWORD = "test", "snatcher-test"
BASE = "/rutorrent"
MODE = "basic" if "--basic" in sys.argv else "digest"
REALM = "ruTorrent"
NONCES = set()


def md5(s):
    return hashlib.md5(s.encode()).hexdigest()


def parse_auth(h):
    import re
    return {m[0].lower(): (m[1] if m[1] else m[2]) for m in re.findall(r'(\w+)=(?:"([^"]*)"|([^,\s]*))', h)}
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "received")


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body=b"", ctype="application/json", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # CORS only matters for browser-page tests; the extension itself doesn't need it.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Expose-Headers", "WWW-Authenticate")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _authed(self):
        got = self.headers.get("Authorization") or ""
        if MODE == "basic":
            if got == "Basic " + base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode():
                return True
            challenge = f'Basic realm="{REALM}"'
        else:
            if got.startswith("Digest "):
                a = parse_auth(got[7:])
                ha1 = md5(f"{USER}:{REALM}:{PASSWORD}")
                ha2 = md5(f"{self.command}:{a.get('uri', '')}")
                if a.get("qop"):
                    want = md5(f"{ha1}:{a.get('nonce')}:{a.get('nc')}:{a.get('cnonce')}:{a.get('qop')}:{ha2}")
                else:
                    want = md5(f"{ha1}:{a.get('nonce')}:{ha2}")
                if a.get("username") == USER and a.get("nonce") in NONCES and a.get("response") == want                         and a.get("uri") == self.path:
                    return True
            nonce = secrets.token_hex(16)
            NONCES.add(nonce)
            challenge = f'Digest realm="{REALM}", nonce="{nonce}", algorithm=MD5, qop="auth"'
        self._send(401, b"Unauthorized", "text/plain", {"WWW-Authenticate": challenge})
        print(f"  401 ({MODE}) {'wrong login' if got else 'challenge sent'} for {self.path}")
        sys.stdout.flush()
        return False

    def do_OPTIONS(self):
        self._send(204)

    def do_GET(self):
        path = urlparse(self.path).path
        if not path.startswith(BASE):
            return self._send(404, b"not found", "text/plain")
        if not self._authed():
            return
        if path == BASE + "/php/getsettings.php":
            return self._send(200, b'{"webui.lang":"en"}')
        if path in (BASE, BASE + "/"):
            return self._send(200, b"<html><title>ruTorrent (mock)</title></html>", "text/html")
        self._send(404, b"not found", "text/plain")

    def do_POST(self):
        path = urlparse(self.path).path
        if path != BASE + "/php/addtorrent.php":
            return self._send(404, b"not found", "text/plain")
        if not self._authed():
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        fields, file_name, file_bytes = {}, None, None
        ctype = self.headers.get("Content-Type", "")
        if ctype.startswith("multipart/form-data"):
            msg = BytesParser(policy=email_policy).parsebytes(
                b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + raw)
            for part in msg.iter_parts():
                name = part.get_param("name", header="content-disposition")
                if part.get_filename():
                    file_name, file_bytes = part.get_filename(), part.get_payload(decode=True)
                else:
                    fields[name] = part.get_content().strip()
        else:
            fields = {k: v[0] for k, v in parse_qs(raw.decode()).items()}

        ok = bool(file_bytes and file_bytes[:1] == b"d") or bool(fields.get("url"))
        print("\n=== add torrent " + ("OK" if ok else "FAILED"))
        print(f"  folder (dir_edit): {fields.get('dir_edit', '(ruTorrent default)')}")
        print(f"  label:             {fields.get('label', '(none)')}")
        print(f"  paused:            {'yes' if fields.get('torrents_start_stopped') else 'no'}")
        print(f"  no subfolder:      {'yes' if fields.get('not_add_path') else 'no'}")
        if file_bytes:
            os.makedirs(OUT, exist_ok=True)
            safe = "".join(ch if ch.isalnum() or ch in "._- " else "_" for ch in file_name)[:150]
            with open(os.path.join(OUT, safe), "wb") as fh:
                fh.write(file_bytes)
            print(f"  file:              {file_name} ({len(file_bytes)} bytes) -> test/received/")
        if fields.get("url"):
            print(f"  url:               {fields['url'][:120]}")
        sys.stdout.flush()
        self._send(200, json.dumps({"result": "Success" if ok else "Failed"}).encode())

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"Mock ruTorrent on http://127.0.0.1:{PORT}{BASE}/  ({MODE} login: user '{USER}', password '{PASSWORD}')")
    print("Ctrl+C to stop.")
    sys.stdout.flush()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
