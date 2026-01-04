import { execa } from 'execa';
import { ASTHandler, ASTHandlerContext } from './base.js';
import { Failure } from '../../types/index.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class PythonHandler extends ASTHandler {
    supports(file: string): boolean {
        return /\.py$/.test(file);
    }

    async run(context: ASTHandlerContext): Promise<Failure[]> {
        const failures: Failure[] = [];
        const scriptPath = path.join(__dirname, 'python_parser.py');

        try {
            const { stdout } = await execa('python3', [scriptPath], {
                input: context.content,
                cwd: context.cwd
            });

            const metrics = JSON.parse(stdout);
            if (metrics.error) return [];

            const astConfig = this.config.ast || {};
            const maxComplexity = astConfig.complexity || 10;
            const maxParams = astConfig.max_params || 5;
            const maxMethods = astConfig.max_methods || 10;

            for (const item of metrics) {
                if (item.type === 'function') {
                    if (item.parameters > maxParams) {
                        failures.push({
                            id: 'AST_MAX_PARAMS',
                            title: `Function '${item.name}' has ${item.parameters} parameters (max: ${maxParams})`,
                            details: `High parameter count detected in ${context.file} at line ${item.lineno}`,
                            files: [context.file],
                            hint: `Reduce number of parameters or use an options object.`
                        });
                    }
                    if (item.complexity > maxComplexity) {
                        failures.push({
                            id: 'AST_COMPLEXITY',
                            title: `Function '${item.name}' has complexity of ${item.complexity} (max: ${maxComplexity})`,
                            details: `High complexity detected in ${context.file} at line ${item.lineno}`,
                            files: [context.file],
                            hint: `Refactor '${item.name}' into smaller, more focused functions.`
                        });
                    }
                } else if (item.type === 'class') {
                    if (item.methods > maxMethods) {
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

        } catch (e: any) {
            // If python3 is missing, we skip AST but other gates still run
        }

        return failures;
    }
}
