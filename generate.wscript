// Sweep every ink resource in the archives into JSONL for build.py.
//
// Run it from WolvenKit's script manager against a game install. Output lands in the
// script raw folder; copy the ink_*.json / ink_*.jsonl files into this repo's raw/.
//
// No field is chosen and no field is skipped, at any level: the whole RootChunk of
// every resource is encoded. Three reversible transformations are applied:
//
//   1. A resource is a GRAPH. The same chunk is referenced from several places, written
//      inline once as {HandleId, Data} and as {HandleRefId} thereafter. Each chunk is
//      emitted once and every reference becomes {"$ref": id}. Inlining instead of
//      referencing duplicates shared subgraphs and costs roughly 25x the size.
//      Handle ids restart inside every embedded buffer, so ids are scoped per buffer.
//
//   2. A scalar is written as {$type, $storage, $value}. It is emitted as the bare value
//      and its type and storage are recorded once per (class, field) in the schema table.
//      A field whose type or storage VARIES between occurrences is tagged inline instead,
//      because a schema entry cannot describe it: a ResourcePath is stored as a string
//      most of the time and as a uint64 hash otherwise, and dropping the difference
//      would turn a hash into a path.
//
//   3. A field equal to its class default is omitted, and the defaults table ships
//      alongside. build.py restores them.
//
// Each transformation is verified during generation: every resource's leaf values are
// compared against the original's, the structure is compared position by position, and
// the default strip/restore is round-tripped. Any difference is reported.

const SHARD_BYTES = 40 * 1024 * 1024;   // keep every committed file well under 100 MB

// Every extension whose resource class belongs to the ink system. The authority is the
// engine's class-to-extension registry (WolvenKit FileTypeHelper mirrors it): the ink*
// extensions map to the ink*/inkanim*/gameui customization resource classes, and three
// more ink-family classes sit behind extensions that do not say "ink" - credits
// (inkCreditsResource), ccstate (gameuiCharacterCustomizationPreset) and charcustpreset
// (gameuiCharacterCustomizationUiPreset). Adding a type here is all that is needed to
// take it in; nothing below is written per type.
// inkWidgetBrushResource is the one ink-family resource class with no extension in the
// registry; it can only exist as an unresolved-hash entry, and the hash sweep below
// classifies every one of those, so it is covered without a row here.
const EXTENSIONS = [
    'inkwidget', 'inkanim', 'inkatlas', 'inkstyle', 'inklayers', 'inkfontfamily',
    'inkshapecollection', 'inktypography', 'inkcharcustomization',
    'inkhud', 'inkfullscreencomposition', 'inkmenu', 'inkenginesettings', 'inkgamesettings',
    'credits', 'ccstate', 'charcustpreset'
];

// A structural check expands the graph back into a tree, which a heavily shared graph can
// make very large. Past this many emitted tokens the file is reported as unverified
// rather than taking the process down with it.
const STRUCTURAL_BUDGET = 300000000;

///////////////////////////////////////////////////////////////////////////////
// Encoding
///////////////////////////////////////////////////////////////////////////////

// {$type, $storage, $value} where $value is a scalar. The $value of a wrapper is NOT
// always scalar: whandle:inkWidget wraps a handle object, and unwrapping that as if it
// were a value hands back a raw {HandleId, Data} that never becomes a chunk.
const isWrapper = (o, keys) =>
    '$value' in o && keys.every((k) => k === '$type' || k === '$storage' || k === '$value');
const isScalarWrapper = (o, keys) =>
    isWrapper(o, keys) && (o['$value'] === null || typeof o['$value'] !== 'object');

const isBuffer = (o) =>
    typeof o.Type === 'string' && o.Type.indexOf('WolvenKit.RED4.Archive.Buffer') >= 0
    && o.Data !== undefined;

// schema: "class field" -> Set of "type|storage". A field with one entry is described by
// the schema; a field with more than one has to carry its type inline.
function collectSchema(doc, schema) {
    (function walk(o, owner, field) {
        if (o === null || o === undefined || typeof o !== 'object') return;
        if (Array.isArray(o)) { for (const v of o) walk(v, owner, field); return; }
        const keys = Object.keys(o);
        if (isScalarWrapper(o, keys)) {
            if (owner && field) {
                const key = owner + ' ' + field;
                let s = schema.get(key);
                if (!s) { s = new Set(); schema.set(key, s); }
                s.add((o['$type'] || '') + '|' + (o['$storage'] === undefined ? '' : o['$storage']));
            }
            return;
        }
        if (isWrapper(o, keys)) { walk(o['$value'], owner, field); return; }
        for (const k of keys) walk(o[k], typeof o['$type'] === 'string' ? o['$type'] : owner, k);
    })(doc, null, null);
}

