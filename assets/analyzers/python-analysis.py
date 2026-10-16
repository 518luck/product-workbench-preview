"""Parse only. Project modules are never imported or executed by this adapter."""
import ast
import json
import sys

request = json.load(sys.stdin)
result = {"functions": [], "calls": [], "imports": [], "gaps": [], "moduleWrites":{}}
for source in request["files"]:
    text, file = source["text"], source["file"]
    lines = text.splitlines(keepends=True)
    offsets, total = [], 0
    for line in lines:
        offsets.append(total)
        total += len(line.encode("utf-16-le")) // 2

    def location(node):
        def at(line, column):
            # Python AST columns use UTF-8 bytes; the shared protocol uses UTF-16.
            prefix = lines[line - 1].encode("utf-8")[:column].decode("utf-8")
            return offsets[line - 1] + len(prefix.encode("utf-16-le")) // 2
        return [at(node.lineno, node.col_offset), at(node.end_lineno, node.end_col_offset)]

    try:
        tree = ast.parse(text, filename=file, type_comments=True)
    except (SyntaxError, ValueError) as error:
        result["gaps"].append({"file": file, "kind": "semantic", "message": str(error)})
        continue
    scope, owner = [], None
    module_writes=set()
    class ModuleWrites(ast.NodeVisitor):
        def visit_Name(self,node):
            if isinstance(node.ctx,ast.Store):module_writes.add(node.id)
        def visit_FunctionDef(self,node): pass
        visit_AsyncFunctionDef=visit_FunctionDef
        def visit_ClassDef(self,node):pass
    ModuleWrites().visit(tree)
    result["moduleWrites"][file]=sorted(module_writes)

    class Inspect(ast.NodeVisitor):
        def visit_FunctionDef(self, node):
            global owner
            previous = owner
            owner = location(node)[0]
            names = set()
            class Writes(ast.NodeVisitor):
                def visit_Name(self, child):
                    if isinstance(child.ctx, ast.Store): names.add(child.id)
                def visit_FunctionDef(self, child): names.add(child.name)
                visit_AsyncFunctionDef = visit_FunctionDef
                def visit_ClassDef(self, child): names.add(child.name)
            for statement in node.body: Writes().visit(statement)
            result["functions"].append({"file": file, "start": owner, "end": location(node)[1], "name": node.name,
                "scope": list(scope), "parameters": [arg.arg for arg in node.args.posonlyargs + node.args.args + node.args.kwonlyargs],
                "writes": sorted(names), "decorated": bool(node.decorator_list), "async": isinstance(node, ast.AsyncFunctionDef)})
            scope.append(node.name)
            for statement in node.body: self.visit(statement)
            scope.pop()
            owner = previous
        visit_AsyncFunctionDef = visit_FunctionDef
        def visit_ClassDef(self, node):
            scope.append(node.name)
            for statement in node.body: self.visit(statement)
            scope.pop()
        def visit_Call(self, node):
            result["calls"].append({"file": file, "owner": owner, "start": location(node)[0], "end": location(node)[1],
                "name": ast.unparse(node.func), "direct": isinstance(node.func, ast.Name),
                "arguments": [location(arg) for arg in node.args], "keywords": bool(node.keywords)})
            self.generic_visit(node)
        def visit_ImportFrom(self, node):
            for name in node.names: result["imports"].append({"file": file, "module": node.module or "", "level": node.level, "name": name.name, "alias": name.asname or name.name})
    Inspect().visit(tree)
json.dump(result, sys.stdout, ensure_ascii=False)
