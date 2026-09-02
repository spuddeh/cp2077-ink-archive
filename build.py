"""Build data/ink.db from the JSONL that generate.wscript produced.

The archive holds every chunk of every ink resource, so the database is built around
chunks, not around any chosen view. `chunks.data` and `files.data` are complete records
with class defaults restored: a field absent from a row means the resource does not have
that field, never that the build dropped it.

Two derived tables are conveniences over the same data, not other versions of it:
`widgets` lifts the layout fields of every chunk that has an inkWidgetLayout into
columns, and `widget_tree` resolves the children -> inkMultiChildren -> children hop so
a tree query does not have to. `refs` is the full reference graph.

Standard library only. Python 3.9 or newer.
"""

import argparse
import json
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(ROOT, "raw")
DATA = os.path.join(ROOT, "data")

# sql.js-httpvfs fetches whole pages over HTTP range requests, so a page larger than its
# request chunk makes every read pull more than it needs.
PAGE_SIZE = 4096

SCHEMA = """
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;

CREATE TABLE files (
    fid         INTEGER PRIMARY KEY,
    path        TEXT NOT NULL UNIQUE,
    kind        TEXT NOT NULL,
    source      TEXT NOT NULL,
    class       TEXT,
    chunk_count INTEGER NOT NULL,
    data        TEXT NOT NULL
);

CREATE TABLE chunks (
    cid       INTEGER PRIMARY KEY,
    fid       INTEGER NOT NULL,
    chunk_id  TEXT NOT NULL,
    class     TEXT NOT NULL,
    name      TEXT,
    data      TEXT NOT NULL
);

CREATE TABLE refs (
    from_cid  INTEGER NOT NULL,   -- 0 means the file's root record
    fid       INTEGER NOT NULL,
    to_cid    INTEGER NOT NULL,
    field     TEXT NOT NULL,
    ord       INTEGER NOT NULL
);

CREATE TABLE items (
    fid             INTEGER NOT NULL,
    name            TEXT NOT NULL,
    instance_cid    INTEGER,   -- NULL when the instance sits inline in files.data
    root_widget_cid INTEGER,   -- the chunk holding the item's widget tree
    controller_cid  INTEGER,
    controller      TEXT,
    PRIMARY KEY (fid, name)
);

CREATE TABLE widgets (
    cid         INTEGER PRIMARY KEY,
    fid         INTEGER NOT NULL,
    class       TEXT NOT NULL,
    name        TEXT NOT NULL,
    anchor      TEXT, anchor_x REAL, anchor_y REAL,
    halign      TEXT, valign TEXT,
    margin_l    REAL, margin_t REAL, margin_r REAL, margin_b REAL,
    pad_l       REAL, pad_t REAL, pad_r REAL, pad_b REAL,
    size_rule   TEXT, size_coef REAL,
    size_x      REAL, size_y REAL,
    fit         INTEGER, visible INTEGER, interactive INTEGER, opacity REAL,
    tr_x        REAL, tr_y REAL, scale_x REAL, scale_y REAL, rotation REAL,
    text        TEXT, loc_text TEXT, lockey TEXT, text_id TEXT,
    font_size   INTEGER, font_family TEXT,
    atlas       TEXT, part TEXT, style TEXT, state TEXT
);

CREATE TABLE widget_tree (
    parent_cid INTEGER NOT NULL,
    child_cid  INTEGER NOT NULL,
    ord        INTEGER NOT NULL
);

CREATE TABLE defaults (
    class TEXT NOT NULL,
    prop  TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (class, prop)
);

CREATE TABLE schema (
    class   TEXT NOT NULL,
    prop    TEXT NOT NULL,
    type    TEXT,
    storage TEXT,
    varies  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (class, prop)
);

CREATE TABLE classes (
    class TEXT PRIMARY KEY,
    count INTEGER NOT NULL
);
"""

