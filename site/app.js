"use strict";

/* Queries a stripped ink.db over HTTP range requests via sql.js-httpvfs. Records are
   stored with class defaults factored out; restore() puts them back before display,
   using the defaults table shipped in the same database. */

const VERSION_LINE = "3,915 resources · 1,081,184 chunks · game 2.31";
const $ = (id) => document.getElementById(id);

let DB = null;
let WORKER = null;
let DEFAULTS = null;
let currentNav = "search";
// The records visited since the last tab switch, newest last.
let TRAIL = [];

/* ------------------------------------------------------------------ boot -- */

async function boot() {
  try {
    // The config and wasm URLs are fetched from inside the worker, which resolves
    // relative URLs against its own script location, not this page - so absolute URLs.
    const abs = (p) => new URL(p, location.href).toString();
    const w = await createDbWorker(
      [{ from: "jsonconfig", configUrl: abs("data/config.json") }],
      abs("vendor/sqljs-httpvfs/sqlite.worker.js"),
      abs("vendor/sqljs-httpvfs/sql-wasm.wasm")
    );
    DB = w.db;
    WORKER = w.worker;
    $("meta").textContent = VERSION_LINE;
    updateStats();
    route();
  } catch (e) {
    $("meta").innerHTML =
      '<span class="err">database connection failed - serve this folder over HTTP ' +
      "with Range support (python scripts/serve.py) rather than file:// (" +
      esc(String(e)) + ")</span>";
  }
}

async function q(sql, ...params) {
  // sql.js exec() takes the bind values as one array; a bare value binds nothing and
  // leaves every ? as NULL.
  const rows = await DB.query(sql, params.length ? params : undefined);
  updateStats();
  return rows;
}

async function updateStats() {
  try {
    const s = await WORKER.getStats();
    if (s) {
      $("stats").textContent =
        (s.totalFetchedBytes / 1048576).toFixed(1) + " MB fetched · " +
        s.totalRequests + " requests";
    }
  } catch (e) { /* stats are decoration */ }
}

async function loadDefaults() {
  if (DEFAULTS) return DEFAULTS;
  const rows = await q("SELECT class, prop, value FROM defaults");
  DEFAULTS = new Map();
  for (const r of rows) {
    let m = DEFAULTS.get(r.class);
    if (!m) { m = {}; DEFAULTS.set(r.class, m); }
    m[r.prop] = JSON.parse(r.value);
  }
  return DEFAULTS;
}

function restore(node) {
  if (Array.isArray(node)) return node.map(restore);
  if (node === null || typeof node !== "object") return node;
  const out = {};
  for (const k of Object.keys(node)) out[k] = restore(node[k]);
  const cls = node["$type"];
  if (typeof cls === "string" && DEFAULTS.has(cls)) {
    const d = DEFAULTS.get(cls);
    for (const k of Object.keys(d)) if (!(k in out)) out[k] = d[k];
  }
  return out;
}

/* ------------------------------------------------------------- rendering -- */

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function jsonHtml(v, indent, fid) {
  const pad = "  ".repeat(indent);
  const pad1 = "  ".repeat(indent + 1);
  if (v === null) return '<span class="j-lit">null</span>';
  if (typeof v === "number") return '<span class="j-num">' + v + "</span>";
  if (typeof v === "boolean") return '<span class="j-lit">' + v + "</span>";
  if (typeof v === "string") return '<span class="j-str">"' + esc(v) + '"</span>';
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    const parts = v.map((x) => pad1 + jsonHtml(x, indent + 1, fid));
    return "[\n" + parts.join(",\n") + "\n" + pad + "]";
  }
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === "$ref") {
    return '{ "<span class="j-key">$ref</span>": <span class="link j-ref" data-fid="' +
      fid + '" data-ref="' + esc(v.$ref) + '">"' + esc(v.$ref) + '"</span> }';
  }
  if (!keys.length) return "{}";
  const parts = keys.map((k) =>
    pad1 + '"<span class="j-key">' + esc(k) + '"</span>: ' + jsonHtml(v[k], indent + 1, fid));
  return "{\n" + parts.join(",\n") + "\n" + pad + "}";
}

function table(rows, cols, cell) {
  if (!rows.length) return '<p class="dim">no results</p>';
  let h = "<table><tr>" + cols.map((c) => "<th>" + esc(c) + "</th>").join("") + "</tr>";
  for (const r of rows) {
    h += "<tr>" + cols.map((c) => "<td>" + cell(r, c) + "</td>").join("") + "</tr>";
  }
  return h + "</table>";
}

function basename(p) {
  const i = String(p).lastIndexOf("\\");
  return i < 0 ? String(p) : String(p).slice(i + 1);
}

function pushTrail(hash, label) {
  const last = TRAIL[TRAIL.length - 1];
  if (last && last.hash === hash) return;
  const seen = TRAIL.findIndex((t) => t.hash === hash);
  if (seen >= 0) TRAIL.length = seen + 1;
  else TRAIL.push({ hash: hash, label: label });
  if (TRAIL.length > 10) TRAIL.shift();
}

function trailHtml() {
  if (TRAIL.length < 2) return "";
  return '<div class="trail">' + TRAIL.map((t, i) =>
    i === TRAIL.length - 1
      ? '<span class="here">' + esc(t.label) + "</span>"
      : '<a href="' + t.hash + '">' + esc(t.label) + "</a>"
  ).join('<span class="sep">&rsaquo;</span>') + "</div>";
}

function fileLink(fid, path) {
  return '<a href="#file/' + fid + '">' + esc(path) + "</a>";
}
function chunkLink(cid, label) {
  return '<a href="#chunk/' + cid + '">' + esc(label) + "</a>";
}

/* --------------------------------------------------------------- routing -- */

function showTab(name, navName) {
  for (const el of document.querySelectorAll(".tab")) el.classList.remove("active");
  $("tab-" + name).classList.add("active");
  currentNav = navName || name;
  for (const b of document.querySelectorAll("#tabs button")) {
    b.classList.toggle("active", b.dataset.tab === currentNav);
  }
}

async function route() {
  if (!DB) return;
  const h = decodeURIComponent(location.hash.slice(1) || "search");
  const [what, ...rest] = h.split("/");
  const arg = rest.join("/");
  try {
    if (what === "file" && arg) await viewFile(+arg);
    else if (what === "chunk" && arg) await viewChunk(+arg);
    else if (what === "browse") { showTab("browse"); await runBrowse(arg); }
    else if (what === "sql") showTab("sql");
    else if (what === "layers") { showTab("layers"); await viewLayers(); }
    else if (what === "preview") {
      showTab("preview");
      const [pf, pc] = arg.split("/");
      if (pf) await loadPreviewFile(+pf);
      if (pc) previewSelectAny(+pc);
    }
    else if (what === "tree") await viewTree(arg);
    else if (what === "about") showTab("about");
    else {
      showTab("search");
      if (arg) { $("search-input").value = arg; await runSearch(arg); }
    }
  } catch (e) {
    console.error(e);
    const msg = String(e);
    $("meta").innerHTML = '<span class="err">' + esc(msg) +
      (/malformed/i.test(msg)
        ? " - the browser stitched cached parts of an older database build; a hard reload (Ctrl+F5) clears them"
        : "") + "</span>";
  }
}

