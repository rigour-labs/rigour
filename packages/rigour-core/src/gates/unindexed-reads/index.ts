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
import { loadMigrationSets } from './migrations.js';
import { findReads, type Read } from './queries.js';
import { seekColumns, servesRead } from './coverage.js';

export interface UnindexedReadsConfig {
    enabled?: boolean;
    /** Globs for migration .sql files; each directory is replayed as its own database. */
    migrations?: string[];
}

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/*.d.ts'];

export class UnindexedReadsGate extends Gate {
    constructor(private config: UnindexedReadsConfig = {}) {
        super('unindexed-reads', 'Unindexed read');
    }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) return [];
        const schemas = (await loadMigrationSets(context.cwd, this.config.migrations ?? [], context.ignore ?? [])).map(replayMigrations);
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
