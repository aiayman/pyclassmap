const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const { buildDiagramPdf } = require("./pdfgen");
const { buildDiagramSvg } = require("./svggen");

const ALL_KINDS = ["member", "transient", "received", "calls", "inherits"];
const DEFAULT_KINDS = ["member", "transient", "received", "calls"];
const KIND_LABEL = {
  member: "creates (member)",
  transient: "creates",
  received: "holds",
  calls: "calls",
  inherits: "inherits",
};
const KIND_ICON = {
  member: "symbol-field",
  transient: "add",
  received: "arrow-small-left",
  calls: "call-outgoing",
  inherits: "type-hierarchy-sub",
};
const NODE_ICON = {
  class: "symbol-class",
  function: "symbol-function",
  module: "symbol-namespace",
  external: "symbol-interface",
};

let graph = null; // { root, nodes: {id: node}, edges: [...] }
let outgoing = new Map(); // id -> [edge]
let incoming = new Map(); // id -> [edge]
let enabledKinds = new Set(DEFAULT_KINDS);
let showExternals = false; // show external base classes (BaseModel, TypedDict, ...)
let treeProvider = null;
let diagramPanel = null;
let output = null;
let extContext = null;
let pendingExport = false;

async function doExport(payload) {
  try {
    const base = workspaceRoot();
    const uri = await vscode.window.showSaveDialog({
      defaultUri: base ? vscode.Uri.file(path.join(base, "pyclassmap.pdf")) : undefined,
      filters: { PDF: ["pdf"], SVG: ["svg"] },
      title: "Export Python Class Map (choose .pdf or .svg)",
    });
    if (!uri) return;
    const name = path.basename(analysisRoot() || "project");
    const buf = uri.fsPath.toLowerCase().endsWith(".svg")
      ? Buffer.from(buildDiagramSvg(payload, name), "utf8")
      : buildDiagramPdf(payload, name);
    await vscode.workspace.fs.writeFile(uri, buf);
    vscode.window.showInformationMessage(`Python Class Map: exported ${uri.fsPath}`);
  } catch (e) {
    vscode.window.showErrorMessage(`Python Class Map: export failed (${e.message})`);
  }
}

// ---------------------------------------------------------------- analysis

function workspaceRoot() {
  const ws = vscode.workspace.workspaceFolders;
  return ws && ws.length ? ws[0].uri.fsPath : null;
}

function analysisRoot() {
  const sub = vscode.workspace.getConfiguration("pyclassmap").get("root") || "";
  if (sub && path.isAbsolute(sub)) return sub;
  const base = workspaceRoot();
  if (!base) return null;
  return sub ? path.join(base, sub) : base;
}

// Short, human-readable name for whatever is currently being analyzed.
function rootLabel() {
  const base = workspaceRoot();
  const root = analysisRoot();
  if (!root) return "no folder open";
  if (!base || root === base) return path.basename(root);
  const rel = path.relative(base, root);
  return rel && !rel.startsWith("..") ? rel : root;
}

// The indicator beside the view title: what is mapped, and how big it is.
function updateViewDescription() {
  if (!treeProvider || !treeProvider.view) return;
  const n = graph ? Object.keys(graph.nodes).length : 0;
  treeProvider.view.description = graph ? `${rootLabel()} · ${n} nodes` : rootLabel();
}

function runAnalyzer() {
  return new Promise((resolve, reject) => {
    const root = analysisRoot();
    if (!root) return reject(new Error("Open a folder first."));
    const cfg = vscode.workspace.getConfiguration("pyclassmap");
    const py = cfg.get("pythonPath") || "python3";
    const script = extContext.asAbsolutePath(path.join("analyzer", "analyze.py"));
    const args = [script, root];
    for (const ex of cfg.get("exclude") || []) args.push("--exclude", ex);
    if (cfg.get("includeTests")) args.push("--include-tests");

    cp.execFile(py, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        output.appendLine(`analyzer failed: ${err.message}`);
        if (stderr) output.appendLine(stderr);
        return reject(err);
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        output.appendLine("analyzer produced invalid JSON");
        reject(e);
      }
    });
  });
}