/* ---------------------------------------------------------------- search -- */

function ftsQuery(input) {
  if (input.includes('"')) return input;   // the user is writing FTS syntax
  return input.trim().split(/\s+/).map((t) =>
    /[^\w*]/.test(t) ? '"' + t.replace(/"/g, "") + '"' : t).join(" ");
}

let searchTimer = null;
async function runSearch(text) {
  const out = $("search-results");
  if (!text.trim()) { out.innerHTML = ""; return; }
  out.innerHTML = '<p class="loading">searching…</p>';
  try {
    const rows = await q(
      "SELECT cid, name, class, path FROM search WHERE search MATCH ? LIMIT 80",
      ftsQuery(text));
    out.innerHTML = table(rows, ["", "name", "class", "path"], (r, c) => {
      if (c === "") return r.cid < 0 ? '<span class="dim">file</span>' : '<span class="dim">chunk</span>';
      if (c === "name") {
        const label = r.name || "—";
        return r.cid < 0 ? '<a href="#file/' + (-r.cid) + '">' + esc(label) + "</a>"
                         : chunkLink(r.cid, label);
      }
      if (c === "class") return '<span class="cls">' + esc(r.class) + "</span>";
      return '<span class="path">' + esc(r.path) + "</span>";
    });
  } catch (e) {
    out.innerHTML = '<p class="err">' + esc(String(e)) +
      '</p><p class="dim small">FTS5 syntax: words, "quoted phrases", AND / OR / NOT, col:term.</p>';
  }
}

/* ---------------------------------------------------------------- browse -- */

async function initBrowse() {
  const rows = await q(
    "SELECT kind, count(*) n FROM files GROUP BY kind ORDER BY n DESC");
  $("browse-kind").innerHTML = rows.map((r) =>
    '<option value="' + esc(r.kind) + '">' + esc(r.kind) + " (" + r.n + ")</option>").join("");
}

async function runBrowse() {
  const out = $("browse-results");
  if (!$("browse-kind").options.length) await initBrowse();
  const kind = $("browse-kind").value;
  const filter = $("browse-filter").value.trim();
  out.innerHTML = '<p class="loading">loading…</p>';
  const rows = filter
    ? await q("SELECT fid, path, source, chunk_count FROM files WHERE kind=? AND path LIKE ? ORDER BY path LIMIT 300",
              kind, "%" + filter + "%")
    : await q("SELECT fid, path, source, chunk_count FROM files WHERE kind=? ORDER BY path LIMIT 300", kind);
  out.innerHTML = table(rows, ["path", "source", "chunks"], (r, c) => {
    if (c === "path") return fileLink(r.fid, r.path);
    if (c === "chunks") return String(r.chunk_count);
    return esc(r[c]);
  }) + (rows.length === 300 ? '<p class="dim small">first 300 shown - narrow the filter</p>' : "");
}

/* ------------------------------------------------------------------- sql -- */

// Saved queries with fill-in slots, for reading the archive without writing SQL cold.
// Every query here answers from an index, so it stays fast over HTTP.
const PRESETS = [
  { label: "Class census - what exists, by count",
    sql: "SELECT class, count FROM classes ORDER BY count DESC LIMIT 40" },
  { label: "Which file has this controller",
    params: ["controller class, e.g. FastTravelGameController"], suggest: ["controller"],
    sql: "SELECT path FROM items_v WHERE controller = {0}" },
  { label: "Find widgets by exact name",
    params: ["widget name, e.g. fast_travel_grid"],
    sql: "SELECT cid, name, class, path FROM widgets_v WHERE name = {0} LIMIT 100" },
  { label: "Fixed-size widgets, by minimum width",
    params: ["minimum width in px, e.g. 1920"], numeric: [0],
    sql: "SELECT w.size_x, w.size_y, w.name, f.path FROM widgets w JOIN files f USING (fid) WHERE w.anchor = 'TopLeft' AND w.fit = 0 AND w.size_x > {0} ORDER BY w.size_x DESC LIMIT 100" },
  { label: "Which widgets bind this LocKey",
    params: ["LocKey#12345"],
    sql: "SELECT cid, name, path FROM widgets_v WHERE lockey = {0}" },
  { label: "Which widgets use this atlas",
    params: ["atlas path - start typing to pick one"], suggest: ["atlas"],
    sql: "SELECT name, part, path FROM widgets_v WHERE atlas = {0} LIMIT 200" },
  { label: "Fields a class can carry",
    params: ["class, e.g. inkTextWidget"], suggest: ["class"],
    sql: "SELECT prop, type, storage, varies FROM schema WHERE class = {0} ORDER BY prop" },
  { label: "Engine defaults of a class",
    params: ["class, e.g. inkTextWidget"], suggest: ["class"],
    sql: "SELECT prop, value FROM defaults WHERE class = {0} ORDER BY prop" },
  { label: "All files of a kind",
    params: ["kind, e.g. inkstyle"], suggest: ["kind"],
    sql: "SELECT path, chunk_count FROM files WHERE kind = {0} ORDER BY path LIMIT 300" },
  { label: "Children of a widget, by cid",
    params: ["parent cid"], numeric: [0],
    sql: "SELECT c.cid, c.name, c.class FROM widget_tree t JOIN widgets c ON c.cid = t.child_cid WHERE t.parent_cid = {0} ORDER BY t.ord" },
];

// Values the archive itself can suggest for a fill-in slot, fetched once and
// cached. Every query reads an index only.
const SUGGEST_SQL = {
  controller: "SELECT DISTINCT controller AS v FROM items WHERE controller IS NOT NULL ORDER BY 1",
  class: "SELECT class AS v FROM classes ORDER BY count DESC",
  widgetclass: "SELECT class AS v FROM classes WHERE class LIKE 'ink%Widget' ORDER BY count DESC",
  kind: "SELECT DISTINCT kind AS v FROM files ORDER BY 1",
  atlas: "SELECT DISTINCT atlas AS v FROM widgets WHERE atlas IS NOT NULL ORDER BY 1",
};
const suggestCache = {};

async function fillDatalist(slot, type) {
  const dl = $("dl-p" + slot);
  if (!type || !SUGGEST_SQL[type]) { dl.innerHTML = ""; return; }
  if (!suggestCache[type]) {
    try {
      suggestCache[type] = (await q(SUGGEST_SQL[type])).map((r) => r.v);
    } catch (e) { suggestCache[type] = []; }
  }
  dl.innerHTML = suggestCache[type].slice(0, 500).map((v) =>
    '<option value="' + esc(v) + '"></option>').join("");
}

function initPresets() {
  $("preset-select").innerHTML = PRESETS.map((p, i) =>
    '<option value="' + i + '">' + esc(p.label) + "</option>").join("");
  presetChanged();
}

function presetChanged() {
  const p = PRESETS[+$("preset-select").value];
  for (const i of [0, 1]) {
    const el = $("preset-p" + i);
    const has = p.params && p.params.length > i;
    el.hidden = !has;
    el.value = "";
    if (has) {
      el.placeholder = p.params[i];
      fillDatalist(i, (p.suggest || [])[i]);
    }
  }
}

function runPreset() {
  const p = PRESETS[+$("preset-select").value];
  let sql = p.sql;
  for (const i of [0, 1]) {
    if (!p.params || p.params.length <= i) break;
    const raw = $("preset-p" + i).value.trim();
    if (!raw) { $("preset-p" + i).focus(); return; }
    const lit = (p.numeric || []).includes(i)
      ? String(Number(raw) || 0)
      : "'" + raw.replace(/'/g, "''") + "'";
    sql = sql.split("{" + i + "}").join(lit);
  }
  $("sql-input").value = sql;
  runSql();
}


async function runSql() {
  const out = $("sql-results");
  const status = $("sql-status");
  let sql = $("sql-input").value.trim().replace(/;\s*$/, "");
  if (!/^(select|with|explain)\b/i.test(sql)) {
    out.innerHTML = '<p class="err">SELECT, WITH and EXPLAIN only</p>';
    return;
  }
  if (!/\blimit\s+\d+/i.test(sql)) sql += " LIMIT 200";
  status.textContent = "running…";
  out.innerHTML = "";
  const t0 = performance.now();
  const ticker = setInterval(async () => {
    try {
      const st = await WORKER.getStats();
      status.textContent = "running… " + (st.totalFetchedBytes / 1048576).toFixed(1) +
        " MB fetched - a query outside the indexes reads the table over HTTP";
    } catch (e) { /* decoration */ }
  }, 1500);
  try {
    const rows = await q(sql);
    clearInterval(ticker);
    const ms = Math.round(performance.now() - t0);
    status.textContent = rows.length + " rows · " + ms + " ms";
    if (!rows.length) { out.innerHTML = '<p class="dim">no rows</p>'; return; }
    const cols = Object.keys(rows[0]);
    const isPath = (s) => typeof s === "string" && /^(base|ep1|engine)[\\/].+\.[a-z0-9]+$/i.test(s);
    out.innerHTML = table(rows.slice(0, 500), cols, (r, c) => {
      const v = r[c];
      if (v === null) return '<span class="dim">NULL</span>';
      if (c.endsWith("cid") && Number.isInteger(v) && v > 0) return chunkLink(v, v);
      if (c === "fid" && Number.isInteger(v)) return '<a href="#file/' + v + '">' + v + "</a>";
      if (isPath(v)) return '<span class="link pathlink" data-path="' + esc(v) + '">' + esc(v) + "</span>";
      const s = String(v);
      return esc(s.length > 400 ? s.slice(0, 400) + "…" : s);
    });
  } catch (e) {
    clearInterval(ticker);
    status.textContent = "";
    out.innerHTML = '<p class="err">' + esc(String(e)) + "</p>";
  }
}

/* --------------------------------------------------------- record viewers -- */

async function viewFile(fid) {
  showTab("record", currentNav);
  const out = $("record-content");
  out.innerHTML = '<p class="loading">loading…</p>';
  await loadDefaults();
  const [f] = await q("SELECT * FROM files WHERE fid=?", fid);
  if (!f) { out.innerHTML = '<p class="err">no file ' + fid + "</p>"; return; }
  const items = await q(
    "SELECT name, root_widget_cid, controller_cid, controller FROM items WHERE fid=? ORDER BY name", fid);
  const root = restore(JSON.parse(f.data));
  pushTrail("#file/" + fid, basename(f.path));
  let h = '<div class="record">';
  h += trailHtml();
  h += '<div class="crumbs"><span class="cls">' + esc(f.class || f.kind) + "</span> · " +
    esc(f.path) + " · " + esc(f.source) + " · " + f.chunk_count + " chunks";
  if (f.kind === "inkwidget") h += ' · <a href="#preview/' + fid + '">preview layout</a>';
  h += ' · <a href="#tree/file/' + fid + '">tree</a>';
  h += "</div>";
  if (items.length) {
    h += "<h3>Library items</h3>" + table(items, ["name", "widget tree", "controller"], (r, c) => {
      if (c === "name") return esc(r.name || "—");
      if (c === "widget tree") return r.root_widget_cid
        ? chunkLink(r.root_widget_cid, "#" + r.root_widget_cid) + ' · <a href="#tree/' + r.root_widget_cid + '">tree</a>'
        : '<span class="dim">—</span>';
      return r.controller
        ? (r.controller_cid ? chunkLink(r.controller_cid, r.controller) : esc(r.controller))
        : '<span class="dim">—</span>';
    });
  }
  h += "<h3>Root record</h3><pre>" + jsonHtml(root, 0, fid) + "</pre></div>";
  out.innerHTML = h;
}

async function viewChunk(cid) {
  showTab("record", currentNav);
  const out = $("record-content");
  out.innerHTML = '<p class="loading">loading…</p>';
  await loadDefaults();
  const [c] = await q("SELECT c.*, f.path FROM chunks c JOIN files f USING (fid) WHERE cid=?", cid);
  if (!c) { out.innerHTML = '<p class="err">no chunk ' + cid + "</p>"; return; }
  const inbound = await q(
    "SELECT r.from_cid, c2.class, c2.name FROM refs r LEFT JOIN chunks c2 ON c2.cid = r.from_cid " +
    "WHERE r.to_cid=? LIMIT 25", cid);
  // For a widget chunk, the path from its item root down to it - the tree the
  // engine walks, as links.
  const chain = await q(
    "WITH RECURSIVE up(cid, depth) AS (" +
    "  SELECT ?, 0 UNION ALL " +
    "  SELECT t.parent_cid, up.depth + 1 FROM widget_tree t JOIN up ON t.child_cid = up.cid WHERE up.depth < 40) " +
    "SELECT w.cid, w.name, w.class FROM up JOIN widgets w ON w.cid = up.cid ORDER BY up.depth DESC", cid);
  const data = restore(JSON.parse(c.data));
  pushTrail("#chunk/" + cid,
    (c.name || c.class || "chunk") + " [" + c.chunk_id + "]");
  let h = '<div class="record">';
  h += trailHtml();
  h += '<div class="crumbs">' + fileLink(c.fid, c.path) + " · chunk <b>" + esc(c.chunk_id) +
    '</b> · <span class="cls">' + esc(c.class) + "</span>" +
    (c.name ? " · " + esc(c.name) : "") +
    ' · <a href="#tree/' + cid + '">tree</a></div>';
  if (chain.length > 1) {
    h += '<div class="chain">widget tree: ' + chain.map((n, i) =>
      i === chain.length - 1
        ? '<span class="here">' + esc(n.name || n.class) + "</span>"
        : chunkLink(n.cid, n.name || n.class)
    ).join('<span class="sep">&rsaquo;</span>') + "</div>";
  }
  if (inbound.length) {
    h += '<p class="dim small">referenced by: ' + inbound.map((r) =>
      r.from_cid === 0 ? "file root"
        : chunkLink(r.from_cid, (r.name || r.class || r.from_cid))).join(", ") + "</p>";
  }
  h += "<pre>" + jsonHtml(data, 0, c.fid) + "</pre></div>";
  out.innerHTML = h;
}

async function openRef(fid, ref) {
  const rows = await q("SELECT cid FROM chunks WHERE fid=? AND chunk_id=?", fid, ref);
  if (rows.length) location.hash = "#chunk/" + rows[0].cid;
}

/* ---------------------------------------------------------------- layers -- */

async function viewLayers() {
  const out = $("layers-content");
  out.innerHTML = '<p class="loading">loading…</p>';
  await loadDefaults();
  const files = await q("SELECT fid, path, data FROM files WHERE kind='inklayers'");
  let h = "";
  for (const f of files) {
    const root = restore(JSON.parse(f.data));
    h += '<div class="record"><div class="crumbs">' + fileLink(f.fid, f.path) + "</div>";
    for (const grp of ["layerDefinitions", "permanentLayerDefinitions", "preGameLayerDefinitions"]) {
      const coll = root[grp];
      if (!coll || typeof coll !== "object") continue;
      const rows = [];
      for (const key of Object.keys(coll)) {
        const d = coll[key];
        if (!d || typeof d !== "object" || !d["$type"]) continue;
        rows.push({
          layer: key,
          class: d["$type"],
          root: depotOf(d.rootLibrary),
          input: flag(d.useGameInput),
          theme: flag(d.useGlobalStyleTheme),
          permanent: flag(d.isPermanent),
          entries: Array.isArray(d.entries) ? d.entries.length : 0,
        });
      }
      h += "<h3>" + esc(grp) + "</h3>" +
        table(rows, ["layer", "class", "root library", "input", "theme", "permanent", "entries"],
          (r, c) => {
            if (c === "root library") return r.root
              ? '<span class="link pathlink" data-path="' + esc(r.root) + '">' + esc(r.root) + "</span>"
              : '<span class="dim">—</span>';
            if (c === "class") return '<span class="cls">' + esc(r.class) + "</span>";
            return esc(String(r[{ layer: "layer", input: "input", theme: "theme", permanent: "permanent", entries: "entries" }[c] || c]));
          });
    }
    h += "</div>";
  }
  out.innerHTML = h || '<p class="dim">no layer resources</p>';
}

function depotOf(v) {
  if (!v || typeof v !== "object") return typeof v === "string" ? v : null;
  let p = v.DepotPath;
  if (p && typeof p === "object") p = p.$v !== undefined ? p.$v : p.$value;
  return (typeof p === "string" && p !== "0") ? p : null;
}
function flag(v) { return v ? "yes" : ""; }

async function openPath(path) {
  const rows = await q("SELECT fid FROM files WHERE path=?", path.toLowerCase());
  if (rows.length) location.hash = "#file/" + rows[0].fid;
}

/* --------------------------------------------------------------- preview -- */

const ANCHORS = {
  TopLeft: [0, 0, 0, 0], TopCenter: [.5, 0, .5, 0], TopRight: [1, 0, 1, 0],
  CenterLeft: [0, .5, 0, .5], Centered: [.5, .5, .5, .5], CenterRight: [1, .5, 1, .5],
  BottomLeft: [0, 1, 0, 1], BottomCenter: [.5, 1, .5, 1], BottomRight: [1, 1, 1, 1],
  Fill: [0, 0, 1, 1],
  TopFillHorizontaly: [0, 0, 1, 0], BottomFillHorizontaly: [0, 1, 1, 1],
  CenterFillHorizontaly: [0, .5, 1, .5],
  LeftFillVerticaly: [0, 0, 0, 1], RightFillVerticaly: [1, 0, 1, 1],
  CenterFillVerticaly: [.5, 0, .5, 1],
};
const CLASS_COLOR = {
  inkCanvasWidget: "#3f6d8e", inkFlexWidget: "#3f8e6d",
  inkHorizontalPanelWidget: "#8e6d3f", inkVerticalPanelWidget: "#8e3f6d",
  inkUniformGridWidget: "#6d3f8e", inkGridWidget: "#6d3f8e",
  inkTextWidget: "#c9a227", inkImageWidget: "#4d8ec9",
  inkRectangleWidget: "#666", inkBorderWidget: "#888",
  inkMaskWidget: "#a05", inkVideoWidget: "#0a5",
};
let PV = null;   // {fid, widgets: Map, children: Map, items: []}

async function previewSuggest(text) {
  const out = $("preview-suggest");
  if (!text.trim()) { out.innerHTML = ""; return; }
  const rows = await q(
    "SELECT fid, path FROM files WHERE kind='inkwidget' AND path LIKE ? ORDER BY path LIMIT 20",
    "%" + text.trim() + "%");
  out.innerHTML = rows.map((r) =>
    '<div><span class="link pv-pick" data-fid="' + r.fid + '">' + esc(r.path) + "</span></div>").join("");
}

async function loadPreviewFile(fid) {
  showTab("preview");
  $("preview-suggest").innerHTML = "";
  const widgets = await q("SELECT * FROM widgets WHERE fid=?", fid);
  const edges = await q(
    "SELECT t.parent_cid, t.child_cid, t.ord FROM widget_tree t " +
    "JOIN widgets p ON p.cid = t.parent_cid WHERE p.fid=? ORDER BY t.parent_cid, t.ord", fid);
  const items = await q(
    "SELECT name, root_widget_cid FROM items WHERE fid=? AND root_widget_cid IS NOT NULL ORDER BY name", fid);
  const [f] = await q("SELECT path, root_resolution FROM files WHERE fid=?", fid);
  const wmap = new Map();
  for (const w of widgets) wmap.set(w.cid, w);
  const children = new Map();
  for (const e of edges) {
    if (!children.has(e.parent_cid)) children.set(e.parent_cid, []);
    children.get(e.parent_cid).push(e.child_cid);
  }
  const rm = /_(\d+)_(\d+)$/.exec((f && f.root_resolution) || "");
  PV = { fid: fid, widgets: wmap, children: children, items: items,
         path: f ? f.path : "",
         W: rm ? +rm[1] : 3840, H: rm ? +rm[2] : 2160,
         res: (f && f.root_resolution) || "UltraHD_3840_2160" };
  $("preview-file").value = PV.path;
  const sel = $("preview-item");
  sel.innerHTML = items.map((it, i) =>
    '<option value="' + i + '">' + esc(it.name || "item " + i) + "</option>").join("");
  sel.hidden = items.length < 2;
  renderPreview();
}

// The view over the canvas: scale plus translation, wheel-zoomed around the
// cursor, dragged to pan, double-click back to the whole-file fit.
let pvView = null;

function pvApply() {
  $("preview-canvas").style.transform =
    "translate(" + pvView.tx + "px," + pvView.ty + "px) scale(" + pvView.scale + ")";
}

function pvFit() {
  const wrap = $("preview-canvas-wrap");
  const s = Math.max(0.01, (wrap.clientWidth - 2) / PV.W);
  wrap.style.height = Math.ceil(PV.H * s + 2) + "px";
  pvView = { scale: s, tx: 0, ty: 0, fit: s };
  pvApply();
}

let pvPickLast = { x: -1, y: -1, cid: 0 };
function pvPickAt(clientX, clientY) {
  const boxes = document.elementsFromPoint(clientX, clientY)
    .filter((el) => el.classList && el.classList.contains("pv-box"))
    .sort((a, b) => a.offsetWidth * a.offsetHeight - b.offsetWidth * b.offsetHeight);
  if (!boxes.length) return;
  let pick = boxes[0];
  if (pvPickLast.x === clientX && pvPickLast.y === clientY) {
    const i = boxes.findIndex((el) => +el.dataset.cid === pvPickLast.cid);
    if (i >= 0) pick = boxes[(i + 1) % boxes.length];
  }
  pvPickLast = { x: clientX, y: clientY, cid: +pick.dataset.cid };
  previewSelect(pick.dataset.cid);
}

function renderPreview() {
  if (!PV || !PV.items.length) {
    $("preview-canvas").innerHTML = "";
    $("preview-info").innerHTML = PV ? '<p class="dim">no widget tree in this file</p>' : "";
    return;
  }
  const item = PV.items[+$("preview-item").value || 0];
  const W = PV.W, H = PV.H;
  const canvas = $("preview-canvas");
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  canvas.innerHTML = "";
  let count = 0;
  const place = (cid, px, py, pw, ph, depth) => {
    if (count > 5000 || depth > 40) return;
    const w = PV.widgets.get(cid);
    if (!w) return;
    count++;
    const a = ANCHORS[w.anchor] || ANCHORS.TopLeft;
    const stretchX = a[0] !== a[2], stretchY = a[1] !== a[3];
    let bw = stretchX ? Math.max(0, (a[2] - a[0]) * pw - (w.margin_l || 0) - (w.margin_r || 0))
                      : (w.size_x || (w.fit ? 0 : 0));
    let bh = stretchY ? Math.max(0, (a[3] - a[1]) * ph - (w.margin_t || 0) - (w.margin_b || 0))
                      : (w.size_y || (w.fit ? 0 : 0));
    let x = stretchX ? a[0] * pw + (w.margin_l || 0)
                     : a[0] * pw + ((a[0] === 1 ? -(w.margin_r || 0) : (w.margin_l || 0)))
                       - (w.anchor_x || 0) * bw;
    let y = stretchY ? a[1] * ph + (w.margin_t || 0)
                     : a[1] * ph + ((a[1] === 1 ? -(w.margin_b || 0) : (w.margin_t || 0)))
                       - (w.anchor_y || 0) * bh;
    x += (w.tr_x || 0);
    y += (w.tr_y || 0);
    if (!bw) bw = Math.min(pw, 24);
    if (!bh) bh = Math.min(ph, 24);

    const el = document.createElement("div");
    el.className = "pv-box" + (w.visible ? "" : " pv-hidden");
    el.style.left = (px + x) + "px";
    el.style.top = (py + y) + "px";
    el.style.width = bw + "px";
    el.style.height = bh + "px";
    el.style.borderColor = CLASS_COLOR[w.class] || "#555";
    el.dataset.cid = cid;
    if (bw > 50 && bh > 12) el.textContent = w.text || w.name || "";
    canvas.appendChild(el);

    const kids = PV.children.get(cid) || [];
    const cls = w.class || "";
    if (/HorizontalPanel/.test(cls) || /VerticalPanel/.test(cls) ||
        /UniformGrid/.test(cls) || cls === "inkGridWidget") {
      // stacked containers: run children along the axis with their margins,
      // an approximation of the panel layout the engine computes
      const horizontal = /HorizontalPanel/.test(cls);
      let cursor = 0;
      for (const kid of kids) {
        const kw = PV.widgets.get(kid);
        if (!kw) continue;
        const kx = horizontal ? cursor : 0;
        const ky = horizontal ? 0 : cursor;
        placeStacked(kid, px + x + kx, py + y + ky, bw, bh, depth + 1, horizontal,
          (advance) => { cursor += advance; });
      }
    } else {
      for (const kid of kids) place(kid, px + x, py + y, bw, bh, depth + 1);
    }
  };
  const placeStacked = (cid, px, py, pw, ph, depth, horizontal, advanced) => {
    const w = PV.widgets.get(cid);
    if (!w || count > 5000) return;
    count++;
    const bw = w.size_x || (horizontal ? 24 : pw);
    const bh = w.size_y || (horizontal ? ph : 24);
    const x = (w.margin_l || 0);
    const y = (w.margin_t || 0);
    const el = document.createElement("div");
    el.className = "pv-box" + (w.visible ? "" : " pv-hidden");
    el.style.left = (px + x) + "px";
    el.style.top = (py + y) + "px";
    el.style.width = bw + "px";
    el.style.height = bh + "px";
    el.style.borderColor = CLASS_COLOR[w.class] || "#555";
    el.dataset.cid = cid;
    if (bw > 50 && bh > 12) el.textContent = w.text || w.name || "";
    canvas.appendChild(el);
    advanced(horizontal ? bw + (w.margin_l || 0) + (w.margin_r || 0)
                        : bh + (w.margin_t || 0) + (w.margin_b || 0));
    for (const kid of (PV.children.get(cid) || [])) place2(kid, px + x, py + y, bw, bh, depth + 1);
  };
  const place2 = place;
  place(item.root_widget_cid, 0, 0, W, H, 0);

  pvFit();
  $("preview-info").innerHTML =
    '<p class="dim small">' + count + " boxes · authored at " + W + "×" + H +
    " (" + esc(PV.res) + ") · " + esc(PV.path) + " · click a box for details</p>";
}

function previewSelect(cid) {
  for (const el of document.querySelectorAll(".pv-box.pv-sel")) el.classList.remove("pv-sel");
  const box = document.querySelector('.pv-box[data-cid="' + cid + '"]');
  if (box) box.classList.add("pv-sel");
  const w = PV.widgets.get(+cid);
  if (!w) return;
  const fields = ["class", "name", "anchor", "halign", "valign", "size_x", "size_y",
    "margin_l", "margin_t", "margin_r", "margin_b", "fit", "visible", "text", "part", "atlas", "style", "state"];
  $("preview-info").innerHTML = '<div class="crumbs">' + chunkLink(w.cid, "open chunk #" + w.cid) +
    ' · <a href="#tree/' + w.cid + '">tree</a></div><table>' + fields
      .filter((f) => w[f] !== null && w[f] !== undefined && w[f] !== "")
      .map((f) => "<tr><th>" + f + "</th><td>" + esc(String(w[f])) + "</td></tr>").join("") +
    "</table>";
}

// Select a widget by cid whichever library item it sits in: the preview renders one
// item at a time, so the items are tried in turn until the box exists.
function previewSelectAny(cid) {
  if (!PV) return;
  const sel = $("preview-item");
  for (let i = 0; i < Math.max(1, sel.options.length); i++) {
    if (i > 0) { sel.value = String(i); renderPreview(); }
    if (document.querySelector('.pv-box[data-cid="' + cid + '"]')) { previewSelect(cid); return; }
  }
}

/* ------------------------------------------------------------------ tree -- */

// The tree walks the reference graph lazily: a node renders its children when it is
// opened, and each loader below is a few indexed queries, so a 4,000-chunk menu costs
// what the visitor opens rather than the whole file. A chunk opens into three groups:
// the widget children the engine walks (widget_tree), every other handle it holds
// grouped by field (refs), and every resource path it names (xrefs). A chunk of a
// class this page knows nothing about still appears under the field that holds it;
// nothing reachable is left out. A resolved path opens the file it names, so the walk
// crosses file boundaries downward; a file's "referenced by" crosses them upward.

const TREE_UP_FIELD = "parentWidget";   // a widget's back-reference to its own parent

function treeKey(kind, id) { return kind + ":" + id; }

function treeNodeHtml(kind, id, label, opts) {
  opts = opts || {};
  return '<div class="tn" data-k="' + esc(treeKey(kind, id)) + '" data-kind="' + kind +
    '" data-id="' + esc(String(id)) + '">' +
    '<div class="tn-row"><span class="tn-tog' + (opts.leaf ? " leaf" : "") + '">' +
    (opts.leaf ? "" : "&#9656;") + "</span>" +
    '<span class="tn-label">' + label + "</span>" +
    (opts.links ? '<span class="tn-links">' + opts.links + "</span>" : "") +
    '</div><div class="tn-kids" hidden></div></div>';
}

function treeGroup(title, inner) {
  return '<div class="tg"><div class="tg-h">' + title + "</div>" + inner + "</div>";
}

function treeFileLabel(f) {
  const b = basename(f.path);
  return '<span class="tn-file">' + esc(b) + '</span> <span class="path">' +
    esc(f.path.slice(0, f.path.length - b.length)) + "</span>";
}
function treeFileLinks(f) {
  return '<a href="#file/' + f.fid + '">record</a>' +
    (f.kind === "inkwidget" ? '<a href="#preview/' + f.fid + '">preview</a>' : "") +
    '<a href="#tree/file/' + f.fid + '">focus</a>';
}
function treeFileNode(f) {
  return treeNodeHtml("f", f.fid, treeFileLabel(f), { links: treeFileLinks(f) });
}

function treeChunkLabel(r) {
  return (r.name ? "<b>" + esc(r.name) + "</b> " : "") +
    '<span class="cls">' + esc(r.class || "?") + "</span>" +
    (r.n_kids ? ' <span class="tn-count">' + r.n_kids + "</span>" : "");
}
function treeChunkLinks(r) {
  return '<a href="#chunk/' + r.cid + '">#' + r.cid + "</a>" +
    (r.is_widget ? '<a href="#preview/' + r.fid + "/" + r.cid + '">preview</a>' : "") +
    '<a href="#tree/' + r.cid + '">focus</a>';
}
function treeChunkNode(r, opts) {
  return treeNodeHtml("c", r.cid, treeChunkLabel(r),
    { links: treeChunkLinks(r), leaf: opts && opts.leaf });
}

// Handles grouped by the field that holds them. The parent back-reference is shown
// as a leaf: opening it would only repeat the level above.
function treeRefGroups(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.field)) groups.set(r.field, []);
    groups.get(r.field).push(r);
  }
  let h = "";
  for (const [field, rs] of groups) {
    const up = field === TREE_UP_FIELD;
    h += treeGroup(esc(field) + (up ? ' <span class="dim">up</span>' : ""),
      rs.map((r) => treeChunkNode(r, { leaf: up })).join(""));
  }
  return h;
}