function encodeResource(rootChunk, schema) {
    const chunks = {};
    let scopeSeq = 0;

    function enc(o, scope, owner, field) {
        if (o === null || o === undefined) return null;
        if (typeof o !== 'object') return o;
        if (Array.isArray(o)) return o.map((v) => enc(v, scope, owner, field));

        if (o.HandleRefId !== undefined && o.Data === undefined) {
            return { $ref: scope + ':' + o.HandleRefId };
        }
        if (o.HandleId !== undefined && o.Data !== undefined) {
            const id = scope + ':' + o.HandleId;
            if (!(id in chunks)) {
                chunks[id] = null;              // claim the slot first, for cycles
                chunks[id] = enc(o.Data, scope, owner, field);
            }
            return { $ref: id };
        }

        const keys = Object.keys(o);
        if (isScalarWrapper(o, keys)) {
            const key = (owner || '') + ' ' + (field || '');
            const forms = schema.get(key);
            const mine = (o['$type'] || '') + '|' + (o['$storage'] === undefined ? '' : o['$storage']);
            if (forms && forms.size === 1 && forms.has(mine)) return o['$value'];
            // The schema cannot describe this field, so the value carries its own tag.
            const tagged = { $t: o['$type'] === undefined ? null : o['$type'], $v: o['$value'] };
            if (o['$storage'] !== undefined) tagged.$s = o['$storage'];
            return tagged;
        }
        if (isWrapper(o, keys)) {
            // A wrapper around a handle or a structure. The type is kept and the value is
            // encoded like anything else, so the handle inside still becomes a chunk.
            const tagged = { $t: o['$type'] === undefined ? null : o['$type'],
                             $v: enc(o['$value'], scope, owner, field) };
            if (o['$storage'] !== undefined) tagged.$s = o['$storage'];
            return tagged;
        }

        // An embedded buffer restarts handle numbering, so it gets its own id scope.
        const childScope = isBuffer(o) ? 'b' + (++scopeSeq) : scope;
        const nextOwner = typeof o['$type'] === 'string' ? o['$type'] : owner;
        const out = {};
        for (const k of keys) out[k] = enc(o[k], childScope, nextOwner, k);
        return out;
    }

    return { root: enc(rootChunk, 'r', null, null), chunks: chunks };
}

///////////////////////////////////////////////////////////////////////////////
// Defaults
///////////////////////////////////////////////////////////////////////////////

function stripDefaults(n, defaults) {
    if (n === null || n === undefined) return n;
    if (Array.isArray(n)) return n.map((v) => stripDefaults(v, defaults));
    if (typeof n !== 'object') return n;
    const d = typeof n['$type'] === 'string' ? (defaults[n['$type']] || {}) : {};
    const out = {};
    for (const k of Object.keys(n)) {
        if (k !== '$type' && k in d && JSON.stringify(n[k]) === JSON.stringify(d[k])) continue;
        out[k] = stripDefaults(n[k], defaults);
    }
    return out;
}

function restoreDefaults(n, defaults) {
    if (n === null || n === undefined) return n;
    if (Array.isArray(n)) return n.map((v) => restoreDefaults(v, defaults));
    if (typeof n !== 'object') return n;
    const d = typeof n['$type'] === 'string' ? (defaults[n['$type']] || {}) : {};
    const out = {};
    for (const k of Object.keys(n)) out[k] = restoreDefaults(n[k], defaults);
    for (const k of Object.keys(d)) if (!(k in out)) out[k] = d[k];
    return out;
}

///////////////////////////////////////////////////////////////////////////////
// Verification: every leaf value of the original must survive the encoding
///////////////////////////////////////////////////////////////////////////////

// A multiset of the original's leaves. A scalar wrapper counts as one leaf carrying its
// type, storage and value, so losing $storage shows up here as a changed leaf.
let negativeZeros = 0;

function leavesOriginal(doc) {
    const bag = new Map();
    const add = (s) => bag.set(s, (bag.get(s) || 0) + 1);
    (function walk(o) {
        if (o === null || o === undefined) { add('null'); return; }
        if (typeof o !== 'object') {
            if (typeof o === 'number' && Object.is(o, -0)) negativeZeros++;
            add(typeof o + ':' + String(o)); return;
        }
        if (Array.isArray(o)) { for (const v of o) walk(v); return; }
        const keys = Object.keys(o);
        if (isScalarWrapper(o, keys)) {
            // typeof is part of the label: String() collapses 5 and "5", so without it a
            // type flip between the sides would compare equal.
            add('S:' + (o['$type'] || '') + '|' + (o['$storage'] === undefined ? '' : o['$storage'])
                + '|' + typeof o['$value'] + '|' + String(o['$value']));
            return;
        }
        if (isWrapper(o, keys)) {
            add('W:' + (o['$type'] || '') + '|' + (o['$storage'] === undefined ? '' : o['$storage']));
            walk(o['$value']);
            return;
        }
        for (const k of keys) {
            if (k === 'HandleId' || k === 'HandleRefId') continue;   // ids are renumbered
            walk(o[k]);
        }
    })(doc);
    return bag;
}

