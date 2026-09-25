// Python Class Map — diagram webview. No external libraries.
(function () {
  const vscode = acquireVsCodeApi();
  const KINDS = ["member", "transient", "received", "calls", "inherits"];
  const KIND_LABEL = {
    member: "creates (member)",
    transient: "creates",
    received: "holds",
    calls: "calls",
    inherits: "inherits",
  };
  const KIND_CLASS = {
    member: "e-member",
    transient: "e-transient",
    received: "e-received",
    calls: "e-calls",
    inherits: "e-inherits",
  };

  let data = null; // {nodes, edges}
  let enabled = new Set();
  let showExternals = false;
  let rootLabel = "";
  let focus = null;
  let search = "";
  let pan = { x: 40, y: 40, k: 1 };
  let expanded = new Set(); // node ids with docstring shown
  let lastLayout = null; // { ids, edges, coords } from the last render

  function sendExport() {
    if (!lastLayout) return;
    const nodes = lastLayout.ids.map((id) => {
      const c = lastLayout.coords.get(id);
      const n = data.nodes[id];
      return { id, name: n.name, kind: n.kind, x: c.x, y: c.y, w: c.w, h: c.h, lines: c.lines || [] };
    });
    vscode.postMessage({
      type: "export",
      payload: {
        nodes,
        edges: lastLayout.edges.map((e) => ({ src: e.src, dst: e.dst, kind: e.kind, count: e.count })),
        kinds: Array.from(enabled),
        externals: showExternals,
        focus,
      },
    });
  }

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
          lines[6] = lines[6] + " …";
          return lines;
        }
      } else {
        cur = (cur + " " + w).trim();
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function toggleDoc(id) {
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    render();
  }

  const toolbar = document.getElementById("toolbar");
  const canvas = document.getElementById("canvas");

  // ------------------------------------------------------------ toolbar

  function buildToolbar() {
    toolbar.textContent = "";
    for (const k of KINDS) {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = enabled.has(k);
      cb.addEventListener("change", () => {
        cb.checked ? enabled.add(k) : enabled.delete(k);
        render();
      });
      label.appendChild(cb);
      const span = document.createElement("span");
      span.className = "legend " + KIND_CLASS[k];
      span.textContent = KIND_LABEL[k];
      label.appendChild(span);
      toolbar.appendChild(label);
    }
    const extLabel = document.createElement("label");
    const extCb = document.createElement("input");
    extCb.type = "checkbox";
    extCb.checked = showExternals;
    extCb.addEventListener("change", () => {
      showExternals = extCb.checked;
      vscode.postMessage({ type: "setExternals", value: showExternals });
      render();
    });
    extLabel.appendChild(extCb);
    const extSpan = document.createElement("span");
    extSpan.className = "ext-toggle";
    extSpan.textContent = "externals";
    extSpan.title = "Show external base classes (BaseModel, TypedDict, ...) as inheritance targets";
    extLabel.appendChild(extSpan);
    toolbar.appendChild(extLabel);
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "search…";
    input.value = search;
    input.addEventListener("input", () => {
      search = input.value.trim().toLowerCase();
      render();
    });
    toolbar.appendChild(input);

    if (focus) {
      const btn = document.createElement("button");
      btn.textContent = "✕ unfocus " + shortName(focus);
      btn.addEventListener("click", () => {
        focus = null;
        render();
      });
      toolbar.appendChild(btn);
    }
    if (data) {
      const docIds = Object.keys(data.nodes).filter((i) => data.nodes[i].doc);
      if (docIds.length) {
        const btn = document.createElement("button");
        btn.textContent = expanded.size ? "hide docs" : "show docs";
        btn.addEventListener("click", () => {
          expanded = expanded.size ? new Set() : new Set(docIds);
          render();
        });
        toolbar.appendChild(btn);
      }
    }
    if (rootLabel) {
      const rootBtn = document.createElement("button");
      rootBtn.className = "root-chip";
      rootBtn.textContent = "\u{1F4C1} " + rootLabel;
      rootBtn.title = "Mapping this folder \u2014 click to change the scope";
      rootBtn.addEventListener("click", () => vscode.postMessage({ type: "setRoot" }));
      toolbar.appendChild(rootBtn);
    }
    const pdf = document.createElement("button");
    pdf.textContent = "export PDF/SVG";
    pdf.addEventListener("click", sendExport);
    toolbar.appendChild(pdf);
    const fit = document.createElement("button");
    fit.textContent = "fit";
    fit.addEventListener("click", () => {
      pan = { x: 40, y: 40, k: 1 };
      applyTransform();
    });
    toolbar.appendChild(fit);
  }

  function shortName(id) {
    const n = data.nodes[id];
    return n ? n.name : id.split(".").pop();
  }

  // ------------------------------------------------------------ subgraph

  function visibleGraph() {
    let edges = data.edges.filter(
      (e) =>
        enabled.has(e.kind) &&
        (showExternals || !data.nodes[e.dst] || data.nodes[e.dst].kind !== "external")
    );
    let ids;
    if (focus) {
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
    edges = edges.filter((e) => ids.has(e.src) && ids.has(e.dst));
    return { ids: Array.from(ids), edges };
  }

  // ------------------------------------------------------------ layout
  // Longest-path layering on a DAG (back edges from a DFS are ignored for
  // layering only), then a few barycenter passes to reduce crossings.

  function layout(ids, edges) {
    const out = new Map(ids.map((i) => [i, []]));
    const indeg = new Map(ids.map((i) => [i, 0]));
    const idset = new Set(ids);
    // break cycles: DFS, skip back edges
    const color = new Map(); // 0 unvisited, 1 in-stack, 2 done
    const dagEdges = [];
    const adj = new Map(ids.map((i) => [i, []]));
    for (const e of edges) adj.get(e.src).push(e);
    function dfs(u) {
      color.set(u, 1);
      for (const e of adj.get(u) || []) {
        const c = color.get(e.dst) || 0;
        if (c === 1) continue; // back edge
        dagEdges.push(e);
        if (c === 0) dfs(e.dst);
      }
      color.set(u, 2);
    }
    for (const i of ids) if (!(color.get(i) || 0)) dfs(i);
    for (const e of dagEdges) {
      out.get(e.src).push(e.dst);
      indeg.set(e.dst, indeg.get(e.dst) + 1);
    }
    // longest path layering (Kahn order)
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
    // barycenter ordering
    const pos = new Map();
    layers.forEach((L) => L.forEach((id, idx) => pos.set(id, idx)));
    const inn = new Map(ids.map((i) => [i, []]));
    for (const e of dagEdges) inn.get(e.dst).push(e.src);
    for (let pass = 0; pass < 4; pass++) {
      const src = pass % 2 === 0 ? inn : out;
      const order = pass % 2 === 0 ? layers : layers.slice().reverse();
      for (const L of order) {
        L.sort((a, b) => {
          const ba = bary(a, src), bb = bary(b, src);
          return ba - bb;
        });
        L.forEach((id, idx) => pos.set(id, idx));
      }
    }
    function bary(id, m) {
      const nb = m.get(id) || [];
      if (!nb.length) return pos.get(id);
      return nb.reduce((s, n) => s + pos.get(n), 0) / nb.length;
    }
    // coordinates (nodes have variable height when a docstring is expanded)
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
    // normalize y >= 0
    let minY = Infinity;
    coords.forEach((c) => (minY = Math.min(minY, c.y)));
    coords.forEach((c) => (c.y -= minY - 10));
    return coords;
  }

  // ------------------------------------------------------------ render

  const SVG = "http://www.w3.org/2000/svg";
  let gRoot = null;

  function render() {
    buildToolbar();
    canvas.textContent = "";
    if (!data) return;
    const { ids, edges } = visibleGraph();
    if (!ids.length) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "Nothing to show — enable more relationship kinds above.";
      canvas.appendChild(p);
      return;
    }
    const coords = layout(ids, edges);
    lastLayout = { ids, edges, coords };
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    gRoot = document.createElementNS(SVG, "g");
    svg.appendChild(defs());
    svg.appendChild(gRoot);
    canvas.appendChild(svg);

    // edges first
    for (const e of edges) {
      const a = coords.get(e.src), b = coords.get(e.dst);
      if (!a || !b) continue;
      const x1 = a.x + a.w, y1 = a.y + 15; // anchor at the title band
      const x2 = b.x, y2 = b.y + 15;
      const back = x2 <= x1; // cycle edge drawn as arc
      const path = document.createElementNS(SVG, "path");
      let d;
      if (!back) {
        const mx = (x1 + x2) / 2;
        d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2 - 6} ${y2}`;
      } else {
        d = `M ${x1} ${y1} C ${x1 + 60} ${y1 - 50}, ${x2 - 60} ${y2 - 50}, ${x2 - 6} ${y2}`;
      }
      path.setAttribute("d", d);
      path.setAttribute("class", "edge " + KIND_CLASS[e.kind]);
      path.setAttribute("marker-end", "url(#arr-" + e.kind + ")");
      const title = document.createElementNS(SVG, "title");
      title.textContent = `${shortName(e.src)} ${KIND_LABEL[e.kind]} ${shortName(e.dst)} ×${e.count}`;
      path.appendChild(title);
      gRoot.appendChild(path);
    }
    // nodes
    for (const id of ids) {
      const c = coords.get(id);
      const n = data.nodes[id];
      const g = document.createElementNS(SVG, "g");
      const dim = search && !id.toLowerCase().includes(search);
      g.setAttribute("class", "node n-" + n.kind + (dim ? " dim" : "") + (id === focus ? " focused" : ""));
      g.setAttribute("transform", `translate(${c.x},${c.y})`);
      const rect = document.createElementNS(SVG, "rect");
      rect.setAttribute("width", c.w);
      rect.setAttribute("height", c.h);
      rect.setAttribute("rx", n.kind === "class" ? 4 : 14);
      g.appendChild(rect);
      const text = document.createElementNS(SVG, "text");
      text.setAttribute("x", n.doc ? c.w / 2 + 6 : c.w / 2);
      text.setAttribute("y", 19);
      text.setAttribute("text-anchor", "middle");
      text.textContent = n.name;
      g.appendChild(text);
      if (n.doc) {
        const chev = document.createElementNS(SVG, "text");
        chev.setAttribute("x", 8);
        chev.setAttribute("y", 19);
        chev.setAttribute("class", "chev");
        chev.textContent = expanded.has(id) ? "▾" : "▸";
        chev.addEventListener("click", (ev) => {
          ev.stopPropagation();
          toggleDoc(id);
        });
        g.appendChild(chev);
        (c.lines || []).forEach((ln, i) => {
          const t = document.createElementNS(SVG, "text");
          t.setAttribute("x", 11);
          t.setAttribute("y", 42 + i * 14);
          t.setAttribute("class", "doc");
          t.textContent = ln;
          g.appendChild(t);
        });
      }
      const title = document.createElementNS(SVG, "title");
      title.textContent = `${n.name} (${n.kind})\n${n.file ? n.file + ":" + n.line : "external"}\n${n.doc ? "▸ toggles docstring · " : ""}click: highlight · double-click: open source`;
      g.appendChild(title);
      g.addEventListener("click", () => highlight(id, edges));
      g.addEventListener("dblclick", () => {
        if (n.file) vscode.postMessage({ type: "open", file: n.file, line: n.line });
      });
      gRoot.appendChild(g);
    }
    applyTransform();
    attachPanZoom(svg);
  }

  function highlight(id, edges) {
    const near = new Set([id]);
    for (const e of edges) {
      if (e.src === id) near.add(e.dst);
      if (e.dst === id) near.add(e.src);
    }
    gRoot.querySelectorAll("g.node").forEach((g) => g.classList.add("dim"));
    gRoot.querySelectorAll("path.edge").forEach((p) => p.classList.add("dim"));
    let i = 0;
    const nodeEls = gRoot.querySelectorAll("g.node");
    const { ids } = visibleGraph();
    nodeEls.forEach((g, idx) => {
      if (near.has(ids[idx])) g.classList.remove("dim");
    });
    const edgeEls = gRoot.querySelectorAll("path.edge");
    edgeEls.forEach((p, idx) => {
      const e = edges[idx];
      if (e && (e.src === id || e.dst === id)) p.classList.remove("dim");
    });
  }

  function defs() {
    const defs = document.createElementNS(SVG, "defs");
    for (const k of KINDS) {
      const m = document.createElementNS(SVG, "marker");
      m.setAttribute("id", "arr-" + k);
      m.setAttribute("viewBox", "0 0 10 10");
      m.setAttribute("refX", "9");
      m.setAttribute("refY", "5");
      m.setAttribute("markerWidth", "7");
      m.setAttribute("markerHeight", "7");
      m.setAttribute("orient", "auto-start-reverse");
      const p = document.createElementNS(SVG, "path");
      p.setAttribute("d", k === "inherits" ? "M 0 0 L 10 5 L 0 10 Z" : "M 0 0 L 10 5 L 0 10");
      p.setAttribute("class", "arrow " + KIND_CLASS[k]);
      m.appendChild(p);
      defs.appendChild(m);
    }
    return defs;
  }

  // ------------------------------------------------------------ pan/zoom

  function applyTransform() {
    if (gRoot) gRoot.setAttribute("transform", `translate(${pan.x},${pan.y}) scale(${pan.k})`);
  }
  function attachPanZoom(svg) {
    let dragging = false, lx = 0, ly = 0;
    svg.addEventListener("mousedown", (ev) => {
      dragging = true;
      lx = ev.clientX;
      ly = ev.clientY;
    });
    window.addEventListener("mouseup", () => (dragging = false));
    window.addEventListener("mousemove", (ev) => {
      if (!dragging) return;
      pan.x += ev.clientX - lx;
      pan.y += ev.clientY - ly;
      lx = ev.clientX;
      ly = ev.clientY;
      applyTransform();
    });
    svg.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        const f = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
        const nk = Math.min(3, Math.max(0.15, pan.k * f));
        // zoom around cursor
        pan.x = ev.clientX - (ev.clientX - pan.x) * (nk / pan.k);
        pan.y = ev.clientY - (ev.clientY - pan.y) * (nk / pan.k);
        pan.k = nk;
        applyTransform();
      },
      { passive: false }
    );
  }

  // ------------------------------------------------------------ messages

  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (msg.type === "graph") {
      data = { nodes: msg.nodes, edges: msg.edges };
      enabled = new Set(msg.kinds);
      showExternals = !!msg.externals;
      if (msg.root) rootLabel = msg.root;
      if (msg.focus) focus = msg.focus;
      render();
    }
    if (msg.type === "requestExport") sendExport();
  });
  vscode.postMessage({ type: "ready" });
})();