// Resource paths grouped by field. A path that names an archive file opens that
// file in place; any other path is shown as it is written.
async function treeXrefGroups(xs) {
  if (!xs.length) return "";
  const fids = [...new Set(xs.filter((x) => x.to_fid).map((x) => x.to_fid))];
  const files = new Map();
  if (fids.length) {
    const rows = await q("SELECT fid, path, kind FROM files WHERE fid IN (" +
      fids.map(() => "?").join(",") + ")", ...fids);
    for (const f of rows) files.set(f.fid, f);
  }
  const groups = new Map();
  xs.forEach((x, i) => {
    if (!groups.has(x.field)) groups.set(x.field, []);
    groups.get(x.field).push([x, i]);
  });
  let h = "";
  for (const [field, rs] of groups) {
    h += treeGroup(esc(field) + ' <span class="dim">resource</span>', rs.map(([x, i]) => {
      const f = files.get(x.to_fid);
      if (f) return treeFileNode(f);
      const why = /^\d+$/.test(x.to_path) ? "unresolved hash" : "outside the archive";
      return treeNodeHtml("x", i, '<span class="path">' + esc(x.to_path) +
        '</span> <span class="dim">' + why + "</span>", { leaf: true });
    }).join(""));
  }
  return h;
}

// A folder: its subfolders, then its files. The id is the folder path with its
// trailing backslash, "" for the root.
function treeDirNode(parent, name, files) {
  return treeNodeHtml("d", parent + name + "\\",
    '<span class="tn-dir">' + esc(name) + '</span> <span class="tn-count">' + files + "</span>");
}