// The same multiset from the encoded form, walking chunks once each.
function leavesEncoded(enc, schema) {
    const bag = new Map();
    const add = (s) => bag.set(s, (bag.get(s) || 0) + 1);
    function walk(o, owner, field) {
        if (o === null || o === undefined) { add('null'); return; }
        if (typeof o !== 'object') {
            const forms = schema.get((owner || '') + ' ' + (field || ''));
            if (forms && forms.size === 1) {
                const only = forms.values().next().value;
                add('S:' + only + '|' + typeof o + '|' + String(o));
            } else {
                add(typeof o + ':' + String(o));
            }
            return;
        }
        if (Array.isArray(o)) { for (const v of o) walk(v, owner, field); return; }
        if ('$ref' in o && Object.keys(o).length === 1) return;      // structure, not a leaf
        if ('$v' in o) {
            const t = (o.$t === null || o.$t === undefined) ? '' : o.$t;
            if (o.$v !== null && typeof o.$v === 'object') {
                add('W:' + t + '|' + (o.$s === undefined ? '' : o.$s));
                walk(o.$v, owner, field);
            } else {
                add('S:' + t + '|' + (o.$s === undefined ? '' : o.$s) + '|' + typeof o.$v + '|' + String(o.$v));
            }
            return;
        }
        const nextOwner = typeof o['$type'] === 'string' ? o['$type'] : owner;
        for (const k of Object.keys(o)) walk(o[k], nextOwner, k);
    }
    walk(enc.root, null, null);
    for (const id of Object.keys(enc.chunks)) walk(enc.chunks[id], null, null);
    return bag;
}

// restoreDefaults appends the restored keys, so the comparison has to ignore key order.
function canonical(o) {
    if (o === null || o === undefined) return null;
    if (Array.isArray(o)) return o.map(canonical);
    if (typeof o !== 'object') return o;
    const out = {};
    for (const k of Object.keys(o).sort()) out[k] = canonical(o[k]);
    return out;
}

// A multiset of values proves nothing was dropped, but not that values stayed in place -
// two fields swapping contents would pass it. This walks both forms in the same canonical
// order, expanding every reference, and hashes the token stream. Equal hashes mean equal
// structure, not merely equal contents.
function Hasher() {
    let h1 = 2166136261, h2 = 5381, n = 0;
    return {
        push(tok) {
            n++;
            const s = String(tok);
            for (let i = 0; i < s.length; i++) {
                const c = s.charCodeAt(i);
                h1 = ((h1 ^ c) >>> 0) * 16777619 >>> 0;
                h2 = (((h2 << 5) + h2) + c) >>> 0;
            }
            h1 = (h1 ^ 31) >>> 0;
        },
        get count() { return n; },
        get value() { return h1.toString(16) + ':' + h2.toString(16) + ':' + n; }
    };
}

// One pre-walk assigns every embedded buffer its scope label, keyed by object identity.
// Every later walk - collection, hashing, graph comparison - reads the label from here,
// so no walk's traversal order can renumber a buffer, and the labels are the ones the
// encoder assigns (it meets buffers in the same insertion order this walk uses).
function mapBufferScopes(root) {
    const map = new Map();
    let seq = 0;
    (function walk(o, scope) {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) { for (const v of o) walk(v, scope); return; }
        let s = scope;
        if (isBuffer(o)) { s = 'b' + (++seq); map.set(o, s); }
        for (const k of Object.keys(o)) walk(o[k], s);
    })(root, 'r');
    return map;
}

function collectDefs(root, scopes) {
    const defs = new Map();
    (function walk(o, scope) {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) { for (const v of o) walk(v, scope); return; }
        if (o.HandleId !== undefined && o.Data !== undefined) defs.set(scope + ':' + o.HandleId, o.Data);
        const s = scopes.get(o) || scope;
        for (const k of Object.keys(o)) walk(o[k], s);
    })(root, 'r');
    return defs;
}

// Token stream for the original WolvenKit JSON.
function hashOriginal(root) {
    const scopes = mapBufferScopes(root);
    const defs = collectDefs(root, scopes);

    const h = Hasher();
    const seen = new Set();
    let over = false;
    (function walk(o, scope) {
        if (over || h.count > STRUCTURAL_BUDGET) { over = true; return; }
        if (o === null || o === undefined) { h.push('null'); return; }
        if (typeof o !== 'object') { h.push('p' + typeof o + '=' + o); return; }
        if (Array.isArray(o)) { h.push('[' + o.length); for (const v of o) walk(v, scope); h.push(']'); return; }
        if (o.HandleRefId !== undefined && o.Data === undefined) {
            const t = defs.get(scope + ':' + o.HandleRefId);
            if (!t || seen.has(t)) { h.push('~cycle'); return; }
            seen.add(t); walk(t, scope); seen.delete(t); return;
        }
        if (o.HandleId !== undefined && o.Data !== undefined) {
            if (seen.has(o.Data)) { h.push('~cycle'); return; }
            seen.add(o.Data); walk(o.Data, scope); seen.delete(o.Data); return;
        }
        const keys = Object.keys(o);
        if (isScalarWrapper(o, keys)) {
            h.push('S|' + (o['$type'] || '') + '|' + (o['$storage'] === undefined ? '' : o['$storage'])
                + '|' + typeof o['$value'] + '|' + String(o['$value']));
            return;
        }
        if (isWrapper(o, keys)) {
            h.push('W|' + (o['$type'] || '') + '|' + (o['$storage'] === undefined ? '' : o['$storage']));
            walk(o['$value'], scope);
            return;
        }
        const s = scopes.get(o) || scope;
        const sorted = keys.slice().sort();
        h.push('{' + sorted.length);
        for (const k of sorted) { h.push('k' + k); walk(o[k], s); }
        h.push('}');
    })(root, 'r');
    return over ? null : h.value;
}

