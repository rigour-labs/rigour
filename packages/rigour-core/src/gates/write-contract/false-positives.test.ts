/**
 * The false-positive guard: this monorepo's own writes work in production, so every one the check can read against a
 * schema it can read must come back clean. The schemas are the repository's own DDL (the team Postgres schema and
 * the local SQLite cache), each file's DDL replayed as one database; the writes are every source and test file's.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { replayMigrations } from '../unindexed-reads/schema.js';
import { replayContracts } from './contracts.js';
import type { Database } from './findings.js';
import { WriteContractGate, writeContractFindings } from './index.js';
import { findWrites } from './writes.js';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const SKIP = new Set(['node_modules', 'dist', 'studio-dist', '.git', 'coverage']);

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && !SKIP.has(entry.name)) sourceFiles(full, out);
        else if (entry.isFile() && /\.(ts|tsx|mts|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
    }
    return out;
}

/** Every string in a file that creates a table, in order: the file's DDL. */
function ddlOf(file: string): string[] {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
        const text = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text
            : ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map(span => span.literal.text).join('') : undefined;
        if (text && /create table/i.test(text)) found.push(text);
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

describe('the write contract on this repository', () => {
    const files = sourceFiles(ROOT);

    it('reports nothing on the monorepo as it is', async () => {
        expect(await new WriteContractGate().run({ cwd: ROOT, ignore: ['**/node_modules/**', '**/dist/**'] })).toEqual([]);
    });

    it('reports nothing on the repository\'s own writes, judged against its own schemas', async () => {
        const databases: Database[] = files.filter(f => !/(\.test\.|\/write-contract\/)/.test(path.relative(ROOT, f).split(path.sep).join('/'))).map(ddlOf).filter(sql => sql.length > 0)
            .map(sql => ({ contracts: replayContracts(sql), indexes: replayMigrations(sql) }));
        const known = databases.flatMap(db => [...db.contracts.tables].filter(([name, table]) => !table.unknown && db.indexes.get(name) && !db.indexes.get(name)!.uncertain));
        const writes = files.flatMap(file => findWrites(file, fs.readFileSync(file, 'utf8')));
        // The guard means something only if it reads real tables and real writes.
        expect(known.length).toBeGreaterThan(10);
        const findings: string[] = [];
        for (const file of files) {
            const relative = path.relative(ROOT, file).split(path.sep).join('/').replace(/\.test\./, '.fixture.');
            for (const finding of await writeContractFindings(relative, fs.readFileSync(file, 'utf8'), async () => databases)) findings.push(`${relative}:${finding.line} ${finding.message}`);
        }
        const judged = writes.filter(w => known.some(([name]) => name === w.table));
        // 20 tables and 50 writes (12 of them ON CONFLICT upserts) when this was written: the guard is not vacuous.
        expect(judged.length).toBeGreaterThan(30);
        expect(findings).toEqual([]);
    });
});
