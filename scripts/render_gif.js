#!/usr/bin/env node
// Dev helper (not shipped): renders animated GIFs of the interactive
// features, styled like the dark-theme webview, from the demo project.
// Needs ImageMagick `convert` on PATH.
//
//   node scripts/render_gif.js <root> <outDir>

const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadGraph, computeView } = require("./layout");

const ROOT = process.argv[2] || "demo";
const OUT = process.argv[3] || "images";

const KIND_COLOR = {
  member: "#e5534b", transient: "#d29922", received: "#3fb950",
  calls: "#58a6ff", inherits: "#bc8cff",
};
const KIND_DASH = { received: "5,3", calls: "2,3" };
const KIND_LABEL = {
  member: "creates (member)", transient: "creates", received: "holds",
  calls: "calls", inherits: "inherits",
};
const ALL = ["member", "transient", "received", "calls", "inherits"];
const BG = "#1e1e1e", PANEL = "#252526", FG = "#d4d4d4", MUTED = "#8b8b8b", LINE = "#3c3c3c";
const TOOLBAR_H = 34;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function arrow(tipX, tipY, dx, dy, kind) {
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len, px = -uy, py = ux;
  const size = kind === "inherits" ? 9 : 7.5, half = kind === "inherits" ? 4.5 : 3.2;
  const bx = tipX - ux * size, by = tipY - uy * size;
  const pts = [[tipX, tipY], [bx + px * half, by + py * half], [bx - px * half, by - py * half]]
    .map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  return `<polygon points="${pts}" fill="${kind === "inherits" ? BG : KIND_COLOR[kind]}" stroke="${KIND_COLOR[kind]}" stroke-width="1"/>`;
}

// frame = { nodes, edges, kinds, root, caption, highlightKind }
function renderFrame(frame, W, H, originX, originY) {
  const o = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  o.push(`<rect width="100%" height="100%" fill="${BG}"/>`);

  // ---- toolbar: the real controls, in their current state ----
  o.push(`<rect x="0" y="0" width="${W}" height="${TOOLBAR_H}" fill="${PANEL}"/>`);
  o.push(`<line x1="0" y1="${TOOLBAR_H}" x2="${W}" y2="${TOOLBAR_H}" stroke="${LINE}"/>`);
  let x = 14;
  for (const k of ALL) {
    const on = frame.kinds.includes(k);
    const hot = frame.highlightKind === k;
    o.push(`<rect x="${x}" y="${TOOLBAR_H / 2 - 5}" width="10" height="10" rx="2" fill="${on ? KIND_COLOR[k] : "none"}" stroke="${on ? KIND_COLOR[k] : MUTED}" stroke-width="${hot ? 2 : 1}"/>`);
    o.push(`<text x="${x + 16}" y="${TOOLBAR_H / 2 + 4}" font-family="Helvetica,Arial,sans-serif" font-size="11" fill="${on ? KIND_COLOR[k] : MUTED}">${esc(KIND_LABEL[k])}</text>`);
    x += 26 + KIND_LABEL[k].length * 6.1;
  }
  if (frame.root) {
    const label = "\u{1F4C1} " + frame.root;
    const w = label.length * 6.6 + 16;
    o.push(`<rect x="${W - w - 14}" y="${TOOLBAR_H / 2 - 9}" width="${w}" height="18" rx="3" fill="#4453"/>`);
    o.push(`<text x="${W - w - 6}" y="${TOOLBAR_H / 2 + 4}" font-family="monospace" font-size="11" fill="${FG}">${esc(label)}</text>`);
  }
  if (frame.caption) {
    o.push(`<text x="14" y="${H - 14}" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="${MUTED}">${esc(frame.caption)}</text>`);
  }

  // ---- graph ----
  const byId = new Map(frame.nodes.map((n) => [n.id, n]));
  const tx = -originX + 30, ty = -originY + TOOLBAR_H + 26;
  for (const e of frame.edges) {
    const a = byId.get(e.src), b = byId.get(e.dst);
    if (!a || !b) continue;
    const x1 = a.x + a.w + tx, y1 = a.y + 15 + ty, x2 = b.x + tx, y2 = b.y + 15 + ty;
    const back = x2 <= x1;
    const d = back
      ? `M ${x1} ${y1} C ${x1 + 60} ${y1 - 50}, ${x2 - 60} ${y2 - 50}, ${x2 - 6} ${y2}`
      : `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2 - 6} ${y2}`;
    const dash = KIND_DASH[e.kind] ? ` stroke-dasharray="${KIND_DASH[e.kind]}"` : "";
    o.push(`<path d="${d}" fill="none" stroke="${KIND_COLOR[e.kind]}" stroke-width="1.4" opacity="0.9"${dash}/>`);
    o.push(back ? arrow(x2 - 1, y2, 54, 50, e.kind) : arrow(x2 - 1, y2, 1, 0, e.kind));
  }
  for (const n of frame.nodes) {
    const nx = n.x + tx, ny = n.y + ty;
    const stroke = n.kind === "class" ? "#58a6ff" : n.kind === "function" ? "#bc8cff"
      : n.kind === "module" ? "#d29922" : "#888";
    const dash = n.kind === "module" ? ' stroke-dasharray="4,2"' : n.kind === "external" ? ' stroke-dasharray="2,2"' : "";
    const focused = n.id === frame.focus;
    o.push(`<rect x="${nx.toFixed(1)}" y="${ny.toFixed(1)}" width="${n.w.toFixed(1)}" height="${n.h.toFixed(1)}" rx="${n.kind === "class" ? 4 : 14}" fill="${PANEL}" stroke="${stroke}" stroke-width="${focused ? 2.4 : 1.2}"${dash}/>`);
    o.push(`<text x="${(nx + n.w / 2).toFixed(1)}" y="${(ny + 19).toFixed(1)}" text-anchor="middle" font-family="monospace" font-size="12" fill="${FG}">${esc(n.name)}</text>`);
    (n.lines || []).forEach((ln, i) => {
      o.push(`<text x="${(nx + 11).toFixed(1)}" y="${(ny + 42 + i * 14).toFixed(1)}" font-family="Helvetica,Arial,sans-serif" font-size="10" font-style="italic" fill="${MUTED}">${esc(ln)}</text>`);
    });
  }
  o.push("</svg>");
  return o.join("\n");
}