// The same token stream from the encoded form.
function hashEncoded(enc, schema) {
    const h = Hasher();
    const seen = new Set();
    let over = false;
    (function walk(o, owner, field) {
        if (over || h.count > STRUCTURAL_BUDGET) { over = true; return; }
        if (o === null || o === undefined) { h.push('null'); return; }
        if (typeof o !== 'object') {
            const forms = schema.get((owner || '') + ' ' + (field || ''));
            if (forms && forms.size === 1) {
                h.push('S|' + forms.values().next().value + '|' + typeof o + '|' + String(o));
            } else {
                h.push('p' + typeof o + '=' + o);
            }
            return;
        }
        if (Array.isArray(o)) { h.push('[' + o.length); for (const v of o) walk(v, owner, field); h.push(']'); return; }
        const keys = Object.keys(o);
        if (keys.length === 1 && '$ref' in o) {
            if (seen.has(o.$ref)) { h.push('~cycle'); return; }
            const t = enc.chunks[o.$ref];
            if (t === undefined) { h.push('~cycle'); return; }
            seen.add(o.$ref); walk(t, owner, field); seen.delete(o.$ref); return;
        }
        if ('$v' in o) {
            const t = (o.$t === null || o.$t === undefined) ? '' : o.$t;
            if (o.$v !== null && typeof o.$v === 'object') {
                h.push('W|' + t + '|' + (o.$s === undefined ? '' : o.$s));
                walk(o.$v, owner, field);
            }
            else h.push('S|' + t + '|' + (o.$s === undefined ? '' : o.$s) + '|' + typeof o.$v + '|' + String(o.$v));
            return;
        }
        const nextOwner = typeof o['$type'] === 'string' ? o['$type'] : owner;
        const sorted = keys.slice().sort();
        h.push('{' + sorted.length);
        for (const k of sorted) { h.push('k' + k); walk(o[k], nextOwner, k); }
        h.push('}');
    })(enc.root, null, null);
    return over ? null : h.value;
}

