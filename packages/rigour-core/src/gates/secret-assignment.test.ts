import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecurityPatternsGate } from './security-patterns.js';
import { mustFix } from '../review/quiet.js';
import { scanInputForCredentials } from '../hooks/input-validator.js';

let dir: string;
const write = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };
const run = (config: ConstructorParameters<typeof SecurityPatternsGate>[0] = {}) => new SecurityPatternsGate(config).run({ cwd: dir, ignore: [] } as any);
/** A value no placeholder rule matches, built at run time so no secret-looking literal sits in the source. */
const VALUE = ['Xk9#mP2q', 'Lw8vRt5z'].join('');

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-assignment-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('a secret in a plain assignment', () => {
    it('is a note in code, JSON, YAML and a .env file, never a block, security.block included', async () => {
        write('src/db.ts', `export const password = "${VALUE}";\n`);
        write('config/app.json', `{ "client_secret": "${VALUE}" }\n`);
        write('config/app.yml', `smtp:\n  api_key: '${VALUE}'\n`);
        write('.env', `DB_PASSWORD=${VALUE}\n`);
        for (const config of [{}, { block: true }]) {
            const found = (await run(config)).filter(f => f.title === 'Security: SECRET ASSIGNMENT');
            expect(found.map(f => f.files?.[0]).sort()).toEqual(['.env', 'config/app.json', 'config/app.yml', 'src/db.ts']);
            for (const f of found) {
                expect(f.certainty).toBe('likely');
                expect(mustFix(f)).toBe(false);
                expect(JSON.stringify(f)).not.toContain(VALUE); // the value is never repeated
            }
        }
    });

    it('never fires on a reference, a placeholder, an empty value, a test value, a .env template or a fixture', async () => {
        write('src/a.ts', [
            'export const password = process.env.DB_PASSWORD;',
            'export const secret = "${APP_SECRET}";',
            'export const api_key = "your-api-key-here";',
            'export const access_token = "";',
            'export const client_secret = "test-client-secret";',
            'export const pwd = "changeme12345";',
        ].join('\n') + '\n');
        write('.env.example', `DB_PASSWORD=${VALUE}\n`);
        write('test/fixtures/creds.json', `{ "password": "${VALUE}" }\n`);
        write('.env', 'DB_PASSWORD=$OTHER_SECRET\nNODE_ENV=production\n');
        expect((await run()).filter(f => f.title === 'Security: SECRET ASSIGNMENT')).toEqual([]);
    });

    it('is off with gates.security.secret_assignments: false, and a provider-format key is still proven', async () => {
        write('src/db.ts', `export const password = "${VALUE}";\nexport const aws = "${['AKIA', 'Z9Y8X7W6V5U4T3Q2'].join('')}";\n`);
        const found = await run({ secret_assignments: false });
        expect(found.some(f => f.title === 'Security: SECRET ASSIGNMENT')).toBe(false);
        expect(found.some(f => f.certainty === 'proven')).toBe(true);
    });

    it('is a warning before the tool call too, never a block, and the team switch silences it', () => {
        const write = `const password = '${VALUE}';`;
        const scanned = scanInputForCredentials(write);
        expect(scanned.status).toBe('warning');
        expect(scanned.detections.every(d => d.decision !== 'block')).toBe(true);
        expect(scanInputForCredentials(write, { secret_assignments: false }).status).toBe('clean');
        expect(scanInputForCredentials("const password = 'your-password';").status).toBe('clean');
    });
});
