# Cyberpunk 2077 ink archive

Every ink resource in the game - the widget libraries behind every menu, HUD element,
in-world screen and loading spinner, plus the animations, atlases, styles, fonts, layer
definitions and character-customization data they reference - extracted whole and written
as JSONL plus a SQLite database.

Built as a reference for anyone doing anything with ink: modding the UI, learning how the
system fits together, or checking what the game actually ships. It is a dump of what is
in the archives, not a curated view of it.

| Kind | Files | Chunks | What it is |
| --- | --- | --- | --- |
| `inkwidget` | 1,669 | 780,589 | Widget libraries: every widget tree, controller binding and property manager |
| `inkanim` | 719 | 297,803 | Animation libraries: every sequence, interpolator and event |
| `inkatlas` | 1,253 | - | Texture atlases: named parts and their rectangles |
| `inkstyle` | 203 | - | Style sheets: theme properties and their values |
| `inkcharcustomization` | 4 | 2,136 | Character creator option sets |
| `inkhud` | 16 | - | HUD composition |
| `inkfontfamily` | 19 | - | Font families |
| `inkshapecollection` | 10 | - | Vector shapes |
| `inklayers`, `inktypography`, `inkmenu`, `inkfullscreencomposition`, `inkenginesettings`, `inkgamesettings` | 6 | - | Layer definitions, type scale, menu and settings resources |

3,901 resources, 1,080,531 chunks, 1,098 distinct classes. Base game and Phantom
Liberty, tagged per file by `source`. Game version 2.31.

## Complete means complete

No field is chosen and no field is skipped, at any level. The raw WolvenKit JSON of this
set is about 2.6 GB; the archive is a tenth of that because of three reversible
transformations, not because anything was left out:

1. **The graph stays a graph.** A resource references the same chunk from many places.
   Each chunk is stored once and references become `{"$ref": "scope:id"}`. Handle
   numbering restarts inside every embedded buffer, so ids are scoped (`b3:12`).
2. **Scalar wrappers become values, described once.** WolvenKit writes every scalar as
   `{$type, $storage, $value}`. The value is stored bare and the type/storage recorded per
   (class, field) in `ink_schema.json`. The 39 fields whose type or storage varies between
   occurrences - a `ResourcePath` is a string most of the time and a `uint64` hash
   otherwise, and the difference matters - carry their tag inline as `{$t, $s, $v}`.
3. **Class defaults are factored out.** A field equal to its class default is omitted and
   the default recorded in `ink_defaults.json`. A default is only recorded for fields
   present on every instance of the class, so restoring can never invent a field.

Every transformation is verified during generation, per resource, not assumed:

- **Leaf check** - every typed leaf value of the original survives, as a multiset
  comparison. 3,901 of 3,901 pass.
- **Structural check** - the original and the encoding are expanded and compared position
  by position. 3,899 of 3,901 are identical; `new_perks.inkwidget` and
  `perks_main.inkwidget` share subtrees so heavily that their expansion exceeds the
  300-million-token budget, and they are covered by the leaf check only.
- **Default round trip** - stripping then restoring defaults reproduces the encoding
  byte for byte on all 3,901.

One duplication is kept deliberately: a library item's buffer appears as both `package`
(a CR2W re-wrap) and `packageData` (the RedPackage the file actually stores). They are
not copies - the CR2W view nulls out every widget's `backendData` while the RedPackage
view carries the full editor state - so both stay.

## Using it

```bash
python build.py                                # data/ink.db, complete records
python build.py --db data/ink_web.db --stripped  # website flavour, defaults factored out
```

The default build restores class defaults into every stored record, so a field absent
from `data` means the resource does not have it. The `--stripped` flavour stores records
with defaults factored out - about 30% smaller - and ships the `defaults` table in the
same database so they are recoverable.

Tables:

| Table | One row per | The columns that matter |
| --- | --- | --- |
| `files` | resource | `path`, `kind`, `source`, `data` (the whole root record) |
| `chunks` | chunk | `class`, `name`, `data` (the whole chunk) |
| `refs` | reference | `from_cid` (0 = the file root), `to_cid`, `field` - the full graph |
| `items` | widget library item | `name`, `controller`, `instance_cid` |
| `widgets` | chunk with a layout | anchor, margins, size, text, atlas part... as columns |
| `widget_tree` | parent-child pair | the children hop, resolved through `inkMultiChildren` |
| `defaults`, `schema`, `classes` | class / field | what the compact encoding factored out |
| `search` | chunk | FTS5 over name, class, path and on-screen text |

`chunks_v`, `widgets_v` and `items_v` are the same tables with the file path joined on.

```sql
-- which file to edit for a given controller
SELECT path FROM items_v WHERE controller = 'FastTravelGameController';

-- every fixed-size, corner-anchored widget wider than a 1080p screen
SELECT path, name, size_x, size_y FROM widgets_v
 WHERE anchor = 'TopLeft' AND size_x > 1920 AND fit = 0 ORDER BY size_x DESC;

-- find on-screen text, land on the file that draws it
SELECT path, name FROM search WHERE search MATCH 'fast_travel' LIMIT 20;

-- walk a widget's children
SELECT c.name, c.class FROM widget_tree t JOIN widgets c ON c.cid = t.child_cid
 WHERE t.parent_cid = :cid ORDER BY t.ord;

-- which fields exist on a class, and what the engine defaults them to
SELECT prop, type, storage FROM schema WHERE class = 'inkTextWidget';
SELECT prop, value FROM defaults WHERE class = 'inkTextWidget';
```

## Regenerating from the game

`raw/` is the extraction itself and is committed; the databases are derived from it in
about a minute and are not. To rebuild `raw/` after a game patch, run `generate.wscript`
in WolvenKit's Script Manager against the game install, then copy the `ink_*.json` and
`ink_*.jsonl` files it writes into `raw/`. The script prints the verification results
listed above; a patch that changes the format shows up there rather than as silent loss.

## What this contains, and whose it is

The data is Cyberpunk 2077's, so it belongs to CD PROJEKT RED. This repository is an
extraction of it for modding and research, under the CD PROJEKT RED
[fan content guidelines](https://www.cdprojektred.com/en/fan-content): non-commercial,
and it carries no textures, models, audio, code or other shipped assets - only the
structure and values of the UI resources, and the scripts that extract and query them,
which are the only part that is this repository's own work.

This is an unofficial fan work and is not approved/endorsed by CD PROJEKT RED.
