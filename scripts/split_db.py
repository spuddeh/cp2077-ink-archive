"""Split a SQLite database into fixed-size parts for static range-request hosting.

GitHub rejects files over 100 MB and sql.js-httpvfs reassembles split files
transparently, so the website database ships as 50 MB parts plus a config.json the
library reads. requestChunkSize must equal the database page size (build.py sets 4096).

Usage: python scripts/split_db.py data/ink_web.db site/data
"""

import json
import os
import sys

PART_SIZE = 50_000_000
REQUEST_CHUNK = 4096
SUFFIX_LENGTH = 3
PREFIX = "ink.db."


def split(db_path, out_dir):
    total = os.path.getsize(db_path)
    os.makedirs(out_dir, exist_ok=True)
    for old in os.listdir(out_dir):
        if old.startswith(PREFIX) or old == "config.json":
            os.remove(os.path.join(out_dir, old))

    parts = 0
    with open(db_path, "rb") as src:
        while True:
            chunk = src.read(PART_SIZE)
            if not chunk:
                break
            name = "{}{:0{}d}".format(PREFIX, parts, SUFFIX_LENGTH)
            with open(os.path.join(out_dir, name), "wb") as dst:
                dst.write(chunk)
            parts += 1

    config = {
        "serverMode": "chunked",
        "requestChunkSize": REQUEST_CHUNK,
        "databaseLengthBytes": total,
        "serverChunkSize": PART_SIZE,
        "urlPrefix": PREFIX,
        "suffixLength": SUFFIX_LENGTH,
    }
    with open(os.path.join(out_dir, "config.json"), "w", encoding="utf-8") as fh:
        json.dump(config, fh, indent=1)
    print("{} -> {} parts, {:.1f} MB, config written to {}".format(
        db_path, parts, total / 1048576, out_dir))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    split(sys.argv[1], sys.argv[2])