INDEXES = """
CREATE INDEX idx_chunks_class     ON chunks(class);
CREATE INDEX idx_chunks_fid       ON chunks(fid);
CREATE INDEX idx_chunks_name      ON chunks(name);
CREATE UNIQUE INDEX idx_chunks_k  ON chunks(fid, chunk_id);
CREATE INDEX idx_refs_from        ON refs(from_cid);
CREATE INDEX idx_refs_to          ON refs(to_cid);
CREATE INDEX idx_items_ctrl       ON items(controller);
CREATE INDEX idx_w_anchor         ON widgets(anchor);
CREATE INDEX idx_w_class          ON widgets(class);
CREATE INDEX idx_w_name           ON widgets(name);
CREATE INDEX idx_w_fid            ON widgets(fid);
CREATE INDEX idx_w_atlas          ON widgets(atlas);
CREATE INDEX idx_w_lockey         ON widgets(lockey);
CREATE INDEX idx_tree_parent      ON widget_tree(parent_cid);
CREATE INDEX idx_tree_child       ON widget_tree(child_cid);

-- Convenience views so a query can use the file path without writing the join.
CREATE VIEW chunks_v  AS SELECT c.*, f.path, f.kind, f.source FROM chunks c JOIN files f USING (fid);
CREATE VIEW widgets_v AS SELECT w.*, f.path, f.source FROM widgets w JOIN files f USING (fid);
CREATE VIEW items_v   AS SELECT i.*, f.path, f.source FROM items i JOIN files f USING (fid);
"""

WIDGET_COLS = (
    "cid fid class name anchor anchor_x anchor_y halign valign "
    "margin_l margin_t margin_r margin_b pad_l pad_t pad_r pad_b size_rule size_coef "
    "size_x size_y fit visible interactive opacity tr_x tr_y scale_x scale_y rotation "
    "text loc_text lockey text_id font_size font_family atlas part style state"
).split()
INSERT_WIDGET = "INSERT INTO widgets ({}) VALUES ({})".format(
    ", ".join(WIDGET_COLS), ", ".join("?" * len(WIDGET_COLS)))


def strip(node, defaults):
    """The inverse of restore(), used to prove restore() against the shipped bytes."""
    if isinstance(node, list):
        return [strip(v, defaults) for v in node]
    if not isinstance(node, dict):
        return node
    cls = node.get("$type")
    d = defaults.get(cls, {}) if isinstance(cls, str) else {}
    out = {}
    for k, v in node.items():
        if k != "$type" and k in d and v == d[k]:
            continue
        out[k] = strip(v, defaults)
    return out


def restore(node, defaults):
    """Put back the fields generate.wscript omitted because they equalled the default."""
    if isinstance(node, list):
        return [restore(v, defaults) for v in node]
    if not isinstance(node, dict):
        return node
    out = {k: restore(v, defaults) for k, v in node.items()}
    cls = node.get("$type")
    if isinstance(cls, str):
        for k, v in defaults.get(cls, {}).items():
            if k not in out:
                out[k] = v
    return out


def ref_of(v):
    if isinstance(v, dict) and "$ref" in v and len(v) == 1:
        return v["$ref"]
    return None


def iter_refs(node, field="", out=None):
    """Every $ref under node, with the JSON key that holds it and its array position."""
    if out is None:
        out = []
    if isinstance(node, list):
        for i, v in enumerate(node):
            r = ref_of(v)
            if r is not None:
                out.append((r, field, i))
            else:
                iter_refs(v, field, out)
    elif isinstance(node, dict):
        for k, v in node.items():
            r = ref_of(v)
            if r is not None:
                out.append((r, k, 0))
            else:
                iter_refs(v, k, out)
    return out


def xy(v):
    if isinstance(v, dict):
        return v.get("X"), v.get("Y")
    return None, None


def lrtb(v):
    if isinstance(v, dict):
        return v.get("left"), v.get("top"), v.get("right"), v.get("bottom")
    return None, None, None, None


def depot(v):
    if isinstance(v, dict):
        p = v.get("DepotPath")
        if isinstance(p, dict):
            p = p.get("$v", p.get("$value"))
        return p if isinstance(p, str) else None
    return v if isinstance(v, str) else None


def scalar(v):
    """A plain value, or the value inside an inline-tagged one, or None for 'None'."""
    if isinstance(v, dict):
        v = v.get("$v", v.get("$value"))
    if v == "None":
        return None
    return v


