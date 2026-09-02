# Cyberpunk 2077 ink archive

Every ink resource in the game - the widget libraries behind every menu, HUD element,
in-world screen and loading spinner, plus the animations, atlases, styles, fonts, layer
definitions, credits screens and character-customization data they reference - extracted
whole and written as JSONL plus a SQLite database.

A reference for anyone doing anything with ink: modding the UI, learning how the system
fits together, or checking what the game ships.

| Kind | Files | Chunks | What it is |
| --- | --- | --- | --- |
| `inkwidget` | 1,670 | 781,136 | Widget libraries: every widget tree, controller binding and property manager |
| `inkanim` | 720 | 297,909 | Animation libraries: every sequence, interpolator and event |
| `inkatlas` | 1,253 | - | Texture atlases: named parts and their rectangles |
| `inkstyle` | 203 | - | Style sheets: theme properties and their values |
| `inkcharcustomization` | 4 | 2,136 | Character creator option sets |
| `inkhud` | 16 | - | HUD composition |
| `inkfontfamily` | 19 | - | Font families |
| `inkshapecollection` | 10 | - | Vector shapes |
| `credits` | 4 | - | Credits screens (`inkCreditsResource`) |
| `charcustpreset`, `ccstate` | 8 | - | Character creator presets (`gameuiCharacterCustomization*Preset`) |
| `inklayers`, `inktypography`, `inkmenu`, `inkfullscreencomposition`, `inkenginesettings`, `inkgamesettings` | 8 | - | Layer definitions, type scale, menu and settings resources |

