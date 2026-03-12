import fs from 'fs-extra';
import path from 'path';
import readline from 'node:readline';
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
        const report = await this.findCoverageReport(context);
        if (!report) {
            // If no reports found, and coverage is required, we could flag it.
            // But for now, we'll just skip silently if not configured.
            return [];
        }

        // 2. Parse coverage (LCOV or Istanbul JSON)
        const coverageData = await this.parseCoverage(path.join(context.cwd, report));

        // 3. Quality Handshake: SME SME LOGIC
        // We look for files that have high complexity but low coverage.
        // In a real implementation, we would share data between ASTGate and CoverageGate.
        // For this demo, we'll implement a standalone check.

        for (const [file, stats] of Object.entries(coverageData)) {
            if (!stats.found) continue;
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

    private async findCoverageReport(context: GateContext): Promise<string | null> {
        const candidates = [
            'lcov.info',
            'coverage/lcov.info',
            'coverage/coverage-final.json',
            'coverage-final.json',
            '.nyc_output/coverage-final.json',
        ];

        for (const candidate of candidates) {
            if (await fs.pathExists(path.join(context.cwd, candidate))) {
                return candidate;
            }
        }

        const reports = await globby(['**/lcov.info', '**/coverage-final.json'], {
            cwd: context.cwd,
            gitignore: true,
            followSymbolicLinks: false,
            onlyFiles: true,
            deep: 8,
            ignore: [...new Set([
                ...(context.ignore || []),
                '**/node_modules/**',
                '**/.git/**',
                '**/dist/**',
                '**/build/**',
                '**/coverage/**',
                '**/.next/**',
                '**/out/**',
                '**/target/**',
                '**/vendor/**',
                '**/.venv/**',
                '**/venv/**',
            ])],
        });

        if (reports.length === 0) return null;
        reports.sort();
        return reports[0];
    }

    private async parseCoverage(reportPath: string): Promise<Record<string, { found: number, hit: number, isComplex: boolean }>> {
        if (reportPath.endsWith('.json')) {
            return this.parseCoverageFinalJson(reportPath);
        }
        return this.parseLcov(reportPath);
    }

    private async parseLcov(reportPath: string): Promise<Record<string, { found: number, hit: number, isComplex: boolean }>> {
        const results: Record<string, { found: number, hit: number, isComplex: boolean }> = {};
        let currentFile = '';

        const rl = readline.createInterface({
            input: fs.createReadStream(reportPath, { encoding: 'utf-8' }),
            crlfDelay: Infinity,
        });

        for await (const line of rl) {
            if (line.startsWith('SF:')) {
                currentFile = line.substring(3);
                results[currentFile] = { found: 0, hit: 0, isComplex: false };
            } else if (line.startsWith('LF:')) {
                if (!currentFile) continue;
                const found = parseInt(line.substring(3));
                results[currentFile].found = found;
                // SME Logic: If a file has > 100 logical lines, it's considered "Complex"
                // and triggers the higher (80%) coverage requirement.
                if (found > 100) results[currentFile].isComplex = true;
            } else if (line.startsWith('LH:')) {
                if (!currentFile) continue;
                results[currentFile].hit = parseInt(line.substring(3));
            }
        }
        return results;
    }

    private async parseCoverageFinalJson(reportPath: string): Promise<Record<string, { found: number, hit: number, isComplex: boolean }>> {
        const raw = await fs.readJson(reportPath);
        const results: Record<string, { found: number, hit: number, isComplex: boolean }> = {};

        for (const [file, data] of Object.entries<any>(raw || {})) {
            const statements = data?.s || {};
            const statementHits = Object.values(statements).map((count: any) => Number(count) || 0);
            const found = statementHits.length;
            const hit = statementHits.filter((count) => count > 0).length;
            results[file] = { found, hit, isComplex: found > 100 };
        }

        return results;
    }
}