def widget_row(cid, chunk, fid, resolve):
    layout = chunk.get("layout") or {}
    ax, ay = xy(layout.get("anchorPoint"))
    ml, mt, mr, mb = lrtb(layout.get("margin"))
    pl, pt, pr, pb = lrtb(layout.get("padding"))
    sx, sy = xy(chunk.get("size"))
    rt = chunk.get("renderTransform") or {}
    tx, ty = xy(rt.get("translation"))
    kx, ky = xy(rt.get("scale"))
    name = chunk.get("name")
    # A text widget's authored string is `text`, kept verbatim - the literal string
    # "None" is real on-screen text on two widgets. Its localization binding is
    # `localizationString.value`, which is either "LocKey#<n>" or inline prose, and
    # `textIdKey` names the key as a CName.
    text = chunk.get("text")
    if not isinstance(text, str):
        text = None
    loc = chunk.get("localizationString")
    loc_text = loc.get("value") if isinstance(loc, dict) else None
    if not isinstance(loc_text, str) or loc_text == "":
        loc_text = None
    lockey = loc_text if loc_text and loc_text.startswith("LocKey#") else None
    text_id = scalar(chunk.get("textIdKey"))
    # `style` is a handle to an inkStyleResourceWrapper chunk carrying the depot path.
    style = None
    wrapper = resolve(chunk.get("style"))
    if isinstance(wrapper, dict):
        style = depot(wrapper.get("styleResource"))
    return (
        cid, fid, chunk.get("$type", ""),
        name if isinstance(name, str) else "",
        layout.get("anchor"), ax, ay, layout.get("HAlign"), layout.get("VAlign"),
        ml, mt, mr, mb, pl, pt, pr, pb,
        layout.get("sizeRule"), layout.get("sizeCoefficient"), sx, sy,
        1 if chunk.get("fitToContent") else 0,
        0 if chunk.get("visible") in (0, False) else 1,
        1 if chunk.get("isInteractive") else 0,
        chunk.get("opacity"),
        tx, ty, kx, ky, rt.get("rotation"),
        text, loc_text, lockey, text_id,
        chunk.get("fontSize"), depot(chunk.get("fontFamily")),
        depot(chunk.get("textureAtlas")), scalar(chunk.get("texturePart")),
        style, scalar(chunk.get("state")),
    )


NAME_KEYS = {"partName", "name", "propertyPath", "styleName", "fontStyle", "state"}


def harvest_names(node, out=None, depth=0):
    """The name-like strings of a root record, for the per-file search row."""
    if out is None:
        out = []
        _harvest(node, out, NAME_KEYS)
        seen = set()
        uniq = []
        for v in out:
            if v not in seen:
                seen.add(v)
                uniq.append(v)
        return " ".join(uniq)[:50000]
    return ""


def _harvest(node, out, keys):
    if isinstance(node, list):
        for v in node:
            _harvest(v, out, keys)
    elif isinstance(node, dict):
        for k, v in node.items():
            if k in keys and isinstance(v, str) and v and v != "None":
                out.append(v)
            else:
                _harvest(v, out, keys)


def jsonl_files():
    # Shards are named ink_<extension>_<nn>.jsonl and the extension does not always
    # start with "ink" - credits, ccstate and charcustpreset are ink-family classes
    # behind other extensions.
    return sorted(f for f in os.listdir(RAW)
                  if f.startswith("ink_") and f.endswith(".jsonl"))


