/**
 * Security Detector
 * 
 * Detects CVEs and security vulnerabilities in the project's dependencies
 * and alerts the AI/Editor before code is written.
 */

import { execa } from 'execa';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import type { SecurityEntry, SecurityResult } from './types.js';

interface SecurityCache {
    lockfileHash: string;
    timestamp: string;
    result: SecurityResult;
}

interface AuditCommand {
    cmd: string;
    args: string[];
}

export class SecurityDetector {
    private rootDir: string;
    private cachePath: string;
    private CACHE_TTL = 3600000; // 1 hour in milliseconds

    constructor(rootDir: string) {
        this.rootDir = rootDir;
        this.cachePath = path.join(rootDir, '.rigour', 'security-cache.json');
    }

    /**
     * Run a live security audit using NPM.
     * This provides the latest CVE info from the NPM registry.
     */
    async runAudit(): Promise<SecurityResult> {
        try {
            const lockfileHash = await this.getLockfileHash();
            const cached = await this.getCachedResult(lockfileHash);

            if (cached) {
                return cached;
            }

            const auditData = await this.runBestAvailableAudit();
            const vulnerabilities = this.extractVulnerabilities(auditData);

            const result: SecurityResult = {
                status: vulnerabilities.length > 0 ? 'VULNERABLE' : 'SECURE',
                vulnerabilities: vulnerabilities.sort((a, b) => {
                    const severityOrder = { critical: 0, high: 1, moderate: 2, low: 3 };
                    return (severityOrder as any)[a.severity] - (severityOrder as any)[b.severity];
                })
            };

            // Save to cache
            await this.saveCache(lockfileHash, result);

            return result;
        } catch (error) {
            console.error('Security audit failed:', error);
            return { status: 'SECURE', vulnerabilities: [] };
        }
    }

    /**
     * Get a quick summary for the AI context.
     */
    async getSecuritySummary(): Promise<string> {
        const result = await this.runAudit();
        if (result.status === 'SECURE') return '✅ No known vulnerabilities found in dependencies.';

        const topVulns = result.vulnerabilities.slice(0, 3);
        let summary = `⚠️  FOUND ${result.vulnerabilities.length} VULNERABILITIES:\n`;

        for (const v of topVulns) {
            summary += `- [${v.severity.toUpperCase()}] ${v.packageName}: ${v.title} (${v.url})\n`;
        }

        if (result.vulnerabilities.length > 3) {
            summary += `- ...and ${result.vulnerabilities.length - 3} more. Run 'rigour check' for full report.`;
        }

        return summary;
    }

    private async getLockfileHash(): Promise<string> {
        const lockfiles = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'];
        for (const file of lockfiles) {
            try {
                const content = await fs.readFile(path.join(this.rootDir, file), 'utf-8');
                return createHash('sha256').update(content).digest('hex').slice(0, 16);
            } catch {
                continue;
            }
        }
        return 'no-lockfile';
    }

    private async getCachedResult(currentHash: string): Promise<SecurityResult | null> {
        try {
            const content = await fs.readFile(this.cachePath, 'utf-8');
            const cache: SecurityCache = JSON.parse(content);

            const isExpired = Date.now() - new Date(cache.timestamp).getTime() > this.CACHE_TTL;
            if (!isExpired && cache.lockfileHash === currentHash) {
                return cache.result;
            }
        } catch {
            // No cache or invalid cache
        }
        return null;
    }

    private async runBestAvailableAudit(): Promise<any> {
        const candidates = await this.getAuditCommandCandidates();

        let lastError: unknown = null;
        for (const candidate of candidates) {
            try {
                const { stdout, stderr } = await execa(candidate.cmd, candidate.args, {
                    cwd: this.rootDir,
                    reject: false // audit tools return non-zero when vulnerabilities are found
                });
                const output = stdout || stderr;
                return JSON.parse(output);
            } catch (error) {
                lastError = error;
            }
        }

        throw lastError || new Error('No audit command available');
    }

    private async getAuditCommandCandidates(): Promise<AuditCommand[]> {
        const hasPnpmLock = await fs.access(path.join(this.rootDir, 'pnpm-lock.yaml')).then(() => true).catch(() => false);
        if (hasPnpmLock) {
            return [
                { cmd: 'pnpm', args: ['audit', '--json'] },
                { cmd: 'npm', args: ['audit', '--json'] }
            ];
        }

        const hasYarnLock = await fs.access(path.join(this.rootDir, 'yarn.lock')).then(() => true).catch(() => false);
        if (hasYarnLock) {
            return [
                { cmd: 'yarn', args: ['npm', 'audit', '--json'] },
                { cmd: 'npm', args: ['audit', '--json'] }
            ];
        }

        return [{ cmd: 'npm', args: ['audit', '--json'] }];
    }

    private extractVulnerabilities(auditData: any): SecurityEntry[] {
        const vulnerabilities: SecurityEntry[] = [];

        if (!auditData || !auditData.vulnerabilities || typeof auditData.vulnerabilities !== 'object') {
            return vulnerabilities;
        }

        for (const [name, vuln] of Object.entries(auditData.vulnerabilities as any)) {
            vulnerabilities.push(this.toSecurityEntry(name, vuln));
        }

        return vulnerabilities;
    }

    private toSecurityEntry(name: string, vuln: any): SecurityEntry {
        const viaList = Array.isArray(vuln?.via) ? vuln.via : [];
        const via = viaList[0];
        const cveId = via?.name ?? 'N/A';
        const title = via?.title ?? `Vulnerability in ${name}`;
        const url = via?.url ?? `https://www.npmjs.com/package/${name}/vulnerability`;
        const currentVersion = vuln?.nodes?.[0] ? vuln.version : undefined;

        return {
            cveId,
            packageName: name,
            vulnerableRange: vuln.range,
            severity: vuln.severity,
            title,
            url,
            currentVersion,
        };
    }

    private async saveCache(hash: string, result: SecurityResult): Promise<void> {
        try {
            await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
            const cache: SecurityCache = {
                lockfileHash: hash,
                timestamp: new Date().toISOString(),
                result
            };
            await fs.writeFile(this.cachePath, JSON.stringify(cache, null, 2), 'utf-8');
        } catch (error) {
            console.warn('Failed to save security cache:', error);
        }
    }
}
