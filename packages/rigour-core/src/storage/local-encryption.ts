import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

const KEY_PATH = path.join(os.homedir(), '.rigour', 'team-cache.key');

async function getKey(): Promise<Buffer> {
    const configured = process.env.RIGOUR_LOCAL_CACHE_KEY;
    if (configured) {
        const key = Buffer.from(configured, 'base64');
        if (key.length !== 32) throw new Error('RIGOUR_LOCAL_CACHE_KEY must be a base64-encoded 32-byte key.');
        return key;
    }
    try {
        const key = Buffer.from((await fs.readFile(KEY_PATH, 'utf8')).trim(), 'base64');
        if (key.length === 32) return key;
    } catch { /* create below */ }
    const key = randomBytes(32);
    await fs.ensureDir(path.dirname(KEY_PATH));
    await fs.writeFile(KEY_PATH, key.toString('base64'), { mode: 0o600 });
    await fs.chmod(KEY_PATH, 0o600);
    return key;
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
