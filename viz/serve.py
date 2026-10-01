#!/usr/bin/env python3
"""Serve the PhysiCell repository so the viewer can read output/ over HTTP.

    python3 viz/serve.py            # serve on http://localhost:8000/viz/
    python3 viz/serve.py -p 9000    # a different port
    python3 viz/serve.py -d run3    # serve a different output directory as /output/

Browsers refuse ES modules and fetch() from file:// URLs, so the viewer needs a
static file server. This is that server and nothing more: no dependencies, no
write access, bound to localhost.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import os
import socketserver
import sys
import threading
import webbrowser
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static handler with a JSON directory index, /run/ mount, and no caching."""

    mount = None  # extra directory exposed at /run/

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.mat': 'application/octet-stream',
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
    }

    def translate_path(self, path):
        if self.mount is not None:
            head = path.split('?', 1)[0].split('#', 1)[0]
            if head == '/run' or head.startswith('/run/'):
                remainder = head[len('/run'):].lstrip('/')
                # Reuse the base implementation's sanitising, then re-root it.
                safe = super().translate_path('/' + remainder)
                relative = os.path.relpath(safe, os.getcwd())
                if relative.startswith('..'):
                    return safe
                return os.path.join(str(self.mount), relative)
        return super().translate_path(path)

    def end_headers(self):
        # Simulations get re-run constantly; never serve a stale frame.
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        if self.path.rstrip('/').endswith('/index.json'):
            directory = Path(self.translate_path(self.path)).parent
            if directory.is_dir():
                names = sorted(p.name for p in directory.iterdir() if p.is_file())
                body = ('[' + ','.join(f'"{n}"' for n in names) + ']').encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
        super().do_GET()

    def log_message(self, fmt, *args):
        if '"GET' in (fmt % args) and ' 200 ' in (fmt % args):
            return  # keep the console readable while frames stream in
        sys.stderr.write('%s\n' % (fmt % args))


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('-p', '--port', type=int, default=8000)
    parser.add_argument('-d', '--output', default=None,
                        help='an output directory anywhere on disk; served at /run/ '
                             'and opened by default instead of the repo output/')
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()

    root = REPO_ROOT
    query = ''
    if args.output:
        chosen = Path(args.output).resolve()
        if not chosen.is_dir():
            print(f'no such directory: {chosen}', file=sys.stderr)
            return 1
        Handler.mount = chosen
        query = '?dir=/run/'

    os.chdir(root)
    handler = functools.partial(Handler, directory=str(root))
    with Server(('127.0.0.1', args.port), handler) as httpd:
        url = f'http://localhost:{args.port}/viz/{query}'
        print(f'PhysiCell viewer:  {url}')
        print(f'serving           {root}')
        if Handler.mount:
            print(f'/run/             {Handler.mount}')
        print('Ctrl-C to stop.')
        if not args.no_browser:
            threading.Timer(0.4, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
