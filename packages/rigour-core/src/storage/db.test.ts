import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSQLiteAvailable, openDatabase, type RigourDB } from './db.js';

let dir: string;
let db: RigourDB;

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-db-'));
    db = (await openDatabase(path.join(dir, 'rigour.db')))!;
});
afterEach(async () => {
    await db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('the database (node:sqlite)', () => {
    it('is built in: no package to install', () => {
        expect(isSQLiteAvailable()).toBe(true);
        expect(db).not.toBeNull();
    });

    it('stores what callers pass the way sqlite3 did: undefined as NULL, booleans as 1 or 0, a Date as epoch ms', async () => {
        await db.exec('CREATE TABLE t (a, b, c, d)');
        const when = new Date('2026-01-02T03:04:05Z');
        const written = await db.run('INSERT INTO t VALUES (?, ?, ?, ?)', undefined, true, false, when);
        expect(written).toEqual({ changes: 1, lastID: 1 });
        const row = await db.get('SELECT * FROM t');
        expect(row).toEqual({ a: null, b: 1, c: 0, d: when.getTime() });
        expect(Object.getPrototypeOf(row)).toBe(Object.prototype); // a plain object, as callers spread and compare
        expect(await db.get('SELECT * FROM t WHERE a = 1')).toBeUndefined();
    });

    it('rolls a failed transaction back whole', async () => {
        await db.exec('CREATE TABLE t (a UNIQUE)');
        await expect(db.transaction(async tx => {
            await tx.run('INSERT INTO t VALUES (?)', 1);
            await tx.run('INSERT INTO t VALUES (?)', 1); // violates UNIQUE
        })).rejects.toThrow(/UNIQUE/);
        expect(await db.all('SELECT * FROM t')).toEqual([]);
    });

    it('opens an existing database again with its schema and data, in WAL mode', async () => {
        await db.run("INSERT INTO meta (key, value) VALUES ('probe', 'kept')");
        await db.close();
        db = (await openDatabase(path.join(dir, 'rigour.db')))!;
        expect(await db.get("SELECT value FROM meta WHERE key = 'probe'")).toEqual({ value: 'kept' });
        expect(await db.get('PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' });
    });
});