async function treeKidsDir(parent) {
  const rows = await q(
    "SELECT name, fid, kind, files FROM dirs WHERE parent = ? ORDER BY fid IS NOT NULL, name", parent);
  return rows.map((r) => r.fid
    ? treeFileNode({ fid: r.fid, path: parent + r.name, kind: r.kind })
    : treeDirNode(parent, r.name, r.files)).join("") || '<p class="dim small">empty</p>';
}

async function treeKidsFile(fid) {
  const items = await q(
    "SELECT name, root_widget_cid, controller_cid, controller FROM items WHERE fid=? ORDER BY name", fid);
  const rootRefs = await q(
    "SELECT r.to_cid AS cid, r.field, r.ord, c.fid, c.class, c.name, (w.cid IS NOT NULL) AS is_widget, " +
    "(SELECT count(*) FROM widget_tree x WHERE x.parent_cid = r.to_cid) AS n_kids " +
    "FROM refs r INDEXED BY idx_refs_root JOIN chunks c ON c.cid = r.to_cid LEFT JOIN widgets w ON w.cid = r.to_cid " +
    "WHERE r.from_cid = 0 AND r.fid = ? ORDER BY r.field, r.ord", fid);
  const rootX = await q(
    "SELECT to_path, to_fid, field, ord FROM xrefs INDEXED BY idx_x_root " +
    "WHERE from_cid = 0 AND fid = ? ORDER BY field, ord", fid);
  // An item's root widget and controller are reached through the item; the same
  // handles appear in the root record and would otherwise show twice.
  const covered = new Set();
  let h = "";
  for (const it of items) {
    covered.add(it.root_widget_cid);
    covered.add(it.controller_cid);
    h += treeNodeHtml("i", fid + "/" + it.name,
      "<b>" + esc(it.name || "—") + '</b> <span class="dim">item</span>' +
      (it.controller ? ' · <span class="cls">' + esc(it.controller) + "</span>" : ""));
  }
  h += treeRefGroups(rootRefs.filter((r) => !covered.has(r.cid)));
  h += await treeXrefGroups(rootX);
  h += treeGroup("referenced by",
    treeNodeHtml("rb", fid, '<span class="dim">records in other files that name this one</span>'));
  return h;
}

