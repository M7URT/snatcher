"""Build the zip to upload to the Chrome Web Store / Edge Add-ons.

    python build.py        ->  dist/snatcher-<version>.zip

Only the extension's own files go in (an allow-list), so tests, store images, settings exports
and anything else in the folder can never end up in the package.
"""
import json, os, re, sys, zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
FILES = ['manifest.json', 'background.js', 'content.js', 'panel.js', 'grant.html', 'grant.js',
         'options.html', 'options.js', 'options.css', 'popup.html', 'popup.js', 'popup.css']
DIRS = ['lib', 'icons']


def main():
    manifest = json.load(open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8'))
    version = manifest['version']
    out = os.path.join(ROOT, 'dist', f'snatcher-{version}.zip')
    os.makedirs(os.path.dirname(out), exist_ok=True)

    paths = list(FILES)
    for d in DIRS:
        for base, _, names in os.walk(os.path.join(ROOT, d)):
            paths += [os.path.relpath(os.path.join(base, n), ROOT).replace('\\', '/') for n in sorted(names)]

    # Every file the manifest and pages point at must be in the package.
    refs = set(manifest['icons'].values()) | set(manifest['action']['default_icon'].values())
    refs |= {manifest['background']['service_worker'], manifest['options_page']}
    for page in ('options.html', 'popup.html', 'grant.html'):
        html = open(os.path.join(ROOT, page), encoding='utf-8').read()
        refs |= set(re.findall(r'(?:src|href)="([^":#?]+\.(?:js|css))"', html))
    refs |= set(re.findall(r"'(lib/[\w.]+\.js)'", open(os.path.join(ROOT, 'background.js'), encoding='utf-8').read()))
    missing = sorted(r for r in refs if r not in paths)
    if missing:
        sys.exit('missing from the package: ' + ', '.join(missing))

    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for p in paths:
            z.write(os.path.join(ROOT, p), p)
    print(f'{out}  ({len(paths)} files, {os.path.getsize(out) // 1024} KB)')


if __name__ == '__main__':
    main()
