"""Serve the site locally with HTTP Range support.

Python's built-in http.server ignores Range headers, and sql.js-httpvfs cannot work
without them, so this wraps the stock handler with a minimal single-range
implementation. Standard library only.

Usage: python scripts/serve.py            # serves site/ on http://127.0.0.1:8787
"""

import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site")
PORT = 8787
RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


class RangeHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        self.range = None
        header = self.headers.get("Range")
        if header:
            m = RANGE_RE.match(header)
            if m and (m.group(1) or m.group(2)):
                self.range = (int(m.group(1)) if m.group(1) else None,
                              int(m.group(2)) if m.group(2) else None)
        if not self.range:
            return super().send_head()

        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            self.send_error(404)
            return None
        size = os.path.getsize(path)
        start, end = self.range
        if start is None:            # suffix range: last N bytes
            start = max(0, size - (end or 0))
            end = size - 1
        else:
            end = size - 1 if end is None else min(end, size - 1)
        if start >= size or start > end:
            self.send_error(416)
            return None

        fh = open(path, "rb")
        fh.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", "bytes {}-{}/{}".format(start, end, size))
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._range_length = end - start + 1
        return fh

    def copyfile(self, source, outputfile):
        length = getattr(self, "_range_length", None)
        if length is None:
            return super().copyfile(source, outputfile)
        remaining = length
        while remaining > 0:
            block = source.read(min(65536, remaining))
            if not block:
                break
            outputfile.write(block)
            remaining -= len(block)
        self._range_length = None

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        # Advertised on every response: sql.js-httpvfs checks the plain-GET response for
        # it and falls back to whole-file reads when it is missing.
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()


def main():
    os.chdir(ROOT)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), RangeHandler)
    print("serving {} on http://127.0.0.1:{}".format(ROOT, PORT))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
