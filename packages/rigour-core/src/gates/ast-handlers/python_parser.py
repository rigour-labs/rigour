import ast
import sys
import json
import re

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


class SecurityVisitor(ast.NodeVisitor):
    """Detects security issues in Python code via AST analysis."""

    def __init__(self, content):
        self.issues = []
        self.content = content
        self.lines = content.split('\n')

    def visit_Assign(self, node):
        """Check for hardcoded secrets and CSRF disabled."""
        for target in node.targets:
            if isinstance(target, ast.Name):
                name = target.id
                # Check for hardcoded SECRET_KEY
                if name == 'SECRET_KEY':
                    if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                        self.issues.append({
                            "type": "security",
                            "issue": "hardcoded_secret",
                            "name": "SECRET_KEY",
                            "lineno": node.lineno,
                            "message": "Hardcoded SECRET_KEY detected. Use environment variables instead."
                        })
                # Check for hardcoded passwords/tokens
                if name.upper() in ('PASSWORD', 'API_KEY', 'TOKEN', 'AUTH_TOKEN', 'PRIVATE_KEY', 'AWS_SECRET_KEY'):
                    if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                        self.issues.append({
                            "type": "security",
                            "issue": "hardcoded_secret",
                            "name": name,
                            "lineno": node.lineno,
                            "message": f"Hardcoded {name} detected. Use environment variables instead."
                        })
                # Check for csrf = False
                if name.lower() in ('csrf', 'csrf_enabled', 'wtf_csrf_enabled'):
                    if isinstance(node.value, ast.Constant) and node.value.value == False:
                        self.issues.append({
                            "type": "security",
                            "issue": "csrf_disabled",
                            "name": name,
                            "lineno": node.lineno,
                            "message": "CSRF protection is disabled. This is a security vulnerability."
                        })
        self.generic_visit(node)

    def visit_Call(self, node):
        """Check for dangerous function calls."""
        func_name = None
        if isinstance(node.func, ast.Name):
            func_name = node.func.id
        elif isinstance(node.func, ast.Attribute):
            func_name = node.func.attr

        # Check for eval/exec usage
        if func_name in ('eval', 'exec'):
            self.issues.append({
                "type": "security",
                "issue": "code_injection",
                "name": func_name,
                "lineno": node.lineno,
                "message": f"Use of {func_name}() detected. This can lead to code injection vulnerabilities."
            })

        # Check for pickle usage (insecure deserialization)
        if func_name in ('loads', 'load') and isinstance(node.func, ast.Attribute):
            if isinstance(node.func.value, ast.Name) and node.func.value.id == 'pickle':
                self.issues.append({
                    "type": "security",
                    "issue": "insecure_deserialization",
                    "name": "pickle",
                    "lineno": node.lineno,
                    "message": "Pickle deserialization is unsafe. Use json instead for untrusted data."
                })

        # Check for shell=True in subprocess
        if func_name in ('run', 'call', 'Popen', 'check_output', 'check_call'):
            for keyword in node.keywords:
                if keyword.arg == 'shell' and isinstance(keyword.value, ast.Constant) and keyword.value.value == True:
                    self.issues.append({
                        "type": "security",
                        "issue": "command_injection",
                        "name": func_name,
                        "lineno": node.lineno,
                        "message": "shell=True in subprocess can lead to command injection."
                    })

        self.generic_visit(node)

    def check_sql_injection(self):
        """Check for SQL injection patterns using regex on source."""
        sql_patterns = [
            (r'execute\s*\(\s*["\'].*%s', 'SQL string formatting with %s'),
            (r'execute\s*\(\s*f["\']', 'SQL f-string'),
            (r'execute\s*\(\s*["\'].*\+', 'SQL string concatenation'),
            (r'cursor\.execute\s*\(\s*["\'].*\.format\s*\(', 'SQL .format()'),
        ]
        for pattern, desc in sql_patterns:
            for i, line in enumerate(self.lines, 1):
                if re.search(pattern, line, re.IGNORECASE):
                    self.issues.append({
                        "type": "security",
                        "issue": "sql_injection",
                        "name": desc,
                        "lineno": i,
                        "message": f"Potential SQL injection: {desc}. Use parameterized queries."
                    })


def analyze_code(content):
    try:
        tree = ast.parse(content)

        # Collect metrics
        visitor = MetricsVisitor()
        visitor.visit(tree)

        # Collect security issues
        security_visitor = SecurityVisitor(content)
        security_visitor.visit(tree)
        security_visitor.check_sql_injection()

        return {
            "metrics": visitor.metrics,
            "security": security_visitor.issues
        }
    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    content = sys.stdin.read()
    print(json.dumps(analyze_code(content)))