async function treeKidsItem(fid, name) {
  const [it] = await q("SELECT root_widget_cid, controller_cid FROM items WHERE fid=? AND name=?", fid, name);
  if (!it) return '<p class="dim small">no such item</p>';
  const ids = [it.root_widget_cid, it.controller_cid].filter((x) => x);
  if (!ids.length) return '<p class="dim small">the item holds no chunks; its instance is inline in the file record</p>';
  const rows = await q(
    "SELECT c.cid, c.fid, c.class, c.name, (w.cid IS NOT NULL) AS is_widget, " +
    "(SELECT count(*) FROM widget_tree x WHERE x.parent_cid = c.cid) AS n_kids " +
    "FROM chunks c LEFT JOIN widgets w ON w.cid = c.cid WHERE c.cid IN (" +
    ids.map(() => "?").join(",") + ")", ...ids);
  const byId = new Map(rows.map((r) => [r.cid, r]));
  let h = "";
  if (byId.has(it.root_widget_cid)) h += treeGroup("rootWidget", treeChunkNode(byId.get(it.root_widget_cid)));
  if (byId.has(it.controller_cid)) h += treeGroup("gameController", treeChunkNode(byId.get(it.controller_cid)));
  return h;
}

async function treeKidsChunk(cid) {
  const kids = await q(
    "SELECT t.child_cid AS cid, w.fid, w.name, w.class, 1 AS is_widget, " +
    "(SELECT count(*) FROM widget_tree x WHERE x.parent_cid = t.child_cid) AS n_kids " +
    "FROM widget_tree t JOIN widgets w ON w.cid = t.child_cid WHERE t.parent_cid = ? ORDER BY t.ord", cid);
  const refs = await q(
    "SELECT r.to_cid AS cid, r.field, r.ord, c.fid, c.class, c.name, (w.cid IS NOT NULL) AS is_widget, " +
    "(SELECT count(*) FROM widget_tree x WHERE x.parent_cid = r.to_cid) AS n_kids " +
    "FROM refs r JOIN chunks c ON c.cid = r.to_cid LEFT JOIN widgets w ON w.cid = r.to_cid " +
    "WHERE r.from_cid = ? ORDER BY r.field, r.ord", cid);
  const xs = await q(
    "SELECT to_path, to_fid, field, ord FROM xrefs WHERE from_cid = ? ORDER BY field, ord", cid);
  let h = "";
  const rest = [];
  let container = null;
  for (const r of refs) {
    // widget_tree resolves the children handle through its inkMultiChildren chunk;
    // the group header keeps a link to that chunk so the hop is visible.
    if (kids.length && r.field === "children") container = r;
    else rest.push(r);
  }
  if (kids.length) {
    h += treeGroup("children" + (container ? " · " + chunkLink(container.cid, container.class) : ""),
      kids.map((r) => treeChunkNode(r)).join(""));
  }
  h += treeRefGroups(rest);
  h += await treeXrefGroups(xs);
  return h || '<p class="dim small">no references</p>';
}

