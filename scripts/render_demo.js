#!/usr/bin/env node
// Dev helper (not shipped): renders a real diagram to SVG using the same
// layout as the webview, for README screenshots. Source must be demo/.
//
//   node scripts/render_demo.js <root> <out.svg> [--focus <nodeId>]
//        [--kinds member,transient,...] [--docs] [--externals]

const fs = require("fs");
const path = require("path");
const { buildDiagramSvg } = require("../svggen");
const { loadGraph, computeView } = require("./layout");

const args = process.argv.slice(2);
const root = args[0];
const outFile = args[1];
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const focus = opt("--focus");
const kinds = (opt("--kinds") || "member,transient,received,calls").split(",");
const showExternals = args.includes("--externals");

const data = loadGraph(root);
if (focus && !data.nodes[focus]) {
  console.error("focus id not found:", focus);
  process.exit(1);
}
const view = computeView({
  data,
  kinds,
  showExternals,
  focus,
  expanded: args.includes("--docs") ? "all" : null,
});

fs.writeFileSync(
  outFile,
  buildDiagramSvg(
    { nodes: view.nodes, edges: view.edges, kinds, externals: showExternals, focus: focus || null },
    path.basename(root)
  )
);
console.log(`${outFile}: ${view.ids.length} nodes, ${view.edges.length} edges`);
