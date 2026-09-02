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
    else if (what === "preview") { showTab("preview"); if (arg) await loadPreviewFile(+arg); }
    else if (what === "about") showTab("about");
    else {
      showTab("search");
      if (arg) { $("search-input").value = arg; await runSearch(arg); }
    }
  } catch (e) {
    console.error(e);
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
  try {
    const rows = await q(sql);
    const ms = Math.round(performance.now() - t0);
    status.textContent = rows.length + " rows · " + ms + " ms";
    if (!rows.length) { out.innerHTML = '<p class="dim">no rows</p>'; return; }
    const cols = Object.keys(rows[0]);
    out.innerHTML = table(rows.slice(0, 500), cols, (r, c) => {
      const v = r[c];
      if (v === null) return '<span class="dim">NULL</span>';
      if (c === "cid" && Number.isInteger(v) && v > 0) return chunkLink(v, v);
      if (c === "fid" && Number.isInteger(v)) return '<a href="#file/' + v + '">' + v + "</a>";
      const s = String(v);
      return esc(s.length > 400 ? s.slice(0, 400) + "…" : s);
    });
  } catch (e) {
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
  let h = '<div class="record">';
  h += '<div class="crumbs"><span class="cls">' + esc(f.class || f.kind) + "</span> · " +
    esc(f.path) + " · " + esc(f.source) + " · " + f.chunk_count + " chunks";
  if (f.kind === "inkwidget") h += ' · <a href="#preview/' + fid + '">preview layout</a>';
  h += "</div>";
  if (items.length) {
    h += "<h3>Library items</h3>" + table(items, ["name", "widget tree", "controller"], (r, c) => {
      if (c === "name") return esc(r.name || "—");
      if (c === "widget tree") return r.root_widget_cid ? chunkLink(r.root_widget_cid, "#" + r.root_widget_cid) : '<span class="dim">—</span>';
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
  const data = restore(JSON.parse(c.data));
  let h = '<div class="record">';
  h += '<div class="crumbs">' + fileLink(c.fid, c.path) + " · chunk <b>" + esc(c.chunk_id) +
    '</b> · <span class="cls">' + esc(c.class) + "</span>" +
    (c.name ? " · " + esc(c.name) : "") + "</div>";
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
  const [f] = await q("SELECT path FROM files WHERE fid=?", fid);
  const wmap = new Map();
  for (const w of widgets) wmap.set(w.cid, w);
  const children = new Map();
  for (const e of edges) {
    if (!children.has(e.parent_cid)) children.set(e.parent_cid, []);
    children.get(e.parent_cid).push(e.child_cid);
  }
  PV = { fid: fid, widgets: wmap, children: children, items: items, path: f ? f.path : "" };
  $("preview-file").value = PV.path;
  const sel = $("preview-item");
  sel.innerHTML = items.map((it, i) =>
    '<option value="' + i + '">' + esc(it.name || "item " + i) + "</option>").join("");
  sel.hidden = items.length < 2;
  renderPreview();
}

function renderPreview() {
  if (!PV || !PV.items.length) {
    $("preview-canvas").innerHTML = "";
    $("preview-info").innerHTML = PV ? '<p class="dim">no widget tree in this file</p>' : "";
    return;
  }
  const item = PV.items[+$("preview-item").value || 0];
  const [W, H] = $("preview-res").value.split("x").map(Number);
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

  const wrap = $("preview-canvas-wrap");
  const scale = Math.min(1, (wrap.clientWidth - 2) / W);
  canvas.style.transform = "scale(" + scale + ")";
  wrap.style.height = Math.ceil(H * scale + 2) + "px";
  $("preview-info").innerHTML =
    '<p class="dim small">' + count + " boxes · " + esc(PV.path) +
    " · click a box for details</p>";
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
    "</div><table>" + fields
      .filter((f) => w[f] !== null && w[f] !== undefined && w[f] !== "")
      .map((f) => "<tr><th>" + f + "</th><td>" + esc(String(w[f])) + "</td></tr>").join("") +
    "</table>";
}

/* ------------------------------------------------------------------ wire -- */

document.addEventListener("DOMContentLoaded", () => {
  boot();
  window.addEventListener("hashchange", route);

  for (const b of document.querySelectorAll("#tabs button")) {
    b.addEventListener("click", () => {
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
  $("preview-res").addEventListener("change", renderPreview);
  window.addEventListener("resize", () => { if (PV) renderPreview(); });

  document.body.addEventListener("click", (e) => {
    const ref = e.target.closest(".j-ref");
    if (ref) { openRef(+ref.dataset.fid, ref.dataset.ref); return; }
    const pl = e.target.closest(".pathlink");
    if (pl) { openPath(pl.dataset.path); return; }
    const pick = e.target.closest(".pv-pick");
    if (pick) { location.hash = "#preview/" + pick.dataset.fid; return; }
    const box = e.target.closest(".pv-box");
    if (box) { previewSelect(box.dataset.cid); return; }
  });
});