async function treeKidsRefBy(fid) {
  const rows = await q(
    "SELECT x.fid, f.path, f.kind, count(*) AS n FROM xrefs x JOIN files f ON f.fid = x.fid " +
    "WHERE x.to_fid = ? GROUP BY x.fid ORDER BY f.path", fid);
  if (!rows.length) return '<p class="dim small">no other file names this one</p>';
  return rows.map((r) => treeNodeHtml("rf", fid + "/" + r.fid,
    treeFileLabel(r) + ' <span class="tn-count">' + r.n + "</span>", { links: treeFileLinks(r) })).join("");
}

async function treeKidsRefFrom(toFid, fromFid) {
  const rows = await q(
    "SELECT x.from_cid AS cid, x.field, c.fid, c.class, c.name, (w.cid IS NOT NULL) AS is_widget " +
    "FROM xrefs x LEFT JOIN chunks c ON c.cid = x.from_cid LEFT JOIN widgets w ON w.cid = x.from_cid " +
    "WHERE x.to_fid = ? AND x.fid = ? ORDER BY x.field, x.from_cid LIMIT 500", toFid, fromFid);
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.field)) groups.set(r.field, []);
    groups.get(r.field).push(r);
  }
  let h = "";
  for (const [field, rs] of groups) {
    h += treeGroup(esc(field), rs.map((r) => r.cid === 0
      ? treeNodeHtml("x", "root" + fromFid, '<span class="dim">file record</span>',
          { leaf: true, links: '<a href="#file/' + fromFid + '">record</a><a href="#tree/file/' + fromFid + '">focus</a>' })
      : treeChunkNode(r)).join(""));
  }
  return h + (rows.length === 500 ? '<p class="dim small">first 500 shown</p>' : "");
}

