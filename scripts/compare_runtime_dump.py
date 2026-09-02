"""Compare a runtime ink tree dump against the authored values in the archive.

The Ink Tree Dumper CET mod (v1.1.0) writes one JSON object per widget with the node's
logic controller classes, layout values and content. Controllers are the join key: a
runtime subtree whose node carries a controller class found in the archive's items table
is matched to that library item, then walked name by name against widget_tree.

A field that differs is not an error - the runtime mutates authored values constantly -
so the report separates "matched, equal" from "matched, runtime differs" from
"unmatched". Equal-heavy output validates the dump and the archive against each other;
the differing fields are the runtime's own behavior, made visible.

Usage:
  python scripts/compare_runtime_dump.py <dump.jsonl> [--db data/ink.db]
  python scripts/compare_runtime_dump.py --selftest FastTravelGameController

--selftest synthesizes a dump from the archive itself and compares it back; every
matched field must come out equal, which proves the matcher without running the game.
"""

import argparse
import json
import os
import re
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# runtime record key -> (widgets column(s), kind)
FIELDS = {
    "anchor": ("anchor", "enum"),
    "hAlign": ("halign", "enum"),
    "vAlign": ("valign", "enum"),
    "sizeRule": ("size_rule", "enum"),
    "size": (("size_x", "size_y"), "vec"),
    "margin": (("margin_l", "margin_t", "margin_r", "margin_b"), "vec"),
    "padding": (("pad_l", "pad_t", "pad_r", "pad_b"), "vec"),
    "anchorPoint": (("anchor_x", "anchor_y"), "vec"),
    "translation": (("tr_x", "tr_y"), "vec"),
    "scale": (("scale_x", "scale_y"), "vec"),
    "rotation": ("rotation", "num"),
    "sizeCoefficient": ("size_coef", "num"),
    "opacity": ("opacity", "num"),
    "fitToContent": ("fit", "bool"),
    "visible": ("visible", "bool"),
    "interactive": ("interactive", "bool"),
    "text": ("text", "str"),
    "texturePart": ("part", "str"),
}


def enum_name(value):
    """CET stringifies an enum as 'inkEAnchor : Centered (4)'; the archive stores the
    bare name. The identifier before an optional numeric suffix is the value."""
    s = str(value)
    m = re.search(r"([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\d+\))?\s*$", s)
    return m.group(1) if m else s.strip()


def numeq(a, b, tol=1e-3):
    try:
        return abs(float(a) - float(b)) <= tol
    except (TypeError, ValueError):
        return False


def field_equal(kind, runtime, authored):
    if runtime is None and authored is None:
        return True
    if kind == "enum":
        return authored is not None and enum_name(runtime) == str(authored)
    if kind == "num":
        if runtime is None or authored is None:
            return numeq(runtime or 0, authored or 0)
        return numeq(runtime, authored)
    if kind == "bool":
        return bool(runtime) == bool(authored)
    if kind == "str":
        return (runtime or "") == (authored or "")
    if kind == "vec":
        r = runtime or []
        a = [x if x is not None else 0 for x in authored]
        if len(r) != len(a):
            return runtime is None and all(numeq(x, 0) for x in a)
        return all(numeq(x, y) for x, y in zip(r, a))
    return runtime == authored


class Archive:
    def __init__(self, db_path):
        self.con = sqlite3.connect(db_path)
        self.con.row_factory = sqlite3.Row

    def items_for_controller(self, controller):
        return self.con.execute(
            "SELECT i.fid, i.name, i.root_widget_cid, f.path FROM items i "
            "JOIN files f USING (fid) WHERE i.controller = ?", (controller,)).fetchall()

    def widgets_with_logic_controller(self, controller, name, cls):
        """Authored widgets carrying this logic controller: refs.field
        'logicController' or 'secondaryControllers' links the widget chunk to a
        controller chunk whose class is what the runtime's GetControllers reports."""
        return self.con.execute(
            "SELECT DISTINCT w.* FROM widgets w "
            "JOIN refs r ON r.from_cid = w.cid AND r.field IN ('logicController','secondaryControllers') "
            "JOIN chunks t ON t.cid = r.to_cid "
            "WHERE t.class = ? AND w.name = ? AND w.class = ?",
            (controller, name, cls)).fetchall()

    def widget(self, cid):
        return self.con.execute("SELECT * FROM widgets WHERE cid = ?", (cid,)).fetchone()

    def children(self, cid):
        return self.con.execute(
            "SELECT w.* FROM widget_tree t JOIN widgets w ON w.cid = t.child_cid "
            "WHERE t.parent_cid = ? ORDER BY t.ord", (cid,)).fetchall()


