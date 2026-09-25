# Changelog

## 0.6.0 — 2026-09-25

- **Scope indicator**: the view header now shows which folder is being
  analyzed and how many nodes were found.
- **Set Folder to Map**: a folder button and command to change the analyzed
  scope interactively — every directory containing Python is offered with
  its file count, plus Browse… for paths outside the workspace. The diagram
  toolbar shows the same scope as a clickable chip.
- Changing any `pyclassmap.*` setting now re-analyzes immediately.
- `pyclassmap.root` accepts absolute paths.

## 0.5.0 — 2026-09-25

- **Externals toggle**: external base classes (`BaseModel`, `TypedDict`,
  `Protocol`, …) are hidden by default and can be shown via the diagram
  toolbar checkbox or the filter picker. Enabling `inherits` now shows your
  own hierarchy without framework-base noise. Exports note "external bases
  hidden" in the subtitle when applicable.

## 0.4.0 — 2026-09-25

- **SVG export**: the export dialog now offers SVG alongside PDF — same
  layout, filters, docstrings, and always-included legend. Print-styled,
  standalone, editable vector output.

## 0.3.0 — 2026-09-25

- **PDF export** of the current diagram view: vector output generated
  in-process (no Graphviz or browser), with a legend always included that
  explains all five relationship kinds, plus project, date, and active
  filters in the subtitle.

## 0.2.0 — 2026-09-25

- **Docstrings**: extracted for classes, functions, and modules; shown in
  tree tooltips and expandable in place inside diagram nodes (`▸` chevron,
  plus a show/hide-all toolbar button).
- Filter picker entries now carry one-line explanations of each kind.

## 0.1.0 — 2026-09-24

- Initial release: stdlib-only AST analyzer (member/transient creates,
  holds, calls, inherits; import/alias resolution), sidebar
  instantiation tree rooted at true entry points, interactive pan/zoom
  diagram with click-to-source, per-subtree focus, auto-refresh on save.
