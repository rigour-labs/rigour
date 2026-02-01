import { execa } from 'execa';
import { ASTHandler, ASTHandlerContext } from './base.js';
import { Failure } from '../../types/index.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface SecurityIssue {
    type: string;
    issue: string;
    name: string;
    lineno: number;
    message: string;
}

interface MetricItem {
    type: string;
    name: string;
    complexity?: number;
    parameters?: number;
    methods?: number;
    lineno: number;
}

interface PythonAnalysisResult {
    metrics?: MetricItem[];
    security?: SecurityIssue[];
    error?: string;
}

export class PythonHandler extends ASTHandler {
    supports(file: string): boolean {
        return /\.py$/.test(file);
    }

    async run(context: ASTHandlerContext): Promise<Failure[]> {
        const failures: Failure[] = [];
        const scriptPath = path.join(__dirname, 'python_parser.py');

        // Dynamic command detection for cross-platform support (Mac/Linux usually python3, Windows usually python)
        let pythonCmd = 'python3';
        try {
            await execa('python3', ['--version']);
        } catch (e) {
            try {
                await execa('python', ['--version']);
                pythonCmd = 'python';
            } catch (e2) {
                // Both missing - handled by main catch
            }
        }

        try {
            const { stdout } = await execa(pythonCmd, [scriptPath], {
                input: context.content,
                cwd: context.cwd
            });

            const result: PythonAnalysisResult = JSON.parse(stdout);
            if (result.error) return [];

            const astConfig = this.config.ast || {};
            const safetyConfig = this.config.safety || {};
            const maxComplexity = astConfig.complexity || 10;
            const maxParams = astConfig.max_params || 5;
            const maxMethods = astConfig.max_methods || 10;

            // Process metrics (complexity, params, methods)
            const metrics = result.metrics || [];
            for (const item of metrics) {
                if (item.type === 'function') {
                    if (item.parameters && item.parameters > maxParams) {
                        failures.push({
                            id: 'AST_MAX_PARAMS',
                            title: `Function '${item.name}' has ${item.parameters} parameters (max: ${maxParams})`,
                            details: `High parameter count detected in ${context.file} at line ${item.lineno}`,
                            files: [context.file],
                            hint: `Reduce number of parameters or use an options object.`
                        });
                    }
                    if (item.complexity && item.complexity > maxComplexity) {
                        failures.push({
                            id: 'AST_COMPLEXITY',
                            title: `Function '${item.name}' has complexity of ${item.complexity} (max: ${maxComplexity})`,
                            details: `High complexity detected in ${context.file} at line ${item.lineno}`,
                            files: [context.file],
                            hint: `Refactor '${item.name}' into smaller, more focused functions.`
                        });
                    }
                } else if (item.type === 'class') {
                    if (item.methods && item.methods > maxMethods) {
                        failures.push({
                            id: 'AST_MAX_METHODS',
                            title: `Class '${item.name}' has ${item.methods} methods (max: ${maxMethods})`,
                            details: `God Object pattern detected in ${context.file} at line ${item.lineno}`,
                            files: [context.file],
                            hint: `Split class '${item.name}' into smaller services.`
                        });
                    }
                }
            }

            // Process security issues (CSRF, hardcoded secrets, SQL injection, etc.)
            const securityIssues = result.security || [];
            for (const issue of securityIssues) {
                const issueIdMap: Record<string, string> = {
                    'hardcoded_secret': 'SECURITY_HARDCODED_SECRET',
                    'csrf_disabled': 'SECURITY_CSRF_DISABLED',
                    'code_injection': 'SECURITY_CODE_INJECTION',
                    'insecure_deserialization': 'SECURITY_INSECURE_DESERIALIZATION',
                    'command_injection': 'SECURITY_COMMAND_INJECTION',
                    'sql_injection': 'SECURITY_SQL_INJECTION'
                };

                const id = issueIdMap[issue.issue] || 'SECURITY_ISSUE';

                failures.push({
                    id,
                    title: issue.message,
                    details: `Security issue in ${context.file} at line ${issue.lineno}: ${issue.name}`,
                    files: [context.file],
                    hint: this.getSecurityHint(issue.issue)
                });
            }

        } catch (e: any) {
            // If python3 is missing, we skip AST but other gates still run
        }

        return failures;
    }

    private getSecurityHint(issueType: string): string {
        const hints: Record<string, string> = {
            'hardcoded_secret': 'Use environment variables: os.environ.get("SECRET_KEY")',
            'csrf_disabled': 'Enable CSRF protection for all forms handling sensitive data',
            'code_injection': 'Avoid eval/exec. Use safer alternatives like ast.literal_eval() for data parsing',
            'insecure_deserialization': 'Use json.loads() instead of pickle for untrusted data',
            'command_injection': 'Use subprocess with shell=False and pass arguments as a list',
            'sql_injection': 'Use parameterized queries: cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))'
        };
        return hints[issueType] || 'Review and fix the security issue.';
    }
}
