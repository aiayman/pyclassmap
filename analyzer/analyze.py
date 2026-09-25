#!/usr/bin/env python3
"""Project-wide Python instantiation analyzer. Stdlib only (Python 3.8+).

Walks every .py file under a root directory and emits a JSON graph of
"instantiation contexts" (classes, module-level functions, module bodies)
connected by typed edges:

  member    - self.attr = Foo()  (owned instance)
  transient - foo = Foo() / Foo() inside a method or function body
  received  - __init__ param or class-level annotation typed as a project class
  inherits  - class Foo(Bar)
  calls     - context calls a project module-level function that (transitively)
              instantiates something

Usage: analyze.py ROOT [--exclude NAME ...] [--include-tests]
Output: JSON on stdout.
"""

import argparse
import ast
import json
import os
import sys

DEFAULT_EXCLUDES = {
    "__pycache__", "node_modules", ".git", ".hg", ".svn", "build", "dist",
    ".venv", "venv", "env", ".env", ".tox", ".mypy_cache", ".pytest_cache",
    "site-packages", ".eggs", "egg-info",
}
TEST_DIR_NAMES = {"tests", "test"}


def discover_files(root, excludes, include_tests):
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        pruned = []
        for d in dirnames:
            if d in excludes or d.startswith("."):
                continue
            if not include_tests and d in TEST_DIR_NAMES:
                continue
            pruned.append(d)
        dirnames[:] = pruned
        for f in filenames:
            if not f.endswith(".py"):
                continue
            if not include_tests and (f.startswith("test_") or f.endswith("_test.py")):
                continue
            files.append(os.path.join(dirpath, f))
    return sorted(files)


def module_name_for(path, root):
    rel = os.path.relpath(path, root)
    parts = rel.split(os.sep)
    parts[-1] = parts[-1][:-3]  # strip .py
    is_package = parts[-1] == "__init__"
    if is_package:
        parts = parts[:-1]
    if not parts:
        parts = ["__root__"]
    return ".".join(parts), is_package


