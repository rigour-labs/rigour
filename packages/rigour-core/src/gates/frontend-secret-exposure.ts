import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import fs from 'fs-extra';
import path from 'path';

export interface FrontendSecretExposureConfig {
    enabled?: boolean;
    block_on_severity?: 'critical' | 'high' | 'medium' | 'low';
    check_process_env?: boolean;
    check_import_meta_env?: boolean;
    secret_env_name_patterns?: string[];
    safe_public_prefixes?: string[];
    frontend_path_patterns?: string[];
    server_path_patterns?: string[];
    allowlist_env_names?: string[];
}

interface EnvExposureMatch {
    file: string;
    line: number;
    envVar: string;
    source: 'process.env' | 'import.meta.env';
    severity: 'critical' | 'high' | 'medium' | 'low';
}

const DEFAULT_SECRET_ENV_NAME_PATTERNS = [
    '(?:^|_)(?:secret|private)(?:_|$)',
    '(?:^|_)(?:token|api[_-]?key|access[_-]?key|client[_-]?secret|signing|webhook)(?:_|$)',
    '(?:^|_)(?:db[_-]?url|database[_-]?url|connection[_-]?string)(?:_|$)',
];

const DEFAULT_SAFE_PUBLIC_PREFIXES = [
    'NEXT_PUBLIC_',
    'VITE_',
    'PUBLIC_',
    'NUXT_PUBLIC_',
    'REACT_APP_',
];

const DEFAULT_FRONTEND_PATH_PATTERNS = [
    '(^|/)pages/(?!api/)',
    '(^|/)components/',
    '(^|/)src/components/',
    '(^|/)src/views/',
    '(^|/)src/app/',
    '(^|/)app/(?!api/)',
    '(^|/)views/',
    '(^|/)public/',
];

const DEFAULT_SERVER_PATH_PATTERNS = [
    '(^|/)pages/api/',
    '(^|/)src/pages/api/',
    '(^|/)app/api/',
    '(^|/)src/app/api/',
    '\\.server\\.(?:ts|tsx|js|jsx|mjs|cjs)$',
];

export class FrontendSecretExposureGate extends Gate {
    private config: Required<FrontendSecretExposureConfig>;
    private severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };

    constructor(config: FrontendSecretExposureConfig = {}) {
        super('frontend-secret-exposure', 'Frontend Secret Exposure Detection');
        this.config = {
            enabled: config.enabled ?? true,
            block_on_severity: config.block_on_severity ?? 'high',
            check_process_env: config.check_process_env ?? true,
            check_import_meta_env: config.check_import_meta_env ?? true,
            secret_env_name_patterns: config.secret_env_name_patterns ?? DEFAULT_SECRET_ENV_NAME_PATTERNS,
            safe_public_prefixes: config.safe_public_prefixes ?? DEFAULT_SAFE_PUBLIC_PREFIXES,
            frontend_path_patterns: config.frontend_path_patterns ?? DEFAULT_FRONTEND_PATH_PATTERNS,
            server_path_patterns: config.server_path_patterns ?? DEFAULT_SERVER_PATH_PATTERNS,
            allowlist_env_names: config.allowlist_env_names ?? [],
        };
    }

    protected get provenance(): Provenance { return 'security'; }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) return [];

        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
            ignore: [...(context.ignore || []), '**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**', '**/coverage/**'],
        });

        const scanFiles = files.filter(file => !this.shouldSkipFile(file));
        const findings: EnvExposureMatch[] = [];
        Logger.info(`Frontend Secret Exposure Gate: Scanning ${scanFiles.length} files`);

        for (const file of scanFiles) {
            const fullPath = path.join(context.cwd, file);
            let content = '';
            try {
                content = await fs.readFile(fullPath, 'utf-8');
            } catch {
                continue;
            }

            if (!this.isClientBundled(file, content)) continue;
            findings.push(...this.findEnvExposures(file, content));
        }

        findings.sort((a, b) => this.severityOrder[a.severity] - this.severityOrder[b.severity]);
        const threshold = this.severityOrder[this.config.block_on_severity];

        return findings
            .filter(f => this.severityOrder[f.severity] <= threshold)
            .map(f => this.createFailure(
                `Potential frontend secret exposure: ${f.source}.${f.envVar} is referenced in client-bundled code.`,
                [f.file],
                'Move secret usage to server-only code (API route/server action) and expose only public-safe values.',
                'Security: Frontend Secret Exposure',
                f.line,
                f.line,
                f.severity
            ));
    }

    private shouldSkipFile(file: string): boolean {
        const normalized = file.replace(/\\/g, '/');
        if (/\.(test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(normalized)) return true;
        if (/\/(?:__tests__|tests|test|__test__|e2e|fixtures|mocks)\//.test(`/${normalized}`)) return true;
        if (/\/(?:examples|studio-dist)\//.test(`/${normalized}`)) return true;
        return false;
    }

    private isClientBundled(file: string, content: string): boolean {
        const normalized = file.replace(/\\/g, '/');
        if (this.matchesAnyPattern(normalized, this.config.server_path_patterns)) return false;
        if (this.isServerOnlyContent(content)) return false;
        if (/^\s*['"]use client['"]\s*;?/m.test(content)) return true;
        if (this.matchesAnyPattern(normalized, this.config.frontend_path_patterns)) return true;
        return false;
    }

    private isServerOnlyContent(content: string): boolean {
        if (/from\s+['"]server-only['"]/.test(content)) return true;
        if (/import\s+['"]server-only['"]/.test(content)) return true;
        if (/export\s+async\s+function\s+getServerSideProps\s*\(/.test(content)) return true;
        if (/export\s+async\s+function\s+getStaticProps\s*\(/.test(content)) return true;
        if (/['"]use server['"]/.test(content)) return true;
        return false;
    }

    private findEnvExposures(file: string, content: string): EnvExposureMatch[] {
        const findings: EnvExposureMatch[] = [];

        if (this.config.check_process_env) {
            const processEnvRegex = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
            findings.push(...this.collectMatches(file, content, processEnvRegex, 'process.env'));
        }

        if (this.config.check_import_meta_env) {
            const importMetaRegex = /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
            findings.push(...this.collectMatches(file, content, importMetaRegex, 'import.meta.env'));
        }

        return findings;
    }

    private collectMatches(
        file: string,
        content: string,
        regex: RegExp,
        source: 'process.env' | 'import.meta.env'
    ): EnvExposureMatch[] {
        const matches: EnvExposureMatch[] = [];
        const scanRegex = new RegExp(regex.source, 'g');
        for (const match of content.matchAll(scanRegex)) {
            const envVar = match[1];
            if (!this.isSecretLikeEnvName(envVar)) continue;

            const startIndex = match.index ?? 0;
            const beforeMatch = content.slice(0, startIndex);
            const line = beforeMatch.split('\n').length;

            matches.push({
                file,
                line,
                envVar,
                source,
                severity: 'high',
            });
        }

        return matches;
    }

    private isSecretLikeEnvName(envVar: string): boolean {
        if (this.config.allowlist_env_names.includes(envVar)) return false;
        if (this.config.safe_public_prefixes.some(prefix => envVar.startsWith(prefix))) return false;

        return this.config.secret_env_name_patterns.some(pattern => {
            try {
                return new RegExp(pattern, 'i').test(envVar);
            } catch {
                return false;
            }
        });
    }

    private matchesAnyPattern(value: string, patterns: string[]): boolean {
        return patterns.some(pattern => {
            try {
                return new RegExp(pattern, 'i').test(value);
            } catch {
                return false;
            }
        });
    }
}
