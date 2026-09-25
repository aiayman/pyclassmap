#!/usr/bin/env node
// Dev helper (not shipped in the vsix): renders a real diagram to SVG using
// the same layout algorithm as the webview, for README screenshots.
//
//   node scripts/render_demo.js <root> <out.svg> [--focus <nodeId>]
//        [--kinds member,transient,...] [--docs] [--externals]

const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const { buildDiagramSvg } = require("../svggen");

const args = process.argv.slice(2);
const root = args[0];
const outFile = args[1];
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const focus = opt("--focus");
const kinds = (opt("--kinds") || "member,transient,received,calls").split(",");
const showDocs = args.includes("--docs");
const showExternals = args.includes("--externals");

const analyzer = path.join(__dirname, "..", "analyzer", "analyze.py");
const data = JSON.parse(cp.execFileSync("python3", [analyzer, root], { maxBuffer: 1 << 26 }));

// ---- mirror of media/diagram.js: visibleGraph ----
const enabled = new Set(kinds);
let edges = data.edges.filter(
  (e) =>
    enabled.has(e.kind) &&
    (showExternals || !data.nodes[e.dst] || data.nodes[e.dst].kind !== "external")
);
let ids;
if (focus) {
  if (!data.nodes[focus]) {
    console.error("focus id not found:", focus);
    process.exit(1);
  }
  ids = new Set([focus]);
  const stack = [focus];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of edges) {
      if (e.src === cur && !ids.has(e.dst)) {
        ids.add(e.dst);
        stack.push(e.dst);
      }
    }
  }
} else {
  ids = new Set();
  for (const e of edges) {
    ids.add(e.src);
    ids.add(e.dst);
  }
}
ids = Array.from(ids);
edges = edges.filter((e) => ids.includes(e.src) && ids.includes(e.dst));

const expanded = new Set(showDocs ? ids.filter((i) => data.nodes[i].doc) : []);
const shortName = (id) => data.nodes[id].name;

function docLines(n) {
  if (!n.doc) return [];
  const text = n.doc.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
  const words = text.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > 48) {
      lines.push(cur.trim());
      cur = w;
      if (lines.length === 7) {
        lines[6] = lines[6] + " ...";
        return lines;
      }
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ---- mirror of media/diagram.js: layout ----
const color = new Map();
const dagEdges = [];
const adj = new Map(ids.map((i) => [i, []]));
for (const e of edges) adj.get(e.src).push(e);
function dfs(u) {
  color.set(u, 1);
  for (const e of adj.get(u) || []) {
    const c = color.get(e.dst) || 0;
    if (c === 1) continue;
    dagEdges.push(e);
    if (c === 0) dfs(e.dst);
  }
  color.set(u, 2);
}
for (const i of ids) if (!(color.get(i) || 0)) dfs(i);
const out = new Map(ids.map((i) => [i, []]));
const indeg = new Map(ids.map((i) => [i, 0]));
for (const e of dagEdges) {
  out.get(e.src).push(e.dst);
  indeg.set(e.dst, indeg.get(e.dst) + 1);
}
const layer = new Map(ids.map((i) => [i, 0]));
const q = ids.filter((i) => indeg.get(i) === 0);
const indegC = new Map(indeg);
while (q.length) {
  const u = q.shift();
  for (const v of out.get(u)) {
    layer.set(v, Math.max(layer.get(v), layer.get(u) + 1));
    indegC.set(v, indegC.get(v) - 1);
    if (indegC.get(v) === 0) q.push(v);
  }
}
const layers = [];
for (const i of ids) {
  const l = layer.get(i);
  (layers[l] = layers[l] || []).push(i);
}
const pos = new Map();
layers.forEach((L) => L.forEach((id, idx) => pos.set(id, idx)));
const inn = new Map(ids.map((i) => [i, []]));
for (const e of dagEdges) inn.get(e.dst).push(e.src);
function bary(id, m) {
  const nb = m.get(id) || [];
  if (!nb.length) return pos.get(id);
  return nb.reduce((s, n) => s + pos.get(n), 0) / nb.length;
}
for (let pass = 0; pass < 4; pass++) {
  const src = pass % 2 === 0 ? inn : out;
  const order = pass % 2 === 0 ? layers : layers.slice().reverse();
  for (const L of order) {
    L.sort((a, b) => bary(a, src) - bary(b, src));
    L.forEach((id, idx) => pos.set(id, idx));
  }
}
const NODE_H = 30, GAP_Y = 26, GAP_X = 100, CHAR_W = 7.3, PAD_X = 22;
const DOC_CHAR_W = 5.6, DOC_LINE_H = 14;
const dims = (id) => {
  const n = data.nodes[id];
  const lines = expanded.has(id) ? docLines(n) : [];
  let w = shortName(id).length * CHAR_W + PAD_X * 2 + (n.doc ? 14 : 0);
  for (const ln of lines) w = Math.max(w, ln.length * DOC_CHAR_W + PAD_X * 2);
  const h = NODE_H + (lines.length ? lines.length * DOC_LINE_H + 10 : 0);
  return { w, h, lines };
};
const coords = new Map();
let x = 0;
layers.forEach((L) => {
  let maxW = 0, totalH = 0;
  const ds = new Map();
  for (const id of L) {
    const d = dims(id);
    ds.set(id, d);
    maxW = Math.max(maxW, d.w);
    totalH += d.h + GAP_Y;
  }
  let y = -totalH / 2;
  for (const id of L) {
    const d = ds.get(id);
    coords.set(id, { x: x, y: y, w: d.w, h: d.h, lines: d.lines });
    y += d.h + GAP_Y;
  }
  x += maxW + GAP_X;
});
let minY = Infinity;
coords.forEach((c) => (minY = Math.min(minY, c.y)));
coords.forEach((c) => (c.y -= minY - 10));

// ---- export ----
const payload = {
  nodes: ids.map((id) => {
    const c = coords.get(id);
    const n = data.nodes[id];
    return { id, name: n.name, kind: n.kind, x: c.x, y: c.y, w: c.w, h: c.h, lines: c.lines || [] };
  }),
  edges: edges.map((e) => ({ src: e.src, dst: e.dst, kind: e.kind, count: e.count })),
  kinds,
  externals: showExternals,
  focus: focus || null,
};
fs.writeFileSync(outFile, buildDiagramSvg(payload, path.basename(root)));
console.log(`${outFile}: ${ids.length} nodes, ${edges.length} edges`);