function indexGraph(g) {
  graph = g;
  outgoing = new Map();
  incoming = new Map();
  for (const e of g.edges) {
    if (!outgoing.has(e.src)) outgoing.set(e.src, []);
    outgoing.get(e.src).push(e);
    if (!incoming.has(e.dst)) incoming.set(e.dst, []);
    incoming.get(e.dst).push(e);
  }
}

async function refresh(silent) {
  try {
    if (treeProvider) treeProvider.setMessage("Analyzing project…");
    const g = await runAnalyzer();
    indexGraph(g);
    if (treeProvider) {
      treeProvider.setMessage(undefined);
      treeProvider.fire();
      updateViewDescription();
    }
    if (diagramPanel) postGraphToPanel();
  } catch (e) {
    if (treeProvider) treeProvider.setMessage("Analysis failed — see 'Python Class Map' output.");
    if (!silent) {
      vscode.window.showErrorMessage(
        `Python Class Map: analysis failed (${e.message}). Check the pyclassmap.pythonPath setting.`
      );
    }
  }
}

// ---------------------------------------------------------------- tree view

function enabledOut(id) {
  return (outgoing.get(id) || []).filter(
    (e) =>
      enabledKinds.has(e.kind) &&
      (showExternals || !graph.nodes[e.dst] || graph.nodes[e.dst].kind !== "external")
  );
}
function enabledIn(id) {
  return (incoming.get(id) || []).filter((e) => enabledKinds.has(e.kind));
}

function reachCount(id) {
  const seen = new Set([id]);
  const stack = [id];
  while (stack.length) {
    for (const e of enabledOut(stack.pop())) {
      if (!seen.has(e.dst)) {
        seen.add(e.dst);
        stack.push(e.dst);
      }
    }
  }
  return seen.size - 1;
}

function computeRoots() {
  const roots = [];
  for (const id of Object.keys(graph.nodes)) {
    if (enabledOut(id).length > 0 && enabledIn(id).length === 0) roots.push(id);
  }
  roots.sort((a, b) => reachCount(b) - reachCount(a) || a.localeCompare(b));
  return roots;
}

function unconnectedClasses() {
  const ids = [];
  for (const [id, n] of Object.entries(graph.nodes)) {
    if (n.kind !== "class") continue;
    if (enabledOut(id).length === 0 && enabledIn(id).length === 0) ids.push(id);
  }
  ids.sort();
  return ids;
}

class PcmTreeProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.view = null;
  }
  fire() {
    this._emitter.fire();
  }
  setMessage(msg) {
    if (this.view) this.view.message = msg;
  }
  getTreeItem(el) {
    return el.item;
  }
  getChildren(el) {
    if (!graph) return [];
    if (!el) {
      const items = computeRoots().map((id) => makeNodeElement(id, null, [], null));
      const un = unconnectedClasses();
      if (un.length) items.push(makeGroupElement("Unconnected classes", un));
      return items;
    }
    if (el.groupIds) {
      return el.groupIds.map((id) => makeNodeElement(id, null, [], null));
    }
    return enabledOut(el.id).map((e) => makeNodeElement(e.dst, e, el.path.concat(el.id), null));
  }
}

function makeGroupElement(label, ids) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
  item.iconPath = new vscode.ThemeIcon("archive");
  item.description = `${ids.length}`;
  return { item, groupIds: ids, path: [] };
}

function makeNodeElement(id, viaEdge, ancestry, _unused) {
  const node = graph.nodes[id];
  const isCycle = ancestry.includes(id);
  const hasChildren = !isCycle && enabledOut(id).length > 0;
  const item = new vscode.TreeItem(
    node.name,
    hasChildren
      ? ancestry.length === 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None
  );
  item.iconPath = new vscode.ThemeIcon(
    viaEdge ? KIND_ICON[viaEdge.kind] : NODE_ICON[node.kind] || "symbol-misc"
  );
  const bits = [];
  if (viaEdge) {
    bits.push(KIND_LABEL[viaEdge.kind] + (viaEdge.count > 1 ? ` ×${viaEdge.count}` : ""));
  } else if (node.kind !== "external") {
    bits.push(node.kind);
    const r = reachCount(id);
    if (r) bits.push(`→ ${r}`);
  }
  if (isCycle) bits.push("↩ cycle");
  item.description = bits.join("  ");
  item.tooltip = new vscode.MarkdownString(
    `**${node.name}** (${node.kind})\n\n` +
      (node.file ? `${node.file}:${node.line}\n\n` : "") +
      (viaEdge
        ? `${KIND_LABEL[viaEdge.kind]} — ${viaEdge.count} site(s)`
        : `creates/holds ${enabledOut(id).length} · used by ${enabledIn(id).length}`) +
      (node.doc ? `\n\n---\n\n*${node.doc.replace(/\n/g, "\n> ")}*` : "")
  );
  item.contextValue = "pcmNode";
  const site = viaEdge && viaEdge.sites.length ? viaEdge.sites[0] : { file: node.file, line: node.line };
  if (site.file) {
    item.command = {
      command: "pyclassmap.openSite",
      title: "Open",
      arguments: [site.file, site.line],
    };
  }
  return { item, id, path: ancestry };
}