def load_dump(path):
    nodes = []
    meta = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if "meta" in rec or "done" in rec:
                meta.update(rec)
            else:
                nodes.append(rec)
    return meta, nodes


def build_runtime_tree(nodes):
    """The dump is depth-first with a path per node; children hang off the longest
    strictly shorter path prefix."""
    by_path = {}
    roots = []
    for n in nodes:
        n["_children"] = []
        by_path[n["path"]] = n
        parent_path = n["path"].rsplit("/", 1)[0] if "/" in n["path"] else None
        parent = by_path.get(parent_path)
        if parent is not None and parent is not n:
            parent["_children"].append(n)
        else:
            roots.append(n)
    return roots


def walk_match(archive, runtime_node, authored_row, stats, diffs, depth=0, visited=None):
    if visited is not None:
        visited.add(id(runtime_node))
    stats["matched"] += 1
    for key, (cols, kind) in FIELDS.items():
        authored = ([authored_row[c] for c in cols] if isinstance(cols, tuple)
                    else authored_row[cols])
        runtime = runtime_node.get(key)
        if runtime is None and (
                authored is None or (isinstance(authored, list) and
                                     all(v is None for v in authored))):
            continue
        stats["fields"] += 1
        if field_equal(kind, runtime, authored):
            stats["equal"] += 1
        else:
            stats["differ"] += 1
            diffs.append((runtime_node["path"], key, runtime, authored))

    authored_children = archive.children(authored_row["cid"])
    by_name = {}
    for row in authored_children:
        by_name.setdefault(row["name"], []).append(row)
    # Sibling names repeat (several children named "fluff" is normal), and both sides
    # keep authored order - so same-named children pair up positionally: each runtime
    # child consumes the first remaining authored child of its name.
    for child in runtime_node["_children"]:
        name = child.get("name") or ""
        candidates = by_name.get(name) or []
        pick = None
        for i, row in enumerate(candidates):
            if row["class"] == child.get("class"):
                pick = candidates.pop(i)
                break
        if pick is None and candidates:
            pick = candidates.pop(0)
        if pick is not None:
            walk_match(archive, child, pick, stats, diffs, depth + 1, visited)
        else:
            stats["unmatched"] += 1


def find_anchors(nodes):
    """Runtime nodes that name a controller class, shallowest first, so a parent
    anchor claims its subtree before any child anchor is tried."""
    for n in sorted(nodes, key=lambda x: x.get("depth", 0)):
        for controller in n.get("controllers") or []:
            yield n, controller


def pick_candidate(archive, node, candidates):
    """Several authored widgets can share name, class and controller (one per file that
    embeds the library); the one whose depth-1 child names line up best wins."""
    if len(candidates) == 1:
        return candidates[0]
    child_names = [c.get("name") or "" for c in node["_children"]]
    best, best_score = candidates[0], -1
    for row in candidates:
        names = [r["name"] for r in archive.children(row["cid"])]
        score = sum(1 for n in child_names if n in names)
        if score > best_score:
            best, best_score = row, score
    return best


