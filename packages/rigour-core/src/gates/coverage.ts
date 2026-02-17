import fs from 'fs-extra';
import path from 'path';
import { Gate, GateContext } from './base.js';
import { Failure, Gates } from '../types/index.js';
import { globby } from 'globby';

export class CoverageGate extends Gate {
    constructor(private config: Gates) {
        super('coverage-guard', 'Dynamic Coverage Guard');
    }

    async run(context: GateContext): Promise<Failure[]> {
        const failures: Failure[] = [];

        // 1. Locate coverage report (lcov.info is standard)
        const reports = await globby(['**/lcov.info', '**/coverage-final.json'], {
            cwd: context.cwd,
            ignore: ['node_modules/**']
        });

        if (reports.length === 0) {
            // If no reports found, and coverage is required, we could flag it.
            // But for now, we'll just skip silently if not configured.
            return [];
        }

        // 2. Parse coverage (Simplified LCOV parser for demonstration)
        const coverageData = await this.parseLcov(path.join(context.cwd, reports[0]));

        // 3. Quality Handshake: SME SME LOGIC
        // We look for files that have high complexity but low coverage.
        // In a real implementation, we would share data between ASTGate and CoverageGate.
        // For this demo, we'll implement a standalone check.

        for (const [file, stats] of Object.entries(coverageData)) {
            const coverage = (stats.hit / stats.found) * 100;
            const threshold = stats.isComplex ? 80 : 50; // SME logic: Complex files need higher coverage

            if (coverage < threshold) {
                failures.push({
                    id: 'DYNAMIC_COVERAGE_LOW',
                    title: `Low coverage for high-risk file: ${file}`,
                    details: `Current coverage: ${coverage.toFixed(2)}%. Required: ${threshold}% due to structural risk.`,
                    files: [file],
                    hint: `Add dynamic tests to cover complex logical branches in this file.`,
                    severity: 'medium' as const,
                    provenance: 'traditional' as const
                });
            }
        }

        return failures;
    }

    private async parseLcov(reportPath: string): Promise<Record<string, { found: number, hit: number, isComplex: boolean }>> {
        const content = await fs.readFile(reportPath, 'utf-8');
        const results: Record<string, { found: number, hit: number, isComplex: boolean }> = {};
        let currentFile = '';

        for (const line of content.split('\n')) {
            if (line.startsWith('SF:')) {
                currentFile = line.substring(3);
                results[currentFile] = { found: 0, hit: 0, isComplex: false };
            } else if (line.startsWith('LF:')) {
                const found = parseInt(line.substring(3));
                results[currentFile].found = found;
                // SME Logic: If a file has > 100 logical lines, it's considered "Complex"
                // and triggers the higher (80%) coverage requirement.
                if (found > 100) results[currentFile].isComplex = true;
            } else if (line.startsWith('LH:')) {
                results[currentFile].hit = parseInt(line.substring(3));
            }
        }
        return results;
    }
}