async function treeOpen(el) {
  const kids = el.querySelector(":scope > .tn-kids");
  const tog = el.querySelector(":scope > .tn-row > .tn-tog");
  if (tog.classList.contains("leaf")) return;
  if (el.dataset.loaded) {
    kids.hidden = !kids.hidden;
    tog.innerHTML = kids.hidden ? "&#9656;" : "&#9662;";
    return;
  }
  tog.innerHTML = "&#8230;";
  try {
    const kind = el.dataset.kind, id = el.dataset.id;
    let h = "";
    if (kind === "d") h = await treeKidsDir(id);
    else if (kind === "f") h = await treeKidsFile(+id);
    else if (kind === "c") h = await treeKidsChunk(+id);
    else if (kind === "i") { const i = id.indexOf("/"); h = await treeKidsItem(+id.slice(0, i), id.slice(i + 1)); }
    else if (kind === "rb") h = await treeKidsRefBy(+id);
    else if (kind === "rf") { const [a, b] = id.split("/"); h = await treeKidsRefFrom(+a, +b); }
    kids.innerHTML = h;
    el.dataset.loaded = "1";
    kids.hidden = false;
    tog.innerHTML = "&#9662;";
  } catch (e) {
    kids.innerHTML = '<p class="err">' + esc(String(e)) + "</p>";
    kids.hidden = false;
    tog.innerHTML = "&#9656;";
  }
}

function treeFind(el, key) {
  for (const n of el.querySelectorAll(".tn")) if (n.dataset.k === key) return n;
  return null;
}

// The path from a chunk up to its file: widget_tree parents first, then whichever
// record holds a handle to the chunk, a widget or the file root before anything
// else. A chunk shared by several holders gets one path here; the rest are listed
// on its record.
async function treeAncestors(cid) {
  const [c] = await q("SELECT cid, fid, chunk_id, class, name FROM chunks WHERE cid=?", cid);
  if (!c) return null;
  const chain = [cid];
  let cur = cid;
  for (let i = 0; i < 80; i++) {
    const up = await q("SELECT parent_cid FROM widget_tree WHERE child_cid=? LIMIT 1", cur);
    if (up.length) { cur = up[0].parent_cid; chain.unshift(cur); continue; }
    const rs = await q(
      "SELECT r.from_cid, (w.cid IS NOT NULL) AS is_widget FROM refs r LEFT JOIN widgets w ON w.cid = r.from_cid " +
      "WHERE r.to_cid=? AND r.field<>? LIMIT 20", cur, TREE_UP_FIELD);
    if (!rs.length) break;
    const pick = rs.find((r) => r.from_cid === 0) || rs.find((r) => r.is_widget) || rs[0];
    if (pick.from_cid === 0 || chain.includes(pick.from_cid)) break;
    cur = pick.from_cid;
    chain.unshift(cur);
  }
  return { fid: c.fid, chain: chain, focus: c };
}

async function treeAttach(el, cid) {
  // A chunk no record holds a handle to: shown at the level where it was expected.
  const [r] = await q(
    "SELECT c.cid, c.fid, c.class, c.name, (w.cid IS NOT NULL) AS is_widget FROM chunks c " +
    "LEFT JOIN widgets w ON w.cid = c.cid WHERE c.cid=?", cid);
  if (!r) return null;
  const kids = el.querySelector(":scope > .tn-kids");
  kids.insertAdjacentHTML("beforeend",
    treeGroup('<span class="dim">held by no record</span>', treeChunkNode(r)));
  return treeFind(el, treeKey("c", cid));
}