def compare(archive, nodes, limit_diffs):
    build_runtime_tree(nodes)
    stats = {"matched": 0, "unmatched": 0, "fields": 0, "equal": 0, "differ": 0,
             "anchors": 0, "anchors_missed": 0}
    diffs = []
    visited = set()
    for node, controller in find_anchors(nodes):
        if id(node) in visited:
            continue
        # An item's game controller is the strongest anchor; a widget's logic
        # controller (plus its own name and class) anchors everything below items.
        items = archive.items_for_controller(controller)
        if items:
            visited.add(id(node))
            stats["anchors"] += 1
            walk_match(archive, node, archive.widget(items[0]["root_widget_cid"]),
                       stats, diffs, visited=visited)
            continue
        candidates = archive.widgets_with_logic_controller(
            controller, node.get("name") or "", node.get("class") or "")
        if candidates:
            visited.add(id(node))
            stats["anchors"] += 1
            walk_match(archive, node, pick_candidate(archive, node, candidates),
                       stats, diffs, visited=visited)
        else:
            stats["anchors_missed"] += 1

    print("runtime nodes          : {}".format(len(nodes)))
    print("controller anchors     : {} matched to items, {} unknown to the archive".format(
        stats["anchors"], stats["anchors_missed"]))
    print("nodes matched by name  : {}   (plus {} runtime-only nodes under them)".format(
        stats["matched"], stats["unmatched"]))
    print("fields compared        : {}   equal {}   runtime differs {}".format(
        stats["fields"], stats["equal"], stats["differ"]))
    if diffs:
        print("\nauthored vs runtime (first {}):".format(min(limit_diffs, len(diffs))))
        for path, key, runtime, authored in diffs[:limit_diffs]:
            print("  {} .{}: runtime={!r} authored={!r}".format(path, key, runtime, authored))
    return stats


def synth_dump(archive, controller):
    """A dump in the mod's own format, built from authored values - the matcher must
    score it 100% equal."""
    items = archive.items_for_controller(controller)
    if not items:
        sys.exit("no item with controller " + controller)
    out = []

    def emit(row, path, depth, attach_controller=False):
        rec = {"path": path, "depth": depth, "name": row["name"] or None,
               "class": row["class"],
               "anchor": row["anchor"], "hAlign": row["halign"], "vAlign": row["valign"],
               "sizeRule": row["size_rule"], "sizeCoefficient": row["size_coef"],
               "size": [row["size_x"] or 0, row["size_y"] or 0],
               "margin": [row["margin_l"] or 0, row["margin_t"] or 0,
                          row["margin_r"] or 0, row["margin_b"] or 0],
               "padding": [row["pad_l"] or 0, row["pad_t"] or 0,
                           row["pad_r"] or 0, row["pad_b"] or 0],
               "anchorPoint": [row["anchor_x"] or 0, row["anchor_y"] or 0],
               "translation": [row["tr_x"] or 0, row["tr_y"] or 0],
               "scale": [row["scale_x"] if row["scale_x"] is not None else 1,
                         row["scale_y"] if row["scale_y"] is not None else 1],
               "rotation": row["rotation"] or 0,
               "opacity": row["opacity"], "fitToContent": bool(row["fit"]),
               "visible": bool(row["visible"]), "interactive": bool(row["interactive"]),
               "text": row["text"], "texturePart": row["part"]}
        if attach_controller:
            rec["controllers"] = [controller]
        out.append({k: v for k, v in rec.items() if v is not None})
        for i, child in enumerate(archive.children(row["cid"])):
            emit(child, "{}/{}[{}]".format(path, child["name"] or "<unnamed>", i), depth + 1)

    root = archive.widget(items[0]["root_widget_cid"])
    emit(root, "selftest/" + (root["name"] or "Root"), 0, attach_controller=True)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("dump", nargs="?", help="runtime dump .jsonl from the CET mod")
    ap.add_argument("--db", default=os.path.join(ROOT, "data", "ink.db"))
    ap.add_argument("--limit-diffs", type=int, default=40)
    ap.add_argument("--selftest", metavar="CONTROLLER",
                    help="synthesize a dump for this controller's item and compare it")
    args = ap.parse_args()

    archive = Archive(args.db)
    if args.selftest:
        nodes = synth_dump(archive, args.selftest)
        stats = compare(archive, nodes, args.limit_diffs)
        ok = stats["differ"] == 0 and stats["unmatched"] == 0 and stats["anchors"] == 1
        print("\nselftest: " + ("PASS - every matched field equal" if ok else "FAIL"))
        sys.exit(0 if ok else 1)

    if not args.dump:
        ap.error("a dump file or --selftest is required")
    meta, nodes = load_dump(args.dump)
    if meta.get("gameController"):
        print("layer game controller  : {}".format(meta["gameController"]))
    compare(archive, nodes, args.limit_diffs)


if __name__ == "__main__":
    main()
