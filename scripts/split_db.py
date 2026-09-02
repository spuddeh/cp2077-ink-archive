"""Split a SQLite database into fixed-size parts for static range-request hosting.

GitHub rejects files over 100 MB and sql.js-httpvfs reassembles split files
transparently, so the website database ships as 50 MB parts plus a config.json the
library reads. requestChunkSize must equal the database page size (build.py sets 4096).

The parts live in a folder named by the database's content hash, and config.json points
at it. A browser keeps range responses in its cache under the part's URL; parts of two
different builds under one URL would be stitched into one database and read as
"database disk image is malformed". A new build is a new folder, and a rebuild of the
same content keeps its cache.

Usage: python scripts/split_db.py data/ink_web.db site/data
"""

import hashlib
import json
import os
import shutil
import sys

PART_SIZE = 50_000_000
REQUEST_CHUNK = 4096
SUFFIX_LENGTH = 3
PREFIX = "ink.db."


def content_hash(db_path):
    h = hashlib.sha256()
    with open(db_path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 22), b""):
            h.update(block)
    return h.hexdigest()[:16]


def split(db_path, out_dir):
    total = os.path.getsize(db_path)
    stamp = content_hash(db_path)
    os.makedirs(out_dir, exist_ok=True)
    for old in os.listdir(out_dir):
        full = os.path.join(out_dir, old)
        if old.startswith(PREFIX) or old == "config.json":
            os.remove(full)
        elif os.path.isdir(full) and old != stamp:
            shutil.rmtree(full)
    part_dir = os.path.join(out_dir, stamp)
    os.makedirs(part_dir, exist_ok=True)

    parts = 0
    with open(db_path, "rb") as src:
        while True:
            chunk = src.read(PART_SIZE)
            if not chunk:
                break
            name = "{}{:0{}d}".format(PREFIX, parts, SUFFIX_LENGTH)
            with open(os.path.join(part_dir, name), "wb") as dst:
                dst.write(chunk)
            parts += 1

    config = {
        "serverMode": "chunked",
        "requestChunkSize": REQUEST_CHUNK,
        "databaseLengthBytes": total,
        "serverChunkSize": PART_SIZE,
        "urlPrefix": stamp + "/" + PREFIX,   # resolved against config.json's own URL
        "suffixLength": SUFFIX_LENGTH,
    }
    with open(os.path.join(out_dir, "config.json"), "w", encoding="utf-8") as fh:
        json.dump(config, fh, indent=1)
    print("{} -> {} parts, {:.1f} MB, in {}/{}, config written to {}".format(
        db_path, parts, total / 1048576, out_dir, stamp, out_dir))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    split(sys.argv[1], sys.argv[2])