// The tree always starts at the archive root, so a file sits under its folders and
// "up" from any node ends at the top of the archive rather than at the file.
async function treeRoot(out) {
  out.innerHTML = '<div class="tree">' +
    treeNodeHtml("d", "", '<span class="tn-dir">archive</span>') + "</div>";
  const root = out.querySelector(".tn");
  await treeOpen(root);
  return root;
}

async function treeOpenPath(root, path) {
  let el = root;
  const parts = path.split("\\");
  let prefix = "";
  for (let i = 0; i < parts.length - 1; i++) {
    prefix += parts[i] + "\\";
    const n = treeFind(el, treeKey("d", prefix));
    if (!n) return el;
    await treeOpen(n);
    el = n;
  }
  return el;
}

async function viewTree(arg) {
  showTab("tree");
  const out = $("tree-content");
  if (!arg) {
    if (!out.querySelector(".tn")) await treeRoot(out);
    return;
  }
  out.innerHTML = '<p class="loading">loading…</p>';
  let fid, chain = [], focus = null;
  if (arg.startsWith("file/")) {
    fid = +arg.slice(5);
  } else {
    const anc = await treeAncestors(+arg);
    if (!anc) { out.innerHTML = '<p class="err">no chunk ' + esc(arg) + "</p>"; return; }
    fid = anc.fid; chain = anc.chain; focus = anc.focus;
  }
  const [f] = await q("SELECT fid, path, kind FROM files WHERE fid=?", fid);
  if (!f) { out.innerHTML = '<p class="err">no file ' + fid + "</p>"; return; }
  pushTrail("#tree/" + (focus ? focus.cid : "file/" + fid),
    "tree: " + (focus ? (focus.name || focus.class) + " [" + focus.chunk_id + "]" : basename(f.path)));
  $("tree-file").value = "";
  $("tree-suggest").innerHTML = "";
  const root = await treeRoot(out);
  out.insertAdjacentHTML("afterbegin", trailHtml());
  const dir = await treeOpenPath(root, f.path);
  let el = treeFind(dir, treeKey("f", f.fid));
  if (!el) { out.innerHTML += '<p class="err">' + esc(f.path) + " is not in the folder listing</p>"; return; }
  await treeOpen(el);
  if (!chain.length) {
    el.classList.add("tn-focus");
    el.scrollIntoView({ block: "center" });
    return;
  }
  const top = chain[0];
  const owners = await q(
    "SELECT name FROM items WHERE fid=? AND (root_widget_cid=? OR controller_cid=?)", fid, top, top);
  if (owners.length) {
    const n = treeFind(el, treeKey("i", fid + "/" + owners[0].name));
    if (n) { await treeOpen(n); el = n; }
  }
  for (const cid of chain) {
    let n = treeFind(el, treeKey("c", cid)) || await treeAttach(el, cid);
    if (!n) break;
    await treeOpen(n);
    el = n;
  }
  if (el.dataset.kind === "c" && +el.dataset.id === focus.cid) {
    el.classList.add("tn-focus");
    el.scrollIntoView({ block: "center" });
  }
}

async function treeSuggest(text) {
  const out = $("tree-suggest");
  if (!text.trim()) { out.innerHTML = ""; return; }
  const rows = await q("SELECT fid, path FROM files WHERE path LIKE ? ORDER BY path LIMIT 20",
    "%" + text.trim() + "%");
  out.innerHTML = rows.map((r) =>
    '<div><span class="link tree-pick" data-fid="' + r.fid + '">' + esc(r.path) + "</span></div>").join("");
}

/* ------------------------------------------------------------------ wire -- */

document.addEventListener("DOMContentLoaded", () => {
  boot();
  window.addEventListener("hashchange", route);

  for (const b of document.querySelectorAll("#tabs button")) {
    b.addEventListener("click", () => {
      TRAIL = [];
      location.hash = "#" + b.dataset.tab + (b.dataset.tab === "search" ? "" : "");
      if (b.dataset.tab === "search") { showTab("search"); }
      route();
    });
  }

  $("search-input").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      history.replaceState(null, "", "#search/" + encodeURIComponent(e.target.value));
      runSearch(e.target.value);
    }, 300);
  });

  $("browse-kind").addEventListener("change", runBrowse);
  let browseTimer = null;
  $("browse-filter").addEventListener("input", () => {
    clearTimeout(browseTimer);
    browseTimer = setTimeout(runBrowse, 300);
  });

  $("sql-run").addEventListener("click", runSql);
  $("sql-input").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runSql(); }
  });

  let pvTimer = null;
  $("preview-file").addEventListener("input", (e) => {
    clearTimeout(pvTimer);
    pvTimer = setTimeout(() => previewSuggest(e.target.value), 300);
  });
  $("preview-item").addEventListener("change", renderPreview);
  window.addEventListener("resize", () => { if (PV) renderPreview(); });

  let treeTimer = null;
  $("tree-file").addEventListener("input", (e) => {
    clearTimeout(treeTimer);
    treeTimer = setTimeout(() => treeSuggest(e.target.value), 300);
  });
  $("tree-content").addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const row = e.target.closest(".tn-row");
    if (row) treeOpen(row.parentElement);
  });

  initPresets();
  $("preset-select").addEventListener("change", presetChanged);
  $("preset-run").addEventListener("click", runPreset);
  for (const i of [0, 1]) {
    $("preset-p" + i).addEventListener("keydown", (e) => {
      if (e.key === "Enter") runPreset();
    });
  }

  document.body.addEventListener("click", (e) => {
    const ref = e.target.closest(".j-ref");
    if (ref) { openRef(+ref.dataset.fid, ref.dataset.ref); return; }
    const pl = e.target.closest(".pathlink");
    if (pl) { openPath(pl.dataset.path); return; }
    const pick = e.target.closest(".pv-pick");
    if (pick) { location.hash = "#preview/" + pick.dataset.fid; return; }
    const tp = e.target.closest(".tree-pick");
    if (tp) { location.hash = "#tree/file/" + tp.dataset.fid; return; }
  });

  const wrap = $("preview-canvas-wrap");
  wrap.addEventListener("wheel", (e) => {
    if (!pvView) return;
    e.preventDefault();
    const rect = wrap.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const f = Math.exp(-e.deltaY * 0.0015);
    const s = Math.min(4, Math.max(pvView.fit * 0.5, pvView.scale * f));
    const applied = s / pvView.scale;
    pvView.tx = px - (px - pvView.tx) * applied;
    pvView.ty = py - (py - pvView.ty) * applied;
    pvView.scale = s;
    pvApply();
  }, { passive: false });
  let drag = null;
  wrap.addEventListener("mousedown", (e) => {
    if (!pvView) return;
    drag = { x: e.clientX, y: e.clientY, tx: pvView.tx, ty: pvView.ty, moved: false };
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (drag.moved) {
      pvView.tx = drag.tx + dx;
      pvView.ty = drag.ty + dy;
      pvApply();
    }
  });
  window.addEventListener("mouseup", (e) => {
    if (!drag) return;
    const wasDrag = drag.moved;
    drag = null;
    if (!wasDrag && e.target.closest("#preview-canvas-wrap")) pvPickAt(e.clientX, e.clientY);
  });
  wrap.addEventListener("dblclick", () => { if (pvView) pvFit(); });
});
