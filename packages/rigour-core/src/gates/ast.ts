import fs from 'fs-extra';
import path from 'path';
import { globby } from 'globby';
import { Gate, GateContext } from './base.js';
import { Failure, Gates } from '../types/index.js';
import { ASTHandler } from './ast-handlers/base.js';
import { TypeScriptHandler } from './ast-handlers/typescript.js';
import { PythonHandler } from './ast-handlers/python.js';
import { UniversalASTHandler } from './ast-handlers/universal.js';

export class ASTGate extends Gate {
    private handlers: ASTHandler[] = [];

    constructor(private config: Gates) {
        super('ast-analysis', 'AST Structural Analysis');
        this.handlers.push(new TypeScriptHandler(config));
        this.handlers.push(new PythonHandler(config));
        this.handlers.push(new UniversalASTHandler(config));
    }

    async run(context: GateContext): Promise<Failure[]> {
        const failures: Failure[] = [];

        const patterns = (context.patterns || ['**/*.{ts,js,tsx,jsx,py,go,rs,cs,java,rb,c,cpp,php,swift,kt}']).map(p => p.replace(/\\/g, '/'));
        const ignore = (context.ignore || ['node_modules/**', 'dist/**', 'build/**', '**/*.test.*', '**/*.spec.*', '**/__pycache__/**']).map(p => p.replace(/\\/g, '/'));
        const normalizedCwd = context.cwd.replace(/\\/g, '/');

        // Find all supported files
        const files = await globby(patterns, {
            cwd: normalizedCwd,
            ignore: ignore,
        });

        for (const file of files) {
            const handler = this.handlers.find(h => h.supports(file));
            if (!handler) continue;

            const fullPath = path.join(context.cwd, file);
            try {
                const content = await fs.readFile(fullPath, 'utf-8');
                const gateFailures = await handler.run({
                    cwd: context.cwd,
                    file: file,
                    content
                });
                failures.push(...gateFailures);
            } catch (error: any) {
                // Individual file read failures shouldn't crash the whole run
            }
        }

        return failures;
    }
}