// Fallback structural proof for a resource whose EXPANSION exceeds the budget: hash the
// GRAPH instead. Every node's content is hashed with references as placeholders, then 64
// rounds fold each node's referenced hashes in, in reference order. Equal node-key sets,
// equal root hash and equal per-node hash multiset => equal graphs, positions included,
// at linear cost. This is what verifies the two perk screens, whose shared subtrees make
// full expansion explode.
function graphEquals(original, enc, schema) {
    // Content hashing reuses Hasher (two 32-bit lanes with per-token mixing), and the
    // original side reads buffer scope labels from the same identity map the other
    // walkers use, so its node keys are the encoder's chunk keys.
    function foldTokens(toks) {
        const h = Hasher();
        for (const t of toks) h.push(t);
        return h.value;
    }
    function contentOriginal(node, scope, scopes) {
        const toks = [], refs = [];
        (function w(o, scope) {
            if (o === null || o === undefined) { toks.push('null'); return; }
            if (typeof o !== 'object') { toks.push('p' + typeof o + '=' + o); return; }
            if (Array.isArray(o)) { toks.push('[' + o.length); for (const v of o) w(v, scope); toks.push(']'); return; }
            if (o.HandleRefId !== undefined && o.Data === undefined) { toks.push('R'); refs.push(scope + ':' + o.HandleRefId); return; }
            if (o.HandleId !== undefined && o.Data !== undefined) { toks.push('R'); refs.push(scope + ':' + o.HandleId); return; }
            const ks = Object.keys(o);
            if (isScalarWrapper(o, ks)) { toks.push('S|' + (o['$type'] || '') + '|' + (o['$storage'] === undefined ? '' : o['$storage']) + '|' + typeof o['$value'] + '|' + String(o['$value'])); return; }
            if (isWrapper(o, ks)) { toks.push('W|' + (o['$type'] || '') + '|' + (o['$storage'] === undefined ? '' : o['$storage'])); w(o['$value'], scope); return; }
            const s = scopes.get(o) || scope;
            const sorted = ks.slice().sort();
            toks.push('{' + sorted.length);
            for (const k of sorted) { toks.push('k' + k); w(o[k], s); }
            toks.push('}');
        })(node, scope);
        return { h: foldTokens(toks), refs: refs };
    }
    function contentEncoded(node) {
        const toks = [], refs = [];
        (function w(o, owner, field) {
            if (o === null || o === undefined) { toks.push('null'); return; }
            if (typeof o !== 'object') {
                const forms = schema.get((owner || '') + ' ' + (field || ''));
                if (forms && forms.size === 1) toks.push('S|' + forms.values().next().value + '|' + typeof o + '|' + String(o));
                else toks.push('p' + typeof o + '=' + o);
                return;
            }
            if (Array.isArray(o)) { toks.push('[' + o.length); for (const v of o) w(v, owner, field); toks.push(']'); return; }
            const ks = Object.keys(o);
            if (ks.length === 1 && '$ref' in o) { toks.push('R'); refs.push(o.$ref); return; }
            if ('$v' in o) {
                const t = (o.$t === null || o.$t === undefined) ? '' : o.$t;
                if (o.$v !== null && typeof o.$v === 'object') { toks.push('W|' + t + '|' + (o.$s === undefined ? '' : o.$s)); w(o.$v, owner, field); }
                else toks.push('S|' + t + '|' + (o.$s === undefined ? '' : o.$s) + '|' + typeof o.$v + '|' + String(o.$v));
                return;
            }
            const no = typeof o['$type'] === 'string' ? o['$type'] : owner;
            const sorted = ks.slice().sort();
            toks.push('{' + sorted.length);
            for (const k of sorted) { toks.push('k' + k); w(o[k], no, k); }
            toks.push('}');
        })(node, null, null);
        return { h: foldTokens(toks), refs: refs };
    }
    function refine(nodes) {
        let cur = new Map();
        for (const [k, v] of nodes) cur.set(k, v.h);
        for (let r = 0; r < 64; r++) {
            const next = new Map();
            for (const [k, v] of nodes) {
                const h = Hasher();
                h.push('round' + r);
                h.push('n' + cur.get(k));
                for (const rk of v.refs) h.push('r' + (cur.get(rk) === undefined ? '?' : cur.get(rk)));
                next.set(k, h.value);
            }
            cur = next;
        }
        const bag = Hasher();
        for (const v of [...cur.values()].sort()) bag.push(v);
        return { rootH: cur.get('__root__'), bagH: bag.value };
    }

    const scopes = mapBufferScopes(original);
    const oNodes = new Map();
    {
        const defs = new Map();
        (function collect(o, scope) {
            if (!o || typeof o !== 'object') return;
            if (Array.isArray(o)) { for (const v of o) collect(v, scope); return; }
            if (o.HandleId !== undefined && o.Data !== undefined) defs.set(scope + ':' + o.HandleId, { d: o.Data, s: scope });
            const sc = scopes.get(o) || scope;
            for (const k of Object.keys(o)) collect(o[k], sc);
        })(original, 'r');
        for (const [k, v] of defs) oNodes.set(k, contentOriginal(v.d, v.s, scopes));
        oNodes.set('__root__', contentOriginal(original, 'r', scopes));
    }
    const eNodes = new Map();
    for (const k of Object.keys(enc.chunks)) eNodes.set(k, contentEncoded(enc.chunks[k]));
    eNodes.set('__root__', contentEncoded(enc.root));

    if ([...oNodes.keys()].sort().join('|') !== [...eNodes.keys()].sort().join('|')) return false;
    const a = refine(oNodes), b = refine(eNodes);
    return a.rootH === b.rootH && a.bagH === b.bagH;
}

function bagDiff(a, b) {
    let diff = 0;
    const keys = new Set();
    for (const k of a.keys()) keys.add(k);
    for (const k of b.keys()) keys.add(k);
    for (const k of keys) diff += Math.abs((a.get(k) || 0) - (b.get(k) || 0));
    return diff;
}


// A library item's buffer appears TWICE in the tool JSON: `package` re-wraps it as a
// CR2W file and `packageData` is the RedPackage the .inkwidget actually stores. They are
// NOT duplicates - the CR2W view nulls out every widget's backendData while the
// RedPackage view carries the full inkWidgetBackendData (editor state and owner
// back-references) - so both are kept. That was measured, not assumed: a structural
// comparison of the two views differs on backendData for every item checked.

///////////////////////////////////////////////////////////////////////////////
// Enumerate
///////////////////////////////////////////////////////////////////////////////

// A path can be provided by more than one archive - yaiba_showroom_website.inkwidget
// ships in both basegame_4 and ep1_2 - and a read always resolves to the winner, so an
// unfiltered enumeration writes the same record twice.
const buckets = {};
for (const e of EXTENSIONS) buckets[e] = [];
const seenPaths = new Set();
let shadowed = 0;

for (const f of wkit.GetArchiveFiles()) {
    const p = f.FileName ?? f.Name;
    if (!p) continue;
    const lp = p.toLowerCase();
    const dot = lp.lastIndexOf('.');
    if (dot < 0) continue;
    const ext = lp.substring(dot + 1);
    if (!(ext in buckets)) continue;
    if (seenPaths.has(lp)) { shadowed++; continue; }
    seenPaths.add(lp);
    buckets[ext].push(lp);
}
for (const k of Object.keys(buckets)) buckets[k].sort();