def build(db_path, stripped=False, verbose=True):
    shards = jsonl_files()
    if not shards:
        sys.exit("no ink_ink*.jsonl in {} - run generate.wscript first".format(RAW))
    with open(os.path.join(RAW, "ink_defaults.json"), encoding="utf-8") as fh:
        defaults = json.load(fh)

    os.makedirs(DATA, exist_ok=True)
    if os.path.exists(db_path):
        os.remove(db_path)
    con = sqlite3.connect(db_path)
    con.execute("PRAGMA page_size = {}".format(PAGE_SIZE))
    con.executescript(SCHEMA)

    con.executemany("INSERT INTO defaults VALUES (?,?,?)",
                    [(c, k, json.dumps(v, separators=(",", ":")))
                     for c, props in defaults.items() for k, v in props.items()])

    with open(os.path.join(RAW, "ink_schema.json"), encoding="utf-8") as fh:
        rows = []
        for cls, props in json.load(fh).items():
            for prop, form in props.items():
                if "varies" in form:
                    rows.append((cls, prop, None, None, 1))
                else:
                    rows.append((cls, prop, form.get("type"), form.get("storage"), 0))
        con.executemany("INSERT INTO schema VALUES (?,?,?,?,?)", rows)

    with open(os.path.join(RAW, "ink_classes.json"), encoding="utf-8") as fh:
        con.executemany("INSERT INTO classes VALUES (?,?)", sorted(json.load(fh).items()))

    cid = 0
    fid = 0
    n_files = n_chunks = n_widgets = n_items = 0
    roundtrip_fails = 0

    for shard in shards:
        with open(os.path.join(RAW, shard), encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                path, kind, source = rec["path"], rec["kind"], rec["source"]
                fid += 1
                root = restore(rec.get("root"), defaults)
                raw_chunks = rec.get("chunks") or {}
                restored = {}
                local = {}
                for chunk_id, raw in raw_chunks.items():
                    cid += 1
                    local[chunk_id] = cid
                    restored[chunk_id] = restore(raw, defaults)
                    if strip(restored[chunk_id], defaults) != raw:
                        roundtrip_fails += 1
                if strip(root, defaults) != rec.get("root"):
                    roundtrip_fails += 1

                chunk_rows, ref_rows, widget_rows, tree_rows = [], [], [], []
                for chunk_id, chunk in restored.items():
                    my = local[chunk_id]
                    nm = chunk.get("name") if isinstance(chunk, dict) else None
                    stored = raw_chunks[chunk_id] if stripped else chunk
                    chunk_rows.append((
                        my, fid, chunk_id,
                        chunk.get("$type", "") if isinstance(chunk, dict) else "",
                        nm if isinstance(nm, str) else None,
                        json.dumps(stored, separators=(",", ":")),
                    ))
                    for target, field, ord_ in iter_refs(chunk):
                        if target in local:
                            ref_rows.append((my, fid, local[target], field, ord_))
                    if isinstance(chunk, dict) and isinstance(chunk.get("layout"), dict):
                        widget_rows.append(widget_row(
                            my, chunk, fid,
                            lambda v: restored.get(ref_of(v)) if ref_of(v) else
                                      (v if isinstance(v, dict) and "$ref" not in v else None)))
                        # children -> inkMultiChildren -> children
                        container = local.get(ref_of(chunk.get("children")))
                        if container:
                            arr = restored.get(ref_of(chunk.get("children")), {})
                            kids = arr.get("children") if isinstance(arr, dict) else None
                            if isinstance(kids, list):
                                for i, h in enumerate(kids):
                                    r = ref_of(h)
                                    if r in local:
                                        tree_rows.append((my, local[r], i))

                for target, field, ord_ in iter_refs(root):
                    if target in local:
                        ref_rows.append((0, fid, local[target], field, ord_))

                # Library items: name plus the instance and controller behind the
                # RedPackage buffer, so a search by controller lands on a file.
                if isinstance(root, dict):
                    for it in root.get("libraryItems") or []:
                        if not isinstance(it, dict):
                            continue
                        pd = it.get("packageData") or {}
                        chunks_arr = (pd.get("Data") or {}).get("Chunks") if isinstance(pd.get("Data"), dict) else None
                        if not chunks_arr:
                            # No RedPackage view: the instance sits in the CR2W view at
                            # package.Data.File.RootChunk instead.
                            pk = it.get("package") or {}
                            f_ = (pk.get("Data") or {}).get("File") if isinstance(pk.get("Data"), dict) else None
                            if isinstance(f_, dict) and f_.get("RootChunk") is not None:
                                chunks_arr = [f_["RootChunk"]]
                        inst_cid = None
                        root_widget_cid = None
                        ctrl_cid = None
                        ctrl_class = None
                        if isinstance(chunks_arr, list) and chunks_arr:
                            # A RedPackage Chunks array holds its first chunk inline;
                            # anything shared appears as a reference.
                            r = ref_of(chunks_arr[0])
                            if r is not None:
                                inst_cid = local.get(r)
                                inst = restored.get(r)
                            else:
                                inst = chunks_arr[0]
                            if isinstance(inst, dict):
                                root_widget_cid = local.get(ref_of(inst.get("rootWidget")))
                                gc = inst.get("gameController")
                                cr = ref_of(gc)
                                if cr is not None:
                                    ctrl_cid = local.get(cr)
                                    ctrl = restored.get(cr)
                                else:
                                    ctrl = gc
                                if isinstance(ctrl, dict):
                                    ctrl_class = ctrl.get("$type")
                        nm = it.get("name")
                        con.execute("INSERT OR REPLACE INTO items VALUES (?,?,?,?,?,?)",
                                    (fid, nm if isinstance(nm, str) else "",
                                     inst_cid, root_widget_cid, ctrl_cid, ctrl_class))
                        n_items += 1

                con.execute("INSERT INTO files VALUES (?,?,?,?,?,?,?)", (
                    fid, path, kind, source,
                    root.get("$type") if isinstance(root, dict) else None,
                    len(chunk_rows),
                    json.dumps(rec.get("root") if stripped else root,
                               separators=(",", ":"))))
                con.executemany("INSERT INTO chunks VALUES (?,?,?,?,?,?)", chunk_rows)
                con.executemany("INSERT INTO refs VALUES (?,?,?,?,?)", ref_rows)
                con.executemany(INSERT_WIDGET, widget_rows)
                con.executemany("INSERT INTO widget_tree VALUES (?,?,?)", tree_rows)
                n_files += 1
                n_chunks += len(chunk_rows)
                n_widgets += len(widget_rows)

    con.executescript(INDEXES)

    # Index what a person searches by; the structured fields are already columns. Two
    # kinds of rows: one per chunk (cid > 0) and one per file (cid = -fid), because a
    # resource whose whole content is the root record - every atlas and style sheet -
    # has no chunk rows and would otherwise be unfindable even by path.
    con.executescript("""
        CREATE VIRTUAL TABLE search USING fts5(
            cid UNINDEXED, name, class, path, text, tokenize="unicode61"
        );
        INSERT INTO search(cid, name, class, path, text)
            SELECT c.cid, coalesce(c.name,''), c.class, f.path,
                   trim(coalesce(w.text,'') || ' ' || coalesce(w.loc_text,'') || ' ' ||
                        coalesce(w.text_id,''))
            FROM chunks c JOIN files f USING (fid) LEFT JOIN widgets w ON w.cid = c.cid;
    """)
    for fid_, path_, class_, data_ in con.execute(
            "SELECT fid, path, class, data FROM files").fetchall():
        con.execute("INSERT INTO search(cid, name, class, path, text) VALUES (?,?,?,?,?)",
                    (-fid_, os.path.basename(path_), class_ or "", path_,
                     harvest_names(json.loads(data_))))
    con.execute("INSERT INTO search(search) VALUES('optimize')")
    con.commit()
    con.execute("VACUUM")
    con.close()

    if verbose:
        print("files    {:>10,}".format(n_files))
        print("items    {:>10,}".format(n_items))
        print("chunks   {:>10,}".format(n_chunks))
        print("widgets  {:>10,}".format(n_widgets))
        print("db       {:>10.1f} MB  {}".format(os.path.getsize(db_path) / 1048576, db_path))
        print("restore round trip against shipped records: {} failures".format(roundtrip_fails))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", default=os.path.join(DATA, "ink.db"))
    ap.add_argument("--stripped", action="store_true",
                    help="store data columns with class defaults factored out; the "
                         "defaults table ships in the db (the website flavour)")
    args = ap.parse_args()
    build(args.db, stripped=args.stripped)


if __name__ == "__main__":
    main()