async function openSite(relFile, line) {
  const base = analysisRoot();
  if (!base || !relFile) return;
  const uri = vscode.Uri.file(path.join(base, relFile));
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: true });
  const pos = new vscode.Position(Math.max(0, (line || 1) - 1), 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

// ---------------------------------------------------------------- filtering

async function pickKinds() {
  const KIND_DESC = {
    member: "self.attr = Foo() — instance stored on the object (owned)",
    transient: "Foo() in a method/function body — created on the fly, not stored on self",
    received: "typed __init__ param or class field — holds an instance it didn't create",
    calls: "calls a project function that (transitively) creates instances",
    inherits: "subclassing — off by default, flat hierarchies flood the tree",
  };
  const items = ALL_KINDS.map((k) => ({
    label: KIND_LABEL[k],
    description: KIND_DESC[k],
    kind: k,
    picked: enabledKinds.has(k),
  }));
  items.push({
    label: "external base classes",
    description: "show BaseModel, TypedDict, StateGraph, ... as inheritance targets",
    kind: "_externals",
    picked: showExternals,
  });
  const picks = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: "Python Class Map: what to show",
  });
  if (!picks) return;
  showExternals = picks.some((p) => p.kind === "_externals");
  enabledKinds = new Set(picks.filter((p) => p.kind !== "_externals").map((p) => p.kind));
  if (enabledKinds.size === 0) enabledKinds = new Set(DEFAULT_KINDS);
  extContext.workspaceState.update("pyclassmap.kinds", Array.from(enabledKinds));
  extContext.workspaceState.update("pyclassmap.externals", showExternals);
  if (treeProvider) treeProvider.fire();
  if (diagramPanel) postGraphToPanel();
}

// ---------------------------------------------------------------- scope

const SCAN_EXCLUDE =
  "**/{node_modules,.venv,venv,env,.git,__pycache__,build,dist,site-packages,.tox,.mypy_cache}/**";

// Rank every directory that contains Python, so the picker can offer the
// places worth analyzing rather than a raw folder tree.
async function pythonDirCounts(base) {
  const files = await vscode.workspace.findFiles("**/*.py", SCAN_EXCLUDE, 5000);
  const counts = new Map();
  for (const f of files) {
    let dir = path.dirname(f.fsPath);
    for (;;) {
      counts.set(dir, (counts.get(dir) || 0) + 1);
      if (dir === base || dir.length <= base.length) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return counts;
}

async function pickRoot() {
  const base = workspaceRoot();
  if (!base) {
    vscode.window.showWarningMessage("Python Class Map: open a folder first.");
    return;
  }
  const current = analysisRoot();
  const counts = await pythonDirCounts(base);
  const items = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([dir, n]) => {
      const rel = path.relative(base, dir);
      return {
        label: rel ? `$(folder) ${rel}` : `$(root-folder) ${path.basename(base)}`,
        description:
          `${n} .py file${n === 1 ? "" : "s"}` +
          (rel ? "" : "  —  whole workspace") +
          (dir === current ? "  •  current" : ""),
        value: rel,
      };
    });
  if (!items.length) {
    vscode.window.showWarningMessage("Python Class Map: no Python files found in this workspace.");
    return;
  }
  items.push({
    label: "$(folder-opened) Browse…",
    description: "choose any folder, inside or outside the workspace",
    value: "__browse__",
  });

  const pick = await vscode.window.showQuickPick(items, {
    title: "Python Class Map: which folder to map",
    placeHolder: `currently mapping: ${rootLabel()}`,
  });
  if (!pick) return;

  let value = pick.value;
  if (value === "__browse__") {
    const sel = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(current || base),
      openLabel: "Map this folder",
    });
    if (!sel || !sel.length) return;
    const rel = path.relative(base, sel[0].fsPath);
    value = !rel ? "" : rel.startsWith("..") ? sel[0].fsPath : rel;
  }

  await vscode.workspace
    .getConfiguration("pyclassmap")
    .update("root", value || undefined, vscode.ConfigurationTarget.Workspace);
  // the configuration listener triggers the re-analysis
}

