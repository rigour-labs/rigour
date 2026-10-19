/**
 * Write contract: an insert or upsert the repository's own migrations say the
 * database will reject (findings.ts says which, and when it stays silent).
 *
 * On by default and never blocking: each finding is `likely`, a note in review
 * and a warning at the edit, until the team sets `block: true`, which makes it
 * `proven`. It runs on the files a change touches and reads the migrations it
 * needs, and only speaks when it can read both the write and the table fully.
 */
import fs from 'fs-extra';
import path from 'path';
import { Gate, type GateContext } from '../base.js';
import type { Failure } from '../../types/index.js';
import { FileScanner } from '../../utils/scanner.js';
import { loadDatabases } from './databases.js';
import { writeIssues, type Database } from './findings.js';
import { findWrites } from './writes.js';

export interface WriteContractConfig {
    enabled?: boolean;
    /** Globs for migration .sql files; each directory is replayed as its own database. */
    migrations?: string[];
    /** Opt in: the findings block. By default they are notes. */
    block?: boolean;
}

export interface WriteFinding { line: number; lines: number[]; message: string; hint: string }

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/*.d.ts', '**/migrations/**', '**/seeds/**'];
/** A file worth parsing: it has a supabase-js write or SQL that inserts. */
const CANDIDATE = /\.(insert|upsert)\(|insert\s+into\s/i;
/** What SKIP leaves out, for a file the edit hook names directly. */
const SKIPPED = /(^|\/)(node_modules|dist|build|__tests__|migrations|seeds)\/|\.(test|spec)\.|\.d\.ts$/;

export class WriteContractGate extends Gate {
    constructor(private config: WriteContractConfig = {}) {
        super('write-contract', 'Write the database will reject');
    }

    override get reportOnly(): boolean {
        return !this.config.block;
    }

    async run(context: GateContext): Promise<Failure[]> {
        if (this.config.enabled === false) return [];
        const files = (await FileScanner.findFiles({ cwd: context.cwd, patterns: context.patterns, ignore: [...(context.ignore ?? []), ...SKIP] }))
            .filter(file => SOURCE.test(file));
        const databases = lazyDatabases(context.cwd, this.config.migrations ?? [], context.ignore ?? []);
        const failures: Failure[] = [];
        for (const file of files) {
            const content = await fs.readFile(path.join(context.cwd, file), 'utf-8');
            for (const finding of await writeContractFindings(file, content, databases)) failures.push(this.failure(file, finding));
        }
        return failures;
    }

    private failure(file: string, finding: WriteFinding): Failure {
        return {
            ...this.createFailure(finding.message, [file], finding.hint, undefined, finding.line, undefined, 'high'),
            lines: finding.lines,
            certainty: this.config.block ? 'proven' : 'likely',
        };
    }
}

/** The databases the migrations build, read once and only when a file has a write to judge. */
export function lazyDatabases(cwd: string, globs: string[], ignore: string[]): () => Promise<Database[]> {
    let loaded: Promise<Database[]> | undefined;
    return () => {
        // Migrations that cannot be read leave nothing to judge against: the check stays silent rather than fail the run.
        loaded ??= loadDatabases(cwd, globs, ignore).catch(() => []);
        return loaded;
    };
}

/** What the database will reject among one file's writes. */
export async function writeContractFindings(file: string, content: string, databases: () => Promise<Database[]>): Promise<WriteFinding[]> {
    if (!SOURCE.test(file) || SKIPPED.test(file.replace(/\\/g, '/')) || !CANDIDATE.test(content)) return [];
    const writes = findWrites(file, content);
    if (writes.length === 0) return [];
    const loaded = await databases();
    if (loaded.length === 0) return [];
    return writes.flatMap(write => writeIssues(write, loaded).map(issue => ({ line: write.line, lines: write.lines, message: issue.message, hint: issue.hint })));
}
