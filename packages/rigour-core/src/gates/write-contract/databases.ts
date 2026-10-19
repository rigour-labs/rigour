/**
 * The databases the migrations build, replayed once per process for as long as their files are unchanged: an edit
 * hook or a long-lived server (MCP, Studio) checks file after file against the same migrations. A set is keyed by each
 * of its files' path, size and modification time, so any change to one replays that set again.
 */
import fs from 'fs-extra';
import path from 'path';
import { migrationGroups } from '../unindexed-reads/migrations.js';
import { replayMigrations } from '../unindexed-reads/schema.js';
import { replayContracts } from './contracts.js';
import type { Database } from './findings.js';

/** Enough for every migrations folder of a few repositories; the oldest set is dropped past it. */
const MAX_SETS = 32;
const replayed = new Map<string, Database>();

export async function loadDatabases(cwd: string, globs: string[], ignore: string[]): Promise<Database[]> {
    const groups = await migrationGroups(cwd, globs, ignore);
    return Promise.all(groups.map(group => databaseOf(group.map(file => path.join(cwd, file)))));
}

async function databaseOf(files: string[]): Promise<Database> {
    const stats = await Promise.all(files.map(file => fs.stat(file)));
    const key = files.map((file, i) => `${file}\u0000${stats[i].size}\u0000${stats[i].mtimeMs}`).join('\u0001');
    const cached = replayed.get(key);
    if (cached) return cached;
    const sql = await Promise.all(files.map(file => fs.readFile(file, 'utf-8')));
    const database = { contracts: replayContracts(sql), indexes: replayMigrations(sql) };
    replayed.set(key, database);
    if (replayed.size > MAX_SETS) replayed.delete(replayed.keys().next().value!);
    return database;
}
