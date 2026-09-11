import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { chmod, link, readFile, unlink, writeFile } from 'node:fs/promises';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

const KEY_PATH = path.join(os.homedir(), '.rigour', 'team-cache.key');
let fileKeyPromise: Promise<Buffer> | undefined;

function decodeKey(value: string, source: string): Buffer {
    const normalized = value.trim();
    const key = Buffer.from(normalized, 'base64');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || key.length !== 32) {
        throw new Error(`${source} must contain a base64-encoded 32-byte key.`);
    }
    return key;
}

async function readFileKey(keyPath: string): Promise<Buffer> {
    return decodeKey(await readFile(keyPath, 'utf8'), keyPath);
}

/**
 * Create the local encryption key without exposing a partially-written key to
 * another Rigour process. A fully-written temporary file is linked into place,
 * so exactly one concurrent process wins and every other process reads it.
 */
export async function loadOrCreateFileKey(keyPath: string): Promise<Buffer> {
    try {
        return await readFileKey(keyPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    await fs.ensureDir(path.dirname(keyPath));
    const key = randomBytes(32);
    const temporaryPath = `${keyPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;

    try {
        await writeFile(temporaryPath, key.toString('base64'), { mode: 0o600, flag: 'wx' });
        await chmod(temporaryPath, 0o600);
        try {
            await link(temporaryPath, keyPath);
            await chmod(keyPath, 0o600);
            return key;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            return await readFileKey(keyPath);
        }
    } finally {
        await unlink(temporaryPath).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
    }
}

async function getKey(): Promise<Buffer> {
    const configured = process.env.RIGOUR_LOCAL_CACHE_KEY;
    if (configured) {
        return decodeKey(configured, 'RIGOUR_LOCAL_CACHE_KEY');
    }
    fileKeyPromise ??= loadOrCreateFileKey(KEY_PATH).catch(error => {
        fileKeyPromise = undefined;
        throw error;
    });
    return fileKeyPromise;
}

export async function encryptLocalPayload(value: unknown): Promise<string> {
    const key = await getKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return `enc:v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
}

export async function decryptLocalPayload<T>(value: string): Promise<T> {
    if (!value.startsWith('enc:v1:')) return JSON.parse(value) as T;
    const [, , ivValue, tagValue, ciphertextValue] = value.split(':');
    const decipher = createDecipheriv('aes-256-gcm', await getKey(), Buffer.from(ivValue, 'base64'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextValue, 'base64')), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as T;
}