// ---------------------------------------------------------------- diagram

function postGraphToPanel(focus) {
  if (!diagramPanel || !graph) return;
  diagramPanel.webview.postMessage({
    type: "graph",
    nodes: graph.nodes,
    edges: graph.edges,
    kinds: Array.from(enabledKinds),
    externals: showExternals,
    root: rootLabel(),
    focus: focus || null,
  });
}

function showDiagram(focus) {
  if (diagramPanel) {
    diagramPanel.reveal(vscode.ViewColumn.Active);
    postGraphToPanel(focus);
    return;
  }
  diagramPanel = vscode.window.createWebviewPanel(
    "pyclassmap.diagram",
    "Python Class Map",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  const wv = diagramPanel.webview;
  const nonce = String(Math.random()).slice(2);
  const jsUri = wv.asWebviewUri(vscode.Uri.file(extContext.asAbsolutePath("media/diagram.js")));
  const cssUri = wv.asWebviewUri(vscode.Uri.file(extContext.asAbsolutePath("media/diagram.css")));
  wv.html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${wv.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
<div id="toolbar"></div>
<div id="canvas"></div>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  wv.onDidReceiveMessage((msg) => {
    if (msg.type === "open") openSite(msg.file, msg.line);
    if (msg.type === "export") doExport(msg.payload);
    if (msg.type === "setRoot") pickRoot();
    if (msg.type === "setExternals") {
      showExternals = !!msg.value;
      extContext.workspaceState.update("pyclassmap.externals", showExternals);
      if (treeProvider) treeProvider.fire();
    }
    if (msg.type === "ready") {
      postGraphToPanel(focus);
      if (pendingExport) {
        pendingExport = false;
        wv.postMessage({ type: "requestExport" });
      }
    }
  });
  diagramPanel.onDidDispose(() => {
    diagramPanel = null;
  });
}

// ---------------------------------------------------------------- activate

function activate(context) {
  extContext = context;
  output = vscode.window.createOutputChannel("Python Class Map");

  const saved = context.workspaceState.get("pyclassmap.kinds");
  if (Array.isArray(saved) && saved.length) enabledKinds = new Set(saved);
  showExternals = !!context.workspaceState.get("pyclassmap.externals");

  treeProvider = new PcmTreeProvider();
  const view = vscode.window.createTreeView("pyclassmap.tree", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  treeProvider.view = view;
  updateViewDescription();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("pyclassmap")) return;
      updateViewDescription();
      refresh(false);
    })
  );

  context.subscriptions.push(
    view,
    output,
    vscode.commands.registerCommand("pyclassmap.refresh", () => refresh(false)),
    vscode.commands.registerCommand("pyclassmap.setRoot", pickRoot),
    vscode.commands.registerCommand("pyclassmap.filter", pickKinds),
    vscode.commands.registerCommand("pyclassmap.openSite", openSite),
    vscode.commands.registerCommand("pyclassmap.showDiagram", () => showDiagram(null)),
    vscode.commands.registerCommand("pyclassmap.exportPdf", () => {
      if (diagramPanel) {
        diagramPanel.webview.postMessage({ type: "requestExport" });
      } else {
        pendingExport = true;
        showDiagram(null);
      }
    }),
    vscode.commands.registerCommand("pyclassmap.diagramFromHere", (el) =>
      showDiagram(el && el.id ? el.id : null)
    )
  );

  let debounce = null;
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!doc.fileName.endsWith(".py")) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => refresh(true), 800);
    })
  );

  refresh(true);
}

function deactivate() {}

module.exports = { activate, deactivate };
