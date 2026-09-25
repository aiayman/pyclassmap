"use strict";
// Minimal vector PDF writer for the class-map diagram. No dependencies.
// Emits PDF 1.4 with the standard base-14 fonts, so nothing is embedded.

const KIND_COLOR = {
  member: [0.84, 0.27, 0.25],
  transient: [0.72, 0.53, 0.08],
  received: [0.18, 0.64, 0.31],
  calls: [0.19, 0.43, 0.8],
  inherits: [0.51, 0.34, 0.87],
};
const KIND_DASH = { received: [5, 3], calls: [2, 3] };
const KIND_LABEL = {
  member: "creates (member)",
  transient: "creates",
  received: "holds",
  calls: "calls",
  inherits: "inherits",
};
const LEGEND = [
  ["member", "self.attr = Foo() - the instance is stored on the object (owned for its lifetime)"],
  ["transient", "Foo() on the fly in a method or function body - not stored on self"],
  ["received", "typed __init__ param or class field - holds an instance it did not create"],
  ["calls", "calls a project function that (transitively) creates instances"],
  ["inherits", "subclassing (is-a) - drawn with a hollow triangle arrowhead"],
];
const GRAY = [0.42, 0.42, 0.42];
const DARK = [0.1, 0.1, 0.1];

class PdfBuilder {
  constructor(w, h) {
    this.W = w;
    this.H = h;
    this.ops = [];
  }
  fy(y) {
    return (this.H - y).toFixed(2);
  }
  esc(s) {
    let out = "";
    for (const ch of String(s)) {
      let c = ch.charCodeAt(0);
      if (c > 255) c = 63; // '?': base fonts are Latin-1 only
      const chr = String.fromCharCode(c);
      if (chr === "(" || chr === ")" || chr === "\\") out += "\\" + chr;
      else if (c < 32) out += " ";
      else out += chr;
    }
    return out;
  }
  push(s) {
    this.ops.push(s);
  }
  stroke(rgb, width, dash) {
    this.push(
      `${rgb.map((v) => v.toFixed(3)).join(" ")} RG ${width} w ` +
        (dash ? `[${dash.join(" ")}] 0 d` : "[] 0 d")
    );
  }
  // y is the text baseline in top-down page coordinates
  text(x, y, str, font, size, rgb, anchor) {
    const em = font === "F1" ? 0.6 : 0.5;
    let tx = x;
    if (anchor === "middle") tx = x - (em * size * str.length) / 2;
    if (anchor === "end") tx = x - em * size * str.length;
    this.push(
      `BT /${font} ${size} Tf ${rgb.map((v) => v.toFixed(3)).join(" ")} rg ` +
        `${tx.toFixed(2)} ${this.fy(y)} Td (${this.esc(str)}) Tj ET`
    );
  }
  line(x1, y1, x2, y2) {
    this.push(`${x1.toFixed(2)} ${this.fy(y1)} m ${x2.toFixed(2)} ${this.fy(y2)} l S`);
  }
  bezier(x1, y1, c1x, c1y, c2x, c2y, x2, y2) {
    this.push(
      `${x1.toFixed(2)} ${this.fy(y1)} m ` +
        `${c1x.toFixed(2)} ${this.fy(c1y)} ${c2x.toFixed(2)} ${this.fy(c2y)} ` +
        `${x2.toFixed(2)} ${this.fy(y2)} c S`
    );
  }
  // pts: [[x,y],...] top-down coords. mode: "f" fill, "B" fill+stroke
  poly(pts, fillRgb, mode) {
    if (fillRgb) this.push(`${fillRgb.map((v) => v.toFixed(3)).join(" ")} rg`);
    const cmds = pts.map(
      (p, i) => `${p[0].toFixed(2)} ${this.fy(p[1])} ${i === 0 ? "m" : "l"}`
    );
    this.push(cmds.join(" ") + " h " + mode);
  }
  roundRect(x, y, w, h, r, fillRgb, mode) {
    const k = 0.5523 * r;
    if (fillRgb) this.push(`${fillRgb.map((v) => v.toFixed(3)).join(" ")} rg`);
    const Y = (v) => this.fy(v);
    const F = (v) => v.toFixed(2);
    this.push(
      [
        `${F(x + r)} ${Y(y)} m`,
        `${F(x + w - r)} ${Y(y)} l`,
        `${F(x + w - r + k)} ${Y(y)} ${F(x + w)} ${Y(y + r - k)} ${F(x + w)} ${Y(y + r)} c`,
        `${F(x + w)} ${Y(y + h - r)} l`,
        `${F(x + w)} ${Y(y + h - r + k)} ${F(x + w - r + k)} ${Y(y + h)} ${F(x + w - r)} ${Y(y + h)} c`,
        `${F(x + r)} ${Y(y + h)} l`,
        `${F(x + r - k)} ${Y(y + h)} ${F(x)} ${Y(y + h - r + k)} ${F(x)} ${Y(y + h - r)} c`,
        `${F(x)} ${Y(y + r)} l`,
        `${F(x)} ${Y(y + r - k)} ${F(x + r - k)} ${Y(y)} ${F(x + r)} ${Y(y)} c`,
        `h ${mode}`,
      ].join(" ")
    );
  }
  build() {
    const content = this.ops.join("\n");
    const objs = [
      null,
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.W.toFixed(2)} ${this.H.toFixed(2)}] ` +
        "/Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R /F4 8 0 R >> >> /Contents 4 0 R >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      font("Courier"),
      font("Helvetica"),
      font("Helvetica-Bold"),
      font("Helvetica-Oblique"),
    ];
    let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
    const offsets = [0];
    for (let i = 1; i < objs.length; i++) {
      offsets[i] = out.length;
      out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < objs.length; i++) {
      out += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
    }
    out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, "latin1");

    function font(name) {
      return `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`;
    }
  }
}

function arrowHead(pdf, tipX, tipY, dirX, dirY, kind) {
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
  ];
  pdf.stroke(KIND_COLOR[kind], 1, null);
  pdf.poly(pts, kind === "inherits" ? [1, 1, 1] : KIND_COLOR[kind], kind === "inherits" ? "B" : "f");
}

function buildDiagramPdf(payload, projectName) {
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
  const arcPad = 60; // cycle-edge arcs rise above the nodes
  const graphTop = legendTop + legendH + arcPad;
  const pageW = Math.max(maxX - minX + 2 * margin, legendW + 2 * margin);
  const pageH = graphTop + (maxY - minY) + margin;
  const pdf = new PdfBuilder(pageW, pageH);

  // ---- header ----
  pdf.text(margin, 34, "Python Class Map", "F3", 15, DARK);
  const focusNote = payload.focus ? ` - focused on ${payload.focus.split(".").pop()}` : "";
  const extNote =
    payload.externals === false && kinds.includes("inherits") ? " - external bases hidden" : "";
  const shown = kinds.map((k) => KIND_LABEL[k]).join(", ") || "none";
  pdf.text(
    margin, 50,
    `${projectName} - ${new Date().toISOString().slice(0, 10)} - showing: ${shown}${extNote}${focusNote}`,
    "F2", 9, GRAY
  );

  // ---- legend (always complete: all five kinds) ----
  pdf.stroke([0.75, 0.75, 0.75], 0.8, null);
  pdf.roundRect(margin, legendTop, legendW, legendH, 4, [0.97, 0.97, 0.97], "B");
  pdf.text(margin + 12, legendTop + 16, "Legend - relationship kinds", "F3", 9, DARK);
  LEGEND.forEach(([kind, desc], i) => {
    const y = legendTop + 30 + i * 15;
    pdf.stroke(KIND_COLOR[kind], 1.4, KIND_DASH[kind] || null);
    pdf.line(margin + 12, y - 3, margin + 46, y - 3);
    arrowHead(pdf, margin + 52, y - 3, 1, 0, kind);
    pdf.text(margin + 62, y, KIND_LABEL[kind], "F3", 9, KIND_COLOR[kind]);
    const off = kinds.includes(kind) ? "" : "  (hidden in this view)";
    pdf.text(margin + 152, y, desc + off, "F2", 8.5, off ? GRAY : [0.25, 0.25, 0.25]);
  });
  pdf.text(
    margin + 12, legendTop + 30 + LEGEND.length * 15 + 2,
    "Nodes: square corners = class, pill = function, dashed border = module, dotted = external",
    "F2", 8.5, GRAY
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
    pdf.stroke(KIND_COLOR[e.kind], 1.1, KIND_DASH[e.kind] || null);
    if (!back) {
      const mx = (x1 + x2) / 2;
      pdf.bezier(x1, y1, mx, y1, mx, y2, x2 - 6, y2);
      arrowHead(pdf, x2 - 1, y2, 1, 0, e.kind);
    } else {
      pdf.bezier(x1, y1, x1 + 60, y1 - 50, x2 - 60, y2 - 50, x2 - 6, y2);
      arrowHead(pdf, x2 - 1, y2, 54, 50, e.kind);
    }
    if (e.count > 1 && !back) {
      pdf.text(x2 - 10, y2 - 5, `x${e.count}`, "F2", 7, KIND_COLOR[e.kind], "end");
    }
  }

  for (const n of nodes) {
    const x = n.x + tx, y = n.y + ty;
    const focused = n.id === payload.focus;
    const light = n.kind === "external";
    pdf.stroke(light ? [0.6, 0.6, 0.6] : [0.35, 0.35, 0.35], focused ? 2.2 : 1.1,
      n.kind === "module" ? [4, 2] : light ? [2, 2] : null);
    pdf.roundRect(x, y, n.w, n.h, n.kind === "class" ? 4 : 14, [1, 1, 1], "B");
    pdf.text(x + n.w / 2, y + 19, n.name, "F1", 11, DARK, "middle");
    (n.lines || []).forEach((ln, i) => {
      pdf.text(x + 11, y + 42 + i * 14, ln, "F4", 9, GRAY);
    });
  }

  return pdf.build();
}

module.exports = { buildDiagramPdf, KIND_COLOR, KIND_DASH, KIND_LABEL, LEGEND };
