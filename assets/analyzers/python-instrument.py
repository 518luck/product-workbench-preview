import ast
import json
import os
import sys

request = json.load(sys.stdin)
unsupported = []
for file in sorted({unit["file"] for unit in request["units"] if unit.get("language") == "python" and unit["id"] in request["selected"]}):
    filename = os.path.join(request["root"], file)
    with open(filename, encoding="utf-8") as stream: text = stream.read()
    lines, offsets, total = text.splitlines(keepends=True), [], 0
    for line in lines: offsets.append(total); total += len(line.encode("utf-16-le")) // 2
    def start(node): return offsets[node.lineno - 1] + len(lines[node.lineno - 1].encode()[:node.col_offset].decode().encode("utf-16-le")) // 2
    def end(node): return offsets[node.end_lineno - 1] + len(lines[node.end_lineno - 1].encode()[:node.end_col_offset].decode().encode("utf-16-le")) // 2
    units = {unit["start"]: unit for unit in request["units"] if unit["file"] == file and unit["id"] in request["selected"]}
    name = "__product_blueprint_probe"
    while name in text: name += "_"
    def call(method, args): return ast.Call(func=ast.Attribute(value=ast.Name(id=name, ctx=ast.Load()), attr=method, ctx=ast.Load()), args=args, keywords=[])
    class Transform(ast.NodeTransformer):
        owner = None
        def visit_FunctionDef(self, node):
            previous = self.owner; unit = units.get(start(node)); self.owner = None
            unsupported_kind = node.decorator_list or isinstance(node, ast.AsyncFunctionDef) or any(isinstance(child, (ast.Yield, ast.YieldFrom)) for child in ast.walk(node)) or node.args.vararg or node.args.kwarg or node.args.kwonlyargs
            if unit and not unsupported_kind:
                self.owner = unit
                node.decorator_list = [call("register", [ast.Constant(unit["id"])])]
            elif unit: unsupported.append({"unitId": unit["id"], "message": "装饰器、异步、生成器及动态参数签名需另行运行适配；未注入此函数。"})
            node.body = [self.visit(statement) for statement in node.body]
            self.owner = previous
            return node
        visit_AsyncFunctionDef = visit_FunctionDef
        def visit_Call(self, node):
            owner = self.owner
            fact = next((call for call in owner["calls"] if call["start"] == start(node) and call["end"] == end(node)), None) if owner else None
            node = self.generic_visit(node)
            if not fact or node.keywords or any(isinstance(arg, ast.Starred) for arg in node.args): return node
            arguments = [ast.Dict(keys=[ast.Constant("id"), ast.Constant("value")], values=[ast.Constant(fact["argumentIds"][index]), arg]) for index, arg in enumerate(node.args)]
            return ast.copy_location(call("invoke", [ast.Constant(owner["id"]), ast.Constant(fact["id"]), node.func, ast.List(elts=arguments, ctx=ast.Load())]), node)
        def visit_Return(self, node):
            fact = next((value for value in request["values"] if value["unitId"] == self.owner["id"] and value["kind"] == "return" and value["start"] == start(node)), None) if self.owner else None
            node = self.generic_visit(node)
            if fact: node.value = call("returned", [ast.Constant(self.owner["id"]), ast.Constant(fact["id"]), node.value or ast.Constant(None)])
            return node
        def visit_If(self, node):
            point = next((point for point in self.owner["reviewPoints"] if point["kind"] == "condition" and point["start"] == start(node.test)), None) if self.owner else None
            node = self.generic_visit(node)
            if point: node.test = call("branch", [ast.Constant(self.owner["id"]), ast.Constant(point["id"]), node.test])
            return node
        def visit_Raise(self,node):
            point=next((point for point in self.owner["reviewPoints"] if point["start"]==start(node) and point["field"]=="exceptions"),None) if self.owner else None
            node=self.generic_visit(node)
            if point and node.exc: node.exc=call("point",[ast.Constant(self.owner["id"]),ast.Constant(point["id"]),node.exc])
            return node
        def visit_Assign(self,node):
            point=next((point for point in self.owner["reviewPoints"] if point["start"]==start(node) and point["field"]=="sideEffects"),None) if self.owner else None
            node=self.generic_visit(node)
            if point: node.value=call("point",[ast.Constant(self.owner["id"]),ast.Constant(point["id"]),node.value])
            return node
    tree = Transform().visit(ast.parse(text, filename=filename))
    index = 1 if tree.body and isinstance(tree.body[0], ast.Expr) and isinstance(tree.body[0].value, ast.Constant) and isinstance(tree.body[0].value.value, str) else 0
    while index < len(tree.body) and isinstance(tree.body[index], ast.ImportFrom) and tree.body[index].module == "__future__": index += 1
    tree.body.insert(index, ast.Import(names=[ast.alias(name="__product_blueprint_probe", asname=name)]))
    ast.fix_missing_locations(tree)
    with open(filename, "w", encoding="utf-8") as stream: stream.write(ast.unparse(tree) + "\n")
json.dump(unsupported, sys.stdout, ensure_ascii=False)
