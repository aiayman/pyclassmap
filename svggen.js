"use strict";
// Standalone SVG export of the class-map diagram. Mirrors pdfgen.js layout:
// header, always-complete legend, then the graph. Print-styled (white
// background, no VS Code theme variables) so the file works anywhere.

const { KIND_COLOR, KIND_DASH, KIND_LABEL, LEGEND } = require("./pdfgen");

const SANS = "Helvetica, Arial, sans-serif";
const MONO = "'Courier New', Courier, monospace";
const GRAY = "#6b6b6b";
const DARK = "#1a1a1a";

function col(rgb) {
  return `rgb(${rgb.map((v) => Math.round(v * 255)).join(",")})`;
}
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function dashAttr(kind) {
  return KIND_DASH[kind] ? ` stroke-dasharray="${KIND_DASH[kind].join(",")}"` : "";
}
function text(x, y, str, { size = 9, family = SANS, fill = DARK, anchor = "start", weight = "", style = "" } = {}) {
  return (
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${family}" font-size="${size}"` +
    ` fill="${fill}" text-anchor="${anchor}"` +
    (weight ? ` font-weight="${weight}"` : "") +
    (style ? ` font-style="${style}"` : "") +
    `>${esc(str)}</text>`
  );
}
function arrowHead(tipX, tipY, dirX, dirY, kind) {
  const len = Math.hypot(dirX, dirY) || 1;
  const ux = dirX / len, uy = dirY / len;
  const px = -uy, py = ux;
  const size = kind === "inherits" ? 9 : 7.5;
  const half = kind === "inherits" ? 4.5 : 3.2;
  const bx = tipX - ux * size, by = tipY - uy * size;
  const pts = [
    [tipX, tipY],
    [bx + px * half, by + py * half],
    [bx - px * half, by - py * half],
  ]
    .map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`)
    .join(" ");
  const c = col(KIND_COLOR[kind]);
  const fill = kind === "inherits" ? "#ffffff" : c;
  return `<polygon points="${pts}" fill="${fill}" stroke="${c}" stroke-width="1"/>`;
}

function buildDiagramSvg(payload, projectName) {
  const nodes = payload.nodes || [];
  const edges = payload.edges || [];
  const kinds = payload.kinds || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  if (!nodes.length) {
    minX = minY = 0;
    maxX = 500;
    maxY = 40;
  }

  const margin = 40;
  const legendW = 520;
  const legendH = 10 + 14 + LEGEND.length * 15 + 16 + 8;
  const legendTop = 62;
  const arcPad = 60;
  const graphTop = legendTop + legendH + arcPad;
  const pageW = Math.max(maxX - minX + 2 * margin, legendW + 2 * margin);
  const pageH = graphTop + (maxY - minY) + margin;

  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pageW.toFixed(0)}" height="${pageH.toFixed(0)}"` +
      ` viewBox="0 0 ${pageW.toFixed(0)} ${pageH.toFixed(0)}">`
  );
  out.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);

  // ---- header ----
  out.push(text(margin, 34, "Python Class Map", { size: 15, weight: "bold" }));
  const focusNote = payload.focus ? ` - focused on ${payload.focus.split(".").pop()}` : "";
  const extNote =
    payload.externals === false && kinds.includes("inherits") ? " - external bases hidden" : "";
  const shown = kinds.map((k) => KIND_LABEL[k]).join(", ") || "none";
  out.push(
    text(margin, 50, `${projectName} - ${new Date().toISOString().slice(0, 10)} - showing: ${shown}${extNote}${focusNote}`, {
      fill: GRAY,
    })
  );

  // ---- legend (always complete: all five kinds) ----
  out.push(
    `<rect x="${margin}" y="${legendTop}" width="${legendW}" height="${legendH}" rx="4"` +
      ` fill="#f7f7f7" stroke="#bfbfbf" stroke-width="0.8"/>`
  );
  out.push(text(margin + 12, legendTop + 16, "Legend - relationship kinds", { weight: "bold" }));
  LEGEND.forEach(([kind, desc], i) => {
    const y = legendTop + 30 + i * 15;
    const c = col(KIND_COLOR[kind]);
    out.push(
      `<line x1="${margin + 12}" y1="${y - 3}" x2="${margin + 46}" y2="${y - 3}"` +
        ` stroke="${c}" stroke-width="1.4"${dashAttr(kind)}/>`
    );
    out.push(arrowHead(margin + 52, y - 3, 1, 0, kind));
    out.push(text(margin + 62, y, KIND_LABEL[kind], { fill: c, weight: "bold" }));
    const off = kinds.includes(kind) ? "" : "  (hidden in this view)";
    out.push(text(margin + 152, y, desc + off, { size: 8.5, fill: off ? GRAY : "#404040" }));
  });
  out.push(
    text(margin + 12, legendTop + 30 + LEGEND.length * 15 + 2,
      "Nodes: square corners = class, pill = function, dashed border = module, dotted = external",
      { size: 8.5, fill: GRAY })
  );

  // ---- graph ----
  const tx = margin - minX;
  const ty = graphTop - minY;

  for (const e of edges) {
    const a = byId.get(e.src), b = byId.get(e.dst);
    if (!a || !b) continue;
    const x1 = a.x + a.w + tx, y1 = a.y + 15 + ty;
    const x2 = b.x + tx, y2 = b.y + 15 + ty;
    const back = x2 <= x1;
    const c = col(KIND_COLOR[e.kind]);
    let d;
    if (!back) {
      const mx = (x1 + x2) / 2;
      d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${mx.toFixed(1)} ${y1.toFixed(1)}, ${mx.toFixed(1)} ${y2.toFixed(1)}, ${(x2 - 6).toFixed(1)} ${y2.toFixed(1)}`;
    } else {
      d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + 60).toFixed(1)} ${(y1 - 50).toFixed(1)}, ${(x2 - 60).toFixed(1)} ${(y2 - 50).toFixed(1)}, ${(x2 - 6).toFixed(1)} ${y2.toFixed(1)}`;
    }
    out.push(`<path d="${d}" fill="none" stroke="${c}" stroke-width="1.1"${dashAttr(e.kind)}/>`);
    out.push(back ? arrowHead(x2 - 1, y2, 54, 50, e.kind) : arrowHead(x2 - 1, y2, 1, 0, e.kind));
    if (e.count > 1 && !back) {
      out.push(text(x2 - 10, y2 - 5, `x${e.count}`, { size: 8, fill: c, anchor: "end" }));
    }
  }

  for (const n of nodes) {
    const x = n.x + tx, y = n.y + ty;
    const focused = n.id === payload.focus;
    const light = n.kind === "external";
    const stroke = light ? "#999999" : "#595959";
    const dash = n.kind === "module" ? ` stroke-dasharray="4,2"` : light ? ` stroke-dasharray="2,2"` : "";
    out.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${n.w.toFixed(1)}" height="${n.h.toFixed(1)}"` +
        ` rx="${n.kind === "class" ? 4 : 14}" fill="#ffffff" stroke="${stroke}"` +
        ` stroke-width="${focused ? 2.2 : 1.1}"${dash}/>`
    );
    out.push(text(x + n.w / 2, y + 19, n.name, { size: 12, family: MONO, anchor: "middle" }));
    (n.lines || []).forEach((ln, i) => {
      out.push(text(x + 11, y + 42 + i * 14, ln, { size: 10, fill: GRAY, style: "italic" }));
    });
  }

  out.push("</svg>");
  return out.join("\n");
}

module.exports = { buildDiagramSvg };