// An entry whose path hash never resolved against the community hash list is named
// "<hash>.bin" and no extension filter can see it. Open each one by its bare hash, read
// the root chunk class, and take every ink-family resource found. Two exist in 2.31:
// an inkanim and an inkwidget, both in basegame_4_gamedata, referenced by nothing.
const ROOT_CLASS_TO_EXT = {
    inkWidgetLibraryResource: 'inkwidget',
    inkanimAnimationLibraryResource: 'inkanim',
    inkTextureAtlas: 'inkatlas',
    inkStyleResource: 'inkstyle',
    inkLayersResource: 'inklayers',
    inkFontFamilyResource: 'inkfontfamily',
    inkShapeCollectionResource: 'inkshapecollection',
    inkTypographyResource: 'inktypography',
    gameuiCharacterCustomizationInfoResource: 'inkcharcustomization',
    inkHudEntriesResource: 'inkhud',
    inkFullscreenCompositionResource: 'inkfullscreencomposition',
    inkMenuResource: 'inkmenu',
    inkEngineSettingsResource: 'inkenginesettings',
    inkGameSettingsResource: 'inkgamesettings',
    inkCreditsResource: 'credits',
    inkWidgetBrushResource: 'inkbrush',
    gameuiCharacterCustomizationPreset: 'ccstate',
    gameuiCharacterCustomizationUiPreset: 'charcustpreset',
};
// retrieval key -> how the record is labelled. A normal path is its own label.
const resourceMeta = new Map();
let unresolvedScanned = 0, unresolvedInk = 0, unresolvedUnreadable = 0;
{
    const hashes = new Set();
    for (const f of wkit.GetArchiveFiles()) {
        const n = (f.FileName ?? f.Name ?? '').toString();
        const m = /(?:^|\\)([0-9]+)\.bin$/i.exec(n);
        if (m) hashes.add(m[1]);
    }
    for (const h of hashes) {
        unresolvedScanned++;
        let text = null;
        // A hash entry that is not a CR2W file (one exists: a raw buffer) makes the
        // host log an ERROR line of its own before the throw lands here. That line is
        // expected; the summary counts the entry as unreadable and the sweep goes on.
        try { text = wkit.GameFileToJson(wkit.GetFileFromArchive(h, OpenAs.GameFile)); } catch (e) {}
        if (!text) { unresolvedUnreadable++; continue; }
        const m = /"RootChunk"\s*:\s*\{\s*"\$type"\s*:\s*"([^"]+)"/.exec(text.substring(0, 5000));
        const cls = m ? m[1] : null;
        const ext = cls && ROOT_CLASS_TO_EXT[cls];
        if (!ext) continue;
        unresolvedInk++;
        buckets[ext].push(h);
        resourceMeta.set(h, { display: h + '.' + ext, source: 'unknown', unresolved: true });
        logger.Info('  unresolved-hash ink resource: ' + h + ' (' + cls + ')');
    }
    for (const k of Object.keys(buckets)) buckets[k].sort();
}
logger.Info('unresolved-hash entries: ' + unresolvedScanned + ' scanned, ' + unresolvedInk +
    ' are ink resources (taken), ' + unresolvedUnreadable + ' unreadable (not CR2W)');

let totalFiles = 0;
logger.Info('shadowed paths skipped: ' + shadowed);
for (const k of EXTENSIONS) { totalFiles += buckets[k].length; logger.Info('  ' + k + ': ' + buckets[k].length); }
logger.Info('total resources: ' + totalFiles);

const sourceOf = (p) => (p.indexOf('ep1\\') === 0 || p.indexOf('ep1/') === 0) ? 'ep1' : 'base';
// Only RootChunk is extracted, because on every resource measured the rest of the
// document is constant: Data.Version 195, Data.BuildVersion 0, Data.EmbeddedFiles empty,
// and Header is the export tool's own stamp. The guard turns that measurement into a
// standing check, so a game patch that starts using those fields is announced instead
// of silently truncated.
let docShapeWarnings = 0;
const readRoot = (p) => {
    const doc = JSON.parse(wkit.GameFileToJson(wkit.GetFileFromArchive(p, OpenAs.GameFile)));
    const d = doc.Data || {};
    if (d.Version !== 195 || d.BuildVersion !== 0 ||
        (Array.isArray(d.EmbeddedFiles) && d.EmbeddedFiles.length)) {
        docShapeWarnings++;
        logger.Warning('document shape changed (Version/BuildVersion/EmbeddedFiles): ' + p);
    }
    return d.RootChunk;
};

///////////////////////////////////////////////////////////////////////////////
// Pass 1: schema and defaults
///////////////////////////////////////////////////////////////////////////////

const schema = new Map();
const hist = new Map();
const highCardinality = new Set();

const classInstances = new Map();