def dotted_from(node):
    """Return 'a.b.c' for a Name/Attribute chain, else None."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return None


class ModuleInfo:
    def __init__(self, path, module, is_package):
        self.path = path
        self.module = module
        self.is_package = is_package
        self.tree = None
        self.imports = {}        # local name -> absolute dotted target
        self.star_imports = []   # absolute module names
        self.classes = {}        # bare class name -> node id (top-level only)
        self.functions = {}      # bare function name -> node id


class Project:
    def __init__(self, root):
        self.root = root
        self.modules = {}        # module name -> ModuleInfo
        self.nodes = {}          # node id -> dict
        self.edges = {}          # (src, dst, kind) -> {"sites": [...], "count": n}
        self.class_by_name = {}  # bare name -> [node ids]

    # ---------------- pass 1: index ----------------

    def index_file(self, path):
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                src = fh.read()
            tree = ast.parse(src, filename=path)
        except (SyntaxError, ValueError):
            return
        module, is_package = module_name_for(path, self.root)
        mi = ModuleInfo(path, module, is_package)
        mi.tree = tree
        self.modules[module] = mi
        rel = os.path.relpath(path, self.root)

        for stmt in tree.body:
            self._index_stmt(stmt, mi, rel)
        self._collect_imports(tree, mi)

    def _index_stmt(self, stmt, mi, rel):
        if isinstance(stmt, ast.ClassDef):
            nid = mi.module + "." + stmt.name
            mi.classes[stmt.name] = nid
            self.nodes[nid] = {
                "id": nid, "name": stmt.name, "kind": "class",
                "module": mi.module, "file": rel, "line": stmt.lineno,
            }
            doc = ast.get_docstring(stmt)
            if doc:
                self.nodes[nid]["doc"] = doc[:600]
            self.class_by_name.setdefault(stmt.name, []).append(nid)
        elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            nid = mi.module + "." + stmt.name
            mi.functions[stmt.name] = nid
            self.nodes[nid] = {
                "id": nid, "name": stmt.name, "kind": "function",
                "module": mi.module, "file": rel, "line": stmt.lineno,
            }
            doc = ast.get_docstring(stmt)
            if doc:
                self.nodes[nid]["doc"] = doc[:600]
        elif isinstance(stmt, (ast.If, ast.Try)):
            # index defs guarded by `if TYPE_CHECKING:` / try blocks too
            for sub in ast.iter_child_nodes(stmt):
                if isinstance(sub, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                    self._index_stmt(sub, mi, rel)

    def _collect_imports(self, tree, mi):
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    local = alias.asname or alias.name.split(".")[0]
                    target = alias.name if alias.asname else alias.name.split(".")[0]
                    mi.imports[local] = target
            elif isinstance(node, ast.ImportFrom):
                base = self._resolve_from_base(node, mi)
                if base is None:
                    continue
                for alias in node.names:
                    if alias.name == "*":
                        mi.star_imports.append(base)
                    else:
                        local = alias.asname or alias.name
                        mi.imports[local] = base + "." + alias.name if base else alias.name

    def _resolve_from_base(self, node, mi):
        if node.level == 0:
            return node.module or ""
        parts = mi.module.split(".")
        pkg = parts if mi.is_package else parts[:-1]
        drop = node.level - 1
        if drop > len(pkg):
            return None
        base = pkg[: len(pkg) - drop] if drop else pkg
        if node.module:
            base = base + node.module.split(".")
        return ".".join(base)

    # ---------------- resolution ----------------

    def _match_class(self, absolute):
        """Match an absolute dotted name against indexed classes by suffix."""
        hits = []
        suffix = "." + absolute
        for name, ids in self.class_by_name.items():
            if not absolute.endswith("." + name) and absolute != name:
                continue
            for nid in ids:
                if nid == absolute or nid.endswith(suffix):
                    hits.append(nid)
        if len(hits) == 1:
            return hits[0]
        if hits:
            # prefer the shortest (least nested ambiguity)
            hits.sort(key=len)
            return hits[0]
        return None

    def resolve_class(self, dotted, mi):
        """Resolve a dotted call target to a project class node id, or None."""
        if dotted is None:
            return None
        head, _, rest = dotted.partition(".")
        # 1) bare name defined in same module
        if not rest and head in mi.classes:
            return mi.classes[head]
        # 2) via import table
        if head in mi.imports:
            absolute = mi.imports[head] + ("." + rest if rest else "")
            hit = self._match_class(absolute)
            if hit:
                return hit
        # 3) star imports
        if not rest:
            for star in mi.star_imports:
                hit = self._match_class(star + "." + head)
                if hit:
                    return hit
        # 4) unique bare name across project (bare calls only)
        if not rest:
            ids = self.class_by_name.get(head, [])
            if len(ids) == 1:
                return ids[0]
        return None

    def resolve_function(self, dotted, mi):
        if dotted is None:
            return None
        head, _, rest = dotted.partition(".")
        if not rest and head in mi.functions:
            return mi.functions[head]
        if head in mi.imports:
            absolute = mi.imports[head] + ("." + rest if rest else "")
            for m in self.modules.values():
                for fname, nid in m.functions.items():
                    if nid == absolute or nid.endswith("." + absolute):
                        return nid
        return None

    # ---------------- pass 2: edges ----------------

    def add_edge(self, src, dst, kind, rel, line):
        if src == dst and kind != "calls":
            return
        key = (src, dst, kind)
        e = self.edges.setdefault(key, {"sites": [], "count": 0})
        e["count"] += 1
        if len(e["sites"]) < 25:
            e["sites"].append({"file": rel, "line": line})

    def analyze_file(self, mi):
        rel = os.path.relpath(mi.path, self.root)
        self._walk_body(mi.tree.body, mi, rel, context=mi.module, in_class=None)

    def _ensure_module_node(self, mi, rel):
        if mi.module not in self.nodes:
            self.nodes[mi.module] = {
                "id": mi.module, "name": mi.module.split(".")[-1] + " (module)",
                "kind": "module", "module": mi.module, "file": rel, "line": 1,
            }
            doc = ast.get_docstring(mi.tree)
            if doc:
                self.nodes[mi.module]["doc"] = doc[:600]

    def _walk_body(self, body, mi, rel, context, in_class):
        for stmt in body:
            if isinstance(stmt, ast.ClassDef):
                nid = mi.classes.get(stmt.name)
                if nid is None or in_class is not None:
                    # nested class: attribute its contents to enclosing context
                    self._walk_body(stmt.body, mi, rel, context, in_class)
                    continue
                self._class_edges(stmt, nid, mi, rel)
                self._walk_body(stmt.body, mi, rel, context=nid, in_class=nid)
            elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if in_class is None and context == mi.module:
                    fid = mi.functions.get(stmt.name, context)
                    self._scan_exec(stmt, mi, rel, fid, in_class=None)
                else:
                    # method or nested function -> enclosing context
                    self._scan_exec(stmt, mi, rel, context, in_class)
            else:
                self._scan_exec(stmt, mi, rel, context, in_class,
                                top_level=(context == mi.module))

    def _class_edges(self, cls, nid, mi, rel):
        # inherits
        for base in cls.bases:
            dotted = dotted_from(base)
            if dotted is None and isinstance(base, ast.Subscript):
                dotted = dotted_from(base.value)  # Generic[T] etc.
            if dotted is None:
                continue
            target = self.resolve_class(dotted, mi)
            if target:
                self.add_edge(nid, target, "inherits", rel, base.lineno)
            else:
                tail = dotted.split(".")[-1]
                if tail not in ("object",):
                    ext = "external." + tail
                    if ext not in self.nodes:
                        self.nodes[ext] = {
                            "id": ext, "name": tail, "kind": "external",
                            "module": "", "file": "", "line": 0,
                        }
                    self.add_edge(nid, ext, "inherits", rel, base.lineno)
        # class-level annotations (dataclass / pydantic fields) -> received
        for stmt in cls.body:
            if isinstance(stmt, ast.AnnAssign):
                self._annotation_edges(stmt.annotation, nid, mi, rel,
                                       skip_call=stmt.value)
        # __init__ params -> received
        for stmt in cls.body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)) and stmt.name == "__init__":
                args = stmt.args
                all_args = list(args.posonlyargs) + list(args.args) + list(args.kwonlyargs)
                for a in all_args:
                    if a.annotation is not None:
                        self._annotation_edges(a.annotation, nid, mi, rel, skip_call=None)

    def _annotation_edges(self, ann, nid, mi, rel, skip_call):
        """Emit `received` edges for every project class referenced in an annotation."""
        skip_target = None
        if isinstance(skip_call, ast.Call):
            skip_target = self.resolve_class(dotted_from(skip_call.func), mi)
        targets = set()
        if isinstance(ann, ast.Constant) and isinstance(ann.value, str):
            # string annotation: cheap parse
            try:
                ann = ast.parse(ann.value, mode="eval").body
            except SyntaxError:
                return
        for sub in ast.walk(ann):
            dotted = None
            if isinstance(sub, ast.Name):
                dotted = sub.id
            elif isinstance(sub, ast.Attribute):
                dotted = dotted_from(sub)
            if dotted is None:
                continue
            t = self.resolve_class(dotted, mi)
            if t and t != nid and t != skip_target:
                targets.add((t, getattr(sub, "lineno", ann.lineno)))
        for t, line in targets:
            self.add_edge(nid, t, "received", rel, line)

    def _scan_exec(self, node, mi, rel, context, in_class, top_level=False):
        """Scan executable code, attributing edges to `context`."""
        for sub in ast.walk(node):
            if not isinstance(sub, ast.Call):
                continue
            dotted = dotted_from(sub.func)
            if dotted is None:
                continue
            head = dotted.split(".")[0]
            if head in ("self", "cls"):
                continue
            target = self.resolve_class(dotted, mi)
            if target:
                if top_level:
                    self._ensure_module_node(mi, rel)
                    src = mi.module
                else:
                    src = context
                kind = "member" if (in_class and self._assigned_to_self(sub)) else "transient"
                self.add_edge(src, target, kind, rel, sub.lineno)
                continue
            ftarget = self.resolve_function(dotted, mi)
            if ftarget and ftarget != context:
                if top_level:
                    self._ensure_module_node(mi, rel)
                    src = mi.module
                else:
                    src = context
                self.add_edge(src, ftarget, "calls", rel, sub.lineno)

    def _assigned_to_self(self, call):
        parent = getattr(call, "_pcm_parent", None)
        if isinstance(parent, ast.Assign):
            for t in parent.targets:
                if isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) \
                        and t.value.id == "self":
                    return True
        if isinstance(parent, ast.AnnAssign):
            t = parent.target
            if isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) \
                    and t.value.id == "self":
                return True
        return False

    # ---------------- post-processing ----------------

    def annotate_parents(self):
        for mi in self.modules.values():
            for node in ast.walk(mi.tree):
                for child in ast.iter_child_nodes(node):
                    child._pcm_parent = node

    def prune(self):
        """Drop call edges to functions that never (transitively) create anything,
        then drop function/module nodes left with no edges."""
        creators = set()
        out = {}
        for (src, dst, kind), _ in self.edges.items():
            out.setdefault(src, []).append((dst, kind))
            if kind in ("member", "transient", "received"):
                creators.add(src)
        # transitive closure over calls
        changed = True
        while changed:
            changed = False
            for (src, dst, kind) in list(self.edges.keys()):
                if kind == "calls" and dst in creators and src not in creators:
                    creators.add(src)
                    changed = True
        for key in list(self.edges.keys()):
            src, dst, kind = key
            if kind == "calls" and dst not in creators:
                del self.edges[key]
        used = set()
        for (src, dst, _kind) in self.edges.keys():
            used.add(src)
            used.add(dst)
        for nid in list(self.nodes.keys()):
            if self.nodes[nid]["kind"] in ("function", "module") and nid not in used:
                del self.nodes[nid]

    def to_json(self):
        edges = []
        for (src, dst, kind), data in sorted(self.edges.items()):
            if src not in self.nodes or dst not in self.nodes:
                continue
            edges.append({"src": src, "dst": dst, "kind": kind,
                          "count": data["count"], "sites": data["sites"]})
        return {"root": self.root, "nodes": self.nodes, "edges": edges}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--exclude", action="append", default=[])
    ap.add_argument("--include-tests", action="store_true")
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    excludes = DEFAULT_EXCLUDES | set(args.exclude)
    project = Project(root)

    for path in discover_files(root, excludes, args.include_tests):
        project.index_file(path)
    project.annotate_parents()
    for mi in project.modules.values():
        project.analyze_file(mi)
    project.prune()

    json.dump(project.to_json(), sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