3,915 resources, 1,081,184 chunks, 1,101 distinct classes. Base game and Phantom
Liberty, game version 2.31. `source` records the path namespace (`base\` or `ep1\`).
One path, `yaiba_showroom_website.inkwidget`, is provided by both a base and an EP1
archive; the two copies parse identically, and the dump carries the one the game
resolves to.

**The extension list comes from the engine's class-to-extension registry** (WolvenKit's
`FileTypeHelper` mirrors it). Three ink-family classes ship behind extensions that do
not say "ink": `credits` (`inkCreditsResource`), `ccstate` and `charcustpreset` (the
character creator presets). `inkWidgetBrushResource` has no registered extension at all
and is covered by the hash sweep below.

**Files whose path hash never resolved are swept too.** 174 of the game's 583,798
archive entries have no known path; the generator opens each by its bare hash and reads
the root class. Two are ink resources - an animation library
(`840968453105948297.inkanim`) and a widget library (`10823073814826382310.inkwidget`),
both in `basegame_4_gamedata`, referenced by nothing - and both are in the dump, named
by their hash and marked `unresolvedPath`.

## The encoding

Every field of every chunk is kept, at every level. The raw WolvenKit JSON of this set
is about 2.6 GB; the archive is a tenth of that through three reversible
transformations:

1. **The graph stays a graph.** A resource references the same chunk from many places.
   Each chunk is stored once and references become `{"$ref": "scope:id"}`. Handle
   numbering restarts inside every embedded buffer, so ids are scoped (`b3:12`). The
   marker keys `$ref`, `$t`, `$s`, `$v` occur nowhere in the original data, so they are
   unambiguous.
2. **Scalar wrappers become values, described once.** WolvenKit writes every scalar as
   `{$type, $storage, $value}`. The value is stored bare and the type and storage
   recorded per (class, field) in `ink_schema.json`. The 39 fields whose type or storage
   varies between occurrences carry their tag inline as `{$t, $s, $v}` - a
   `ResourcePath` is a string most of the time and a `uint64` hash otherwise.
3. **Class defaults are factored out.** A field equal to its class default is omitted
   and the default recorded in `ink_defaults.json`. A default is only recorded for
   fields present on every instance of the class, so restoring can never invent a field.

Each transformation is verified during generation, per resource:

- **Leaf check** - every leaf value of the original survives, with its type, storage
  and JSON type, as a multiset comparison. 3,915 of 3,915 pass.
- **Structural check** - the original and the encoding are compared position by
  position: 3,913 by full expansion, and the two perk screens - whose shared subtrees
  make expansion exceed 300 million tokens - by an iterative graph hash on the same
  scope labels the encoder assigns. 0 mismatches.
- **Default round trip** - stripping then restoring defaults reproduces the encoding
  byte for byte on all 3,915, and `build.py` checks its own restore against the shipped
  records on every build.
- **Standing asserts** - every reference resolves to a chunk (the engine's null handle
  `-1` is the counted exception), every root record is a typed object, and the parts of
  the document outside `RootChunk` still match the constants they are elided as.

Two duplications stay in the data:

- A library item's buffer appears as both `package` (a CR2W re-wrap) and `packageData`
  (the RedPackage the file stores). They are not copies: the CR2W view nulls out every
  widget's `backendData` while the RedPackage view carries the full editor state.
- 185 referenced ink paths exist in no archive (`kampf_test.inkatlas`, `1.inkatlas`,
  ...). They are dead references in the shipped data - editor leftovers and cut
  content - and they are preserved as exactly that.

## The fidelity boundary

The dump equals WolvenKit 8.20's parse of the archives, verified exactly against that
parse. What that parse itself does not surface, no downstream check can recover:

- Every number in the corpus survives `JSON.parse` exactly - all 17.7 million number
  tokens are within the 2^53 exact-integer range. One value class is flattened: a
  single negative-zero float in the whole corpus round-trips as `0`.
- WolvenKit substitutes a class default when a property's bytes fail to read, and maps
  an enum value its RTTI does not know to the enum's default, logging rather than
  failing in both cases. The dump inherits any such substitution silently.
- CR2W container metadata - header timestamp, per-export flags, table layout - is not
  part of WolvenKit's JSON, and chunks unreachable from the root graph or buffers
  referenced by no chunk are dropped by its reader. None of that is widget data, but it
  is in the bytes and not here.
- The parts of the document outside `RootChunk` are constant across all 3,915 resources
  (`Version` 195, `BuildVersion` 0, `EmbeddedFiles` empty) and are therefore not
  stored; the generator warns if a future game patch changes that.

Adjacent systems are not included here:

- Binary assets: the `.xbm` textures behind the atlases, the `.fnt` font files, the
  `.bk2` videos.
- Code: the redscript and native classes behind every controller name.
- TweakDB: the `UIIcon` and widget-definition records that route icons and HUD presets.
- World placement: which `.ent`, `.app` or `.streamingsector` displays a given widget
  library in the world.
- Localization: UI strings resolve through LocKeys against the game's localization
  files. The LocKey identifiers themselves are in the dump and in the search index.

## Using it

```bash
python build.py                                  # data/ink.db, complete records
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
| `refs` | reference | `from_cid` (0 = the file root), `to_cid`, `field` - the full graph, minus the engine's null handles |
| `items` | widget library item | `name`, `controller`, `root_widget_cid` |
| `widgets` | chunk with a layout | anchor, margins, size, text, `loc_text`/`lockey`, atlas part, resolved `style`, `state`... as columns |
| `widget_tree` | parent-child pair | the children hop, resolved through `inkMultiChildren` |
| `defaults`, `schema`, `classes` | class / field | what the compact encoding factored out |
| `search` | chunk AND file | FTS5 over name, class, path, on-screen text, LocKeys, and the root record's part, property, option and credits names |

`chunks_v`, `widgets_v` and `items_v` are the same tables with the file path joined on.
`search` rows with `cid < 0` are per-file rows (`cid = -fid`), which is what makes a
chunk-less resource - every atlas and style sheet - findable by path, part name and
LocKey.

```sql
-- which file to edit for a given controller
SELECT path FROM items_v WHERE controller = 'FastTravelGameController';

-- every fixed-size, corner-anchored widget wider than a 1080p screen
SELECT path, name, size_x, size_y FROM widgets_v
 WHERE anchor = 'TopLeft' AND size_x > 1920 AND fit = 0 ORDER BY size_x DESC;

-- find on-screen text, an atlas part or a LocKey, land on the file that uses it
SELECT path, name FROM search WHERE search MATCH 'fast_travel' LIMIT 20;
SELECT path, name FROM search WHERE search MATCH '"LocKey#49376"';

-- which widgets bind a localization key
SELECT path, name, lockey FROM widgets_v WHERE lockey IS NOT NULL LIMIT 20;

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

This archive was built with the assistance of an LLM. Every count in this README was
run against the data rather than estimated. No rogue AIs were permitted through the
Blackwall.