function tally(n) {
    if (!n || typeof n !== 'object' || Array.isArray(n)) return;
    const cls = n['$type'];
    if (typeof cls === 'string') {
        classInstances.set(cls, (classInstances.get(cls) || 0) + 1);
        for (const k of Object.keys(n)) {
            if (k === '$type') continue;
            const key = cls + ' ' + k;
            if (highCardinality.has(key)) continue;
            const v = JSON.stringify(n[k]);
            if (v.length > 300) { highCardinality.add(key); hist.delete(key); continue; }
            let m = hist.get(key);
            if (!m) { m = new Map(); hist.set(key, m); }
            m.set(v, (m.get(v) || 0) + 1);
            if (m.size > 800) { highCardinality.add(key); hist.delete(key); }
        }
    }
    for (const k of Object.keys(n)) {
        const v = n[k];
        if (Array.isArray(v)) { for (const c of v) tally(c); }
        else if (v && typeof v === 'object' && !('$ref' in v)) tally(v);
    }
}

let pass1 = 0;
for (const ext of EXTENSIONS) {
    for (const p of buckets[ext]) {
        try { collectSchema(readRoot(p), schema); pass1++; } catch (ex) { /* reported in pass 2 */ }
    }
}
logger.Info('pass 1a: schema over ' + pass1 + ' resources, ' + schema.size + ' (class, field) pairs');
let varying = 0;
for (const s of schema.values()) if (s.size > 1) varying++;
logger.Info('  fields whose type or storage varies (tagged inline): ' + varying);

for (const ext of EXTENSIONS) {
    for (const p of buckets[ext]) {
        try {
            const enc = encodeResource(readRoot(p), schema);
            tally(enc.root);
            for (const id of Object.keys(enc.chunks)) tally(enc.chunks[id]);
        } catch (ex) { /* reported in pass 2 */ }
    }
}

const defaults = {};
let defaultFields = 0;
for (const entry of hist) {
    const key = entry[0], m = entry[1];
    let best = null, bestCount = 0, total = 0;
    for (const vc of m) { total += vc[1]; if (vc[1] > bestCount) { bestCount = vc[1]; best = vc[0]; } }
    const i = key.indexOf(' ');
    const cls = key.slice(0, i), fld = key.slice(i + 1);
    // `total` is how many instances of the class carry this field. Unless that is EVERY
    // instance, restoring the default would add the field to instances that never had
    // it, which invents data rather than recovering it.
    const universal = total === classInstances.get(cls);
    if (universal && bestCount / total >= 0.5 && bestCount >= 8) {
        if (!defaults[cls]) defaults[cls] = {};
        defaults[cls][fld] = JSON.parse(best);
        defaultFields++;
    }
}
hist.clear();

const schemaOut = {};
for (const entry of schema) {
    const i = entry[0].indexOf(' ');
    const cls = entry[0].slice(0, i), fld = entry[0].slice(i + 1);
    if (!cls) continue;
    if (!schemaOut[cls]) schemaOut[cls] = {};
    const forms = [];
    for (const f of entry[1]) {
        const bar = f.indexOf('|');
        forms.push({ type: f.slice(0, bar), storage: f.slice(bar + 1) || null });
    }
    schemaOut[cls][fld] = forms.length === 1 ? forms[0] : { varies: forms };
}
wkit.SaveToRaw('ink_schema.json', JSON.stringify(schemaOut, null, 1));
wkit.SaveToRaw('ink_defaults.json', JSON.stringify(defaults, null, 1));
logger.Info('pass 1b: defaults ' + Object.keys(defaults).length + ' classes, ' + defaultFields + ' fields');

///////////////////////////////////////////////////////////////////////////////
// Pass 2: emit, sharded per extension, verifying every resource
///////////////////////////////////////////////////////////////////////////////

const classCount = {};
function countClasses(enc) {
    for (const id of Object.keys(enc.chunks)) {
        const c = enc.chunks[id];
        if (c && typeof c['$type'] === 'string') classCount[c['$type']] = (classCount[c['$type']] || 0) + 1;
    }
    if (enc.root && typeof enc.root['$type'] === 'string') {
        classCount[enc.root['$type']] = (classCount[enc.root['$type']] || 0) + 1;
    }
}

let grandFiles = 0, grandChunks = 0, grandErrs = 0, grandLeafDiffs = 0, grandDefaultFails = 0;
let structuralOk = 0, structDiffs = 0;
let structuralGraphOk = 0;
let grandBytes = 0;
let rootShapeFails = 0, danglingRefs = 0;

// Every $ref must land on a chunk, except the engine's null handle (HandleRefId -1),
// which is kept as a dangling <scope>:-1 on purpose. Anything else dangling means the
// scope labelling broke, which '~cycle' handling would otherwise mask on both sides of
// the structural check at once.
function countDanglingRefs(enc) {
    let bad = 0;
    function w(o) {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) { for (const v of o) w(v); return; }
        const ks = Object.keys(o);
        if (ks.length === 1 && '$ref' in o) {
            const id = String(o.$ref);
            if (!(id in enc.chunks) && id.slice(-3) !== ':-1') bad++;
            return;
        }
        for (const k of ks) w(o[k]);
    }
    w(enc.root);
    for (const id of Object.keys(enc.chunks)) w(enc.chunks[id]);
    return bad;
}

