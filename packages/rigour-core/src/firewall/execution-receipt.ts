import { createHash, createHmac, randomBytes, randomUUID } from 'crypto';
import fs from 'fs-extra';
import type { FileHandle } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'path';
import type { ExecutionReceipt } from './types.js';
import { getRepositoryControlId, getTrustedControlDir } from './trusted-control.js';

async function receiptKey(cwd: string, controlRoot?: string): Promise<Buffer> {
    const dir = getTrustedControlDir(cwd, controlRoot);
    const keyPath = path.join(dir, 'receipt.key');
    await fs.ensureDir(dir, 0o700);
    if (await fs.pathExists(keyPath)) {
        const existing = await fs.readFile(keyPath);
        if (existing.length !== 32) throw new Error('Receipt signing key is invalid');
        return existing;
    }
    const key = randomBytes(32);
    await fs.writeFile(keyPath, key, { mode: 0o600 });
    return key;
}

async function acquireReceiptLock(logPath: string): Promise<FileHandle> {
    const lockPath = `${logPath}.append-lock`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            return await fs.promises.open(lockPath, 'wx', 0o600);
        } catch (error: any) {
            if (error?.code !== 'EEXIST') throw error;
            await delay(10);
        }
    }
    throw new Error('Timed out waiting to append execution receipt');
}

export async function appendExecutionReceipt(
    cwd: string,
    input: Omit<ExecutionReceipt, 'version' | 'id' | 'repositoryId' | 'createdAt' | 'previousReceipt' | 'digest' | 'signature'>,
    controlRoot?: string,
): Promise<ExecutionReceipt> {
    const dir = getTrustedControlDir(cwd, controlRoot);
    const logPath = path.join(dir, 'receipts.jsonl');
    await fs.ensureDir(dir, 0o700);
    const lock = await acquireReceiptLock(logPath);
    try {
        let previousReceipt: string | undefined;
        if (await fs.pathExists(logPath)) {
            const lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean);
            const previous = lines.at(-1);
            if (previous) previousReceipt = (JSON.parse(previous) as ExecutionReceipt).digest;
        }
        const unsigned = {
            version: 1 as const,
            id: randomUUID(),
            repositoryId: getRepositoryControlId(cwd),
            ...input,
            createdAt: new Date().toISOString(),
            previousReceipt,
        };
        const serialized = JSON.stringify(unsigned);
        const digest = createHash('sha256').update(serialized).digest('hex');
        const signature = createHmac('sha256', await receiptKey(cwd, controlRoot)).update(digest).digest('hex');
        const receipt: ExecutionReceipt = { ...unsigned, digest, signature };
        await fs.appendFile(logPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
        // Studio consumes this untrusted projection. Enforcement always reads the
        // signed log outside the repository, never this workspace-owned copy.
        const projectionDir = path.join(cwd, '.rigour');
        try {
            await fs.ensureDir(projectionDir);
            await fs.appendFile(path.join(projectionDir, 'execution-receipts.jsonl'), `${JSON.stringify(receipt)}\n`);
        } catch {
            // A read-only agent sandbox may block the optional Studio projection.
            // The canonical trusted receipt is already durable and remains valid.
        }
        return receipt;
    } finally {
        await lock.close();
        await fs.remove(`${logPath}.append-lock`);
    }
}

export async function listExecutionReceipts(cwd: string, limit = 50, controlRoot?: string): Promise<ExecutionReceipt[]> {
    const source = path.join(getTrustedControlDir(cwd, controlRoot), 'receipts.jsonl');
    if (!await fs.pathExists(source)) return [];
    return (await fs.readFile(source, 'utf8')).trim().split('\n').filter(Boolean)
        .slice(-Math.max(1, limit)).map((line) => JSON.parse(line) as ExecutionReceipt);
}

export async function verifyExecutionReceiptChain(cwd: string, controlRoot?: string): Promise<{
    valid: boolean;
    count: number;
    reason?: string;
}> {
    try {
        const receipts = await listExecutionReceipts(cwd, Number.MAX_SAFE_INTEGER, controlRoot);
        const key = receipts.length > 0 ? await receiptKey(cwd, controlRoot) : null;
        let previous: string | undefined;
        for (const receipt of receipts) {
            const { digest, signature, ...unsigned } = receipt;
            if (unsigned.previousReceipt !== previous) {
                return { valid: false, count: receipts.length, reason: `Broken chain at receipt ${receipt.id}` };
            }
            const expectedDigest = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
            const expectedSignature = createHmac('sha256', key!).update(expectedDigest).digest('hex');
            if (digest !== expectedDigest || signature !== expectedSignature) {
                return { valid: false, count: receipts.length, reason: `Invalid signature at receipt ${receipt.id}` };
            }
            previous = digest;
        }
        return { valid: true, count: receipts.length };
    } catch (error: any) {
        return { valid: false, count: 0, reason: error?.message ?? String(error) };
    }
}
