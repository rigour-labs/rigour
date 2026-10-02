/**
 * Unindexed read: a supabase-js read whose table, as the repository's own
 * migrations define it, has no index that can serve it (coverage.ts).
 *
 * Advisory and off by default. It speaks only when the claim is provable:
 * the read is fully literal, its table is created in the migrations, and no
 * DDL touching that table is beyond what schema.ts models. A small table
 * read without an index is fine; dismiss the finding for it.
 */
import fs from 'fs-extra';
import path from 'path';
import { Gate, type GateContext } from '../base.js';
import type { Failure } from '../../types/index.js';
import { FileScanner } from '../../utils/scanner.js';
import { Logger } from '../../utils/logger.js';
import { policyFilters, replayMigrations, type Schema } from './schema.js';
import { findReads, type Read } from './queries.js';
import { seekColumns, servesRead } from './coverage.js';

export interface UnindexedReadsConfig {
    enabled?: boolean;
    /** Globs for migration .sql files; each directory is replayed as its own database. */
    migrations?: string[];
}

const DEFAULT_MIGRATIONS = ['**/migrations/**/*.sql'];
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/*.d.ts'];

export class UnindexedReadsGate extends Gate {
    constructor(private config: UnindexedReadsConfig = {}) {
        super('unindexed-reads', 'Unindexed read');
    }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) return [];
        const schemas = await loadSchemas(context.cwd, this.config.migrations?.length ? this.config.migrations : DEFAULT_MIGRATIONS, context.ignore ?? []);
        if (schemas.length === 0) return [];
        const files = (await FileScanner.findFiles({ cwd: context.cwd, patterns: context.patterns, ignore: [...(context.ignore ?? []), ...SKIP] }))
            .filter(file => SOURCE.test(file));
        Logger.info(`Unindexed reads: ${files.length} files against ${schemas.length} migration set(s)`);
        const failures: Failure[] = [];
        for (const file of files) {
            const content = await fs.readFile(path.join(context.cwd, file), 'utf-8');
            if (!content.includes('.from(')) continue;
            for (const read of findReads(file, content)) {
                const columns = unservedColumns(read, schemas);
                if (columns) failures.push(this.finding(file, read, columns));
            }
        }
        return failures;
    }

    private finding(file: string, read: Read, columns: string[]): Failure {
        const list = columns.map(c => `\`${c}\``).join(', ');
        return this.createFailure(
            `No index on \`${read.table}\` starts with a column this read compares to a value or sorts by first, including any its row-level policy adds (${list}), and none of its partial indexes match the read's filters, so Postgres cannot seek to these rows.`,
            [file],
            `Add an index in a new migration that leads with the most selective of ${list}, in the read's sort order. If the table stays small, dismiss this finding.`,
            undefined, read.line, undefined, 'medium',
        );
    }
}

/**
 * The columns the read narrows by (its own and the table's policy filters) when
 * no migration set can serve it; undefined when one can, or when that is not provable.
 */
export function unservedColumns(read: Read, schemas: Schema[]): string[] | undefined {
    if (read.uncertain || seekColumns(read).size === 0) return undefined;
    const tables = schemas.map(schema => schema.get(read.table)).filter(table => table !== undefined);
    if (tables.length === 0 || tables.some(table => table.uncertain || policyFilters(table).unknown)) return undefined;
    const columns = new Set<string>();
    for (const table of tables) {
        const filtered = withPolicyFilters(read, policyFilters(table).columns);
        if (table.indexes.some(index => servesRead(index, filtered))) return undefined;
        for (const column of seekColumns(filtered)) columns.add(column);
    }
    return [...columns];
}

/** The read as Postgres runs it for a signed-in user: the policy's columns are compared too. */
function withPolicyFilters(read: Read, columns: string[]): Read {
    return { ...read, filters: [...read.filters, ...columns.map(column => ({ column, op: 'eq' as const, value: undefined }))] };
}

/** One schema per migrations directory, replayed in filename order. */
async function loadSchemas(cwd: string, globs: string[], ignore: string[]): Promise<Schema[]> {
    const files = await FileScanner.findFiles({ cwd, patterns: globs, ignore });
    const byDirectory = new Map<string, string[]>();
    for (const file of files) {
        const directory = migrationsRoot(file);
        byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), file]);
    }
    const schemas: Schema[] = [];
    for (const group of byDirectory.values()) {
        const sql = await Promise.all(group.sort().map(file => fs.readFile(path.join(cwd, file), 'utf-8')));
        schemas.push(replayMigrations(sql));
    }
    return schemas;
}

/** The directory a migration belongs to: up to and including its `migrations` segment, else its own folder. */
function migrationsRoot(file: string): string {
    const parts = file.split('/');
    const at = parts.lastIndexOf('migrations');
    return at >= 0 ? parts.slice(0, at + 1).join('/') : path.posix.dirname(file);
}
