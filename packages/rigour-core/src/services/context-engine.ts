import { FileScanner } from '../utils/scanner.js';
import { Config } from '../types/index.js';
import path from 'path';
import fs from 'fs-extra';

export interface ProjectAnchor {
    id: string;
    type: 'env' | 'naming' | 'import';
    pattern: string;
    confidence: number;
    occurrences: number;
}

export interface GoldenRecord {
    anchors: ProjectAnchor[];
    metadata: {
        scannedFiles: number;
        detectedCasing: 'camelCase' | 'snake_case' | 'PascalCase' | 'unknown';
    };
}

export class ContextEngine {
    constructor(private config: Config) { }

    async discover(cwd: string): Promise<GoldenRecord> {
        const anchors: ProjectAnchor[] = [];
        const files = await FileScanner.findFiles({
            cwd,
            patterns: [
                '**/*.{ts,js,py,yaml,yml,json}',
                '.env*',
                '**/.env*',
                '**/package.json',
                '**/Dockerfile',
                '**/*.tf'
            ]
        });

        const limit = this.config.gates.context?.mining_depth || 100;
        const samples = files.slice(0, limit);

        const envVars = new Map<string, number>();
        let scannedFiles = 0;

        for (const file of samples) {
            try {
                const content = await fs.readFile(path.join(cwd, file), 'utf-8');
                scannedFiles++;
                this.mineEnvVars(content, file, envVars);
            } catch (e) { }
        }

        // Logs removed to avoid stdout pollution in JSON mode

        // Convert envVars to anchors
        for (const [name, count] of envVars.entries()) {
            const confidence = count >= 2 ? 1 : 0.5;
            anchors.push({
                id: name,
                type: 'env',
                pattern: name,
                occurrences: count,
                confidence
            });
        }

        return {
            anchors,
            metadata: {
                scannedFiles,
                detectedCasing: 'unknown', // TODO: Implement casing discovery
            }
        };
    }

    private mineEnvVars(content: string, file: string, registry: Map<string, number>) {
        const isAnchorSource = file.includes('.env') || file.includes('yml') || file.includes('yaml');

        if (isAnchorSource) {
            const matches = content.matchAll(/^\s*([A-Z0-9_]+)\s*=/gm);
            for (const match of matches) {
                // Anchors from .env count for more initially
                registry.set(match[1], (registry.get(match[1]) || 0) + 2);
            }
        }

        // Source code matches (process.env.VAR or process.env['VAR'])
        const tsJsMatches = content.matchAll(/process\.env(?:\.([A-Z0-9_]+)|\[['"]([A-Z0-9_]+)['"]\])/g);
        for (const match of tsJsMatches) {
            const name = match[1] || match[2];
            this.incrementRegistry(registry, name);
        }

        // Python matches (os.environ.get('VAR') or os.environ['VAR'])
        const pyMatches = content.matchAll(/os\.environ(?:\.get\(|\[)['"]([A-Z0-9_]+)['"]/g);
        for (const match of pyMatches) {
            this.incrementRegistry(registry, match[1]);
        }
    }

    private incrementRegistry(registry: Map<string, number>, key: string) {
        registry.set(key, (registry.get(key) || 0) + 1);
    }
}