for (const ext of EXTENSIONS) {
    const list = buckets[ext];
    if (!list.length) continue;

    let shardIndex = 0, shardBytes = 0, shard = [];
    const flush = (force) => {
        if (!shard.length) return;
        if (!force && shardBytes < SHARD_BYTES) return;
        const name = 'ink_' + ext + '_' + ('0' + shardIndex).slice(-2) + '.jsonl';
        wkit.SaveToRaw(name, shard.join('\n'));
        logger.Info('  ' + name + ': ' + shard.length + ' resources, ' + (shardBytes / 1048576).toFixed(1) + ' MB');
        shardIndex++; shardBytes = 0; shard = [];
    };

    let files = 0, chunks = 0, errs = 0, leafDiffs = 0, defaultFails = 0;
    for (const p of list) {
        try {
            const original = readRoot(p);
            if (!original || typeof original !== 'object' || typeof original['$type'] !== 'string') {
                rootShapeFails++;
                logger.Warning('ROOT SHAPE unexpected (missing object/$type): ' + p);
            }
            const enc = encodeResource(original, schema);
            countClasses(enc);
            const dr = countDanglingRefs(enc);
            if (dr) { danglingRefs += dr; logger.Warning('DANGLING non-null $refs: ' + dr + ' in ' + p); }

            // Verify 1: no leaf value lost by the graph or scalar encoding.
            const d = bagDiff(leavesOriginal(original), leavesEncoded(enc, schema));
            if (d) { leafDiffs++; if (leafDiffs <= 5) logger.Warning('leaf diff ' + d + ' in ' + p); }

            // Verify 2: the structure matches position by position, not just in total.
            const ho = hashOriginal(original);
            const he = hashEncoded(enc, schema);
            if (ho === null || he === null) {
                if (graphEquals(original, enc, schema)) structuralGraphOk++;
                else { structDiffs++; logger.Warning('GRAPH-HASH mismatch in ' + p); }
            }
            else if (ho !== he) {
                structDiffs++;
                if (structDiffs <= 5) logger.Warning('STRUCTURAL mismatch in ' + p + '  ' + ho + ' vs ' + he);
            } else structuralOk++;

            // Verify 2: stripping defaults is reversible.
            const stripped = { root: stripDefaults(enc.root, defaults), chunks: {} };
            for (const id of Object.keys(enc.chunks)) stripped.chunks[id] = stripDefaults(enc.chunks[id], defaults);
            const back = { root: restoreDefaults(stripped.root, defaults), chunks: {} };
            for (const id of Object.keys(stripped.chunks)) back.chunks[id] = restoreDefaults(stripped.chunks[id], defaults);
            if (JSON.stringify(canonical(back)) !== JSON.stringify(canonical(enc))) {
                defaultFails++;
                if (defaultFails <= 5) logger.Warning('default round trip differs in ' + p);
            }

            const meta = resourceMeta.get(p);
            const rec = {
                path: meta ? meta.display : p,
                kind: ext,
                source: meta ? meta.source : sourceOf(p),
                root: stripped.root, chunks: stripped.chunks
            };
            if (meta && meta.unresolved) rec.unresolvedPath = true;
            const line = JSON.stringify(rec);
            shard.push(line);
            shardBytes += line.length + 1;
            chunks += Object.keys(enc.chunks).length;
            files++;
            flush(false);
        } catch (ex) {
            errs++;
            logger.Warning(ext + ' failed: ' + p + ' :: ' + ex);
        }
    }
    flush(true);
    grandFiles += files; grandChunks += chunks; grandErrs += errs;
    grandLeafDiffs += leafDiffs; grandDefaultFails += defaultFails;
    logger.Info(ext + ': files=' + files + ' chunks=' + chunks + ' errors=' + errs +
        ' leafDiffs=' + leafDiffs + ' defaultRoundTripFails=' + defaultFails);
}

wkit.SaveToRaw('ink_classes.json', JSON.stringify(classCount, null, 1));

logger.Info('==================================================');
logger.Info('resources ' + grandFiles + '  chunks ' + grandChunks + '  errors ' + grandErrs);
logger.Info('VERIFY leaf differences      : ' + grandLeafDiffs);
logger.Info('VERIFY structural identical  : ' + structuralOk + ' by expansion + ' + structuralGraphOk + ' by graph hash  mismatches ' + structDiffs);
logger.Info('VERIFY default round trip    : ' + grandDefaultFails + ' failures');
logger.Info('document shape warnings      : ' + docShapeWarnings);
logger.Info('root shape failures          : ' + rootShapeFails);
logger.Info('dangling non-null $refs      : ' + danglingRefs);
logger.Info('negative-zero floats seen    : ' + negativeZeros + ' (JSON round-trips them as 0 - the one value class the encoding flattens)');
logger.Info('distinct chunk classes       : ' + Object.keys(classCount).length);
logger.Info('==================================================');
logger.Info('Copy every ink_*.json / ink_*.jsonl into raw/.');
