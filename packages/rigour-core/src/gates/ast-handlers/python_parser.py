import ast
import sys
import json

class MetricsVisitor(ast.NodeVisitor):
    def __init__(self):
        self.metrics = []

    def visit_FunctionDef(self, node):
        self.analyze_function(node)
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node):
        self.analyze_function(node)
        self.generic_visit(node)

    def visit_ClassDef(self, node):
        methods = [n for n in node.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
        self.metrics.append({
            "type": "class",
            "name": node.name,
            "methods": len(methods),
            "lineno": node.lineno
        })
        self.generic_visit(node)

    def analyze_function(self, node):
        complexity = 1
        for n in ast.walk(node):
            if isinstance(n, (ast.If, ast.While, ast.For, ast.AsyncFor, ast.Try, ast.ExceptHandler, ast.With, ast.AsyncWith)):
                complexity += 1
            elif isinstance(n, ast.BoolOp):
                complexity += len(n.values) - 1
            elif isinstance(n, ast.IfExp):
                complexity += 1
        
        params = len(node.args.args) + len(node.args.kwonlyargs)
        if node.args.vararg: params += 1
        if node.args.kwarg: params += 1

        self.metrics.append({
            "type": "function",
            "name": node.name,
            "complexity": complexity,
            "parameters": params,
            "lineno": node.lineno
        })

def analyze_code(content):
    try:
        tree = ast.parse(content)
        visitor = MetricsVisitor()
        visitor.visit(tree)
        return visitor.metrics
    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    content = sys.stdin.read()
    print(json.dumps(analyze_code(content)))