function build(name, frames, delays) {
  // one canvas for every frame, or the GIF jitters
  let maxX = 0, maxY = 0, minX = Infinity, minY = Infinity;
  for (const f of frames) {
    for (const n of f.nodes) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
    }
  }
  const W = Math.ceil(maxX - minX) + 60;
  const H = Math.ceil(maxY - minY) + TOOLBAR_H + 62;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pcmgif-"));
  const pngs = [];
  frames.forEach((f, i) => {
    const svg = path.join(tmp, `f${String(i).padStart(2, "0")}.svg`);
    const png = svg.replace(/\.svg$/, ".png");
    fs.writeFileSync(svg, renderFrame(f, W, H, minX, minY));
    cp.execFileSync("convert", ["-density", "96", "-background", BG, svg, "-flatten", "-alpha", "off", png]);
    pngs.push(png);
  });
  // full-frame replacement: no -layers optimize, or frames ghost onto each other
  const args = ["-loop", "0", "-dispose", "Background"];
  pngs.forEach((p, i) => args.push("-delay", String(delays[i] ?? 120), p));
  const out = path.join(OUT, name);
  args.push(out);
  cp.execFileSync("convert", args);
  fs.rmSync(tmp, { recursive: true, force: true });
  const kb = (fs.statSync(out).size / 1024).toFixed(0);
  console.log(`${out}: ${frames.length} frames, ${W}x${H}, ${kb} KB`);
}

// ---------------------------------------------------------------- scenarios

const data = loadGraph(ROOT);
const TRACKER = "expense_tracker.tracker.ExpenseTracker";
const STORE = "expense_tracker.storage.JsonStore";
const rootName = path.basename(path.resolve(ROOT));
const mk = (o) => computeView({ data, showExternals: false, ...o });

// 1) filtering: relationship kinds switched on one at a time
{
  const steps = [
    { kinds: ["transient"], cap: "creates — objects built on the fly" },
    { kinds: ["transient", "member"], cap: "+ creates (member) — instances stored on self" },
    { kinds: ["transient", "member", "received"], cap: "+ holds — injected or declared as a field" },
    { kinds: ["transient", "member", "received", "calls"], cap: "+ calls — into functions that create" },
    { kinds: ["transient", "member", "received", "calls", "inherits"], cap: "+ inherits — your own class hierarchy" },
  ];
  const frames = steps.map((s, i) => {
    const v = mk({ kinds: s.kinds, focus: TRACKER });
    return { nodes: v.nodes, edges: v.edges, kinds: s.kinds, focus: TRACKER,
             root: rootName, caption: s.cap, highlightKind: i ? s.kinds[s.kinds.length - 1] : null };
  });
  build("filtering.gif", frames, [140, 140, 140, 140, 320]);
}

// 2) docstrings expanding in place
{
  const kinds = ["member", "transient", "received", "calls", "inherits"];
  const v0 = mk({ kinds, focus: STORE, expanded: null });
  const v1 = mk({ kinds, focus: STORE, expanded: "all" });
  const frames = [
    { nodes: v0.nodes, edges: v0.edges, kinds, focus: STORE, root: rootName, caption: "click ▸ to read the docstring in place" },
    { nodes: v1.nodes, edges: v1.edges, kinds, focus: STORE, root: rootName, caption: "docstrings expanded — layout reflows around them" },
  ];
  build("docstrings.gif", frames, [200, 380]);
}

// 3) focus: whole project down to one subtree
{
  const kinds = ["member", "transient", "received", "calls", "inherits"];
  const vAll = mk({ kinds, focus: null });
  const vTracker = mk({ kinds, focus: TRACKER });
  const vStore = mk({ kinds, focus: STORE });
  const frames = [
    { nodes: vAll.nodes, edges: vAll.edges, kinds, root: rootName, caption: "whole project" },
    { nodes: vTracker.nodes, edges: vTracker.edges, kinds, focus: TRACKER, root: rootName, caption: "Show Diagram from Here → ExpenseTracker" },
    { nodes: vStore.nodes, edges: vStore.edges, kinds, focus: STORE, root: rootName, caption: "→ JsonStore" },
  ];
  build("focus.gif", frames, [260, 260, 260]);
}
