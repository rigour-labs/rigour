import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FrontendSecretExposureGate } from './frontend-secret-exposure.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('FrontendSecretExposureGate', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-secret-test-'));
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('detects process.env secret usage in client-bundled file', async () => {
        const filePath = path.join(testDir, 'src/components/Checkout.tsx');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `
            export function Checkout() {
                const key = process.env.STRIPE_SECRET_KEY;
                return <div>{key}</div>;
            }
        `);

        const gate = new FrontendSecretExposureGate();
        const failures = await gate.run({ cwd: testDir });

        expect(failures.length).toBeGreaterThan(0);
        expect(failures[0].id).toBe('frontend-secret-exposure');
        expect(failures[0].files).toContain('src/components/Checkout.tsx');
    });

    it('detects import.meta.env secret usage in frontend app path', async () => {
        const filePath = path.join(testDir, 'src/app/page.tsx');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `
            export default function Page() {
                return <span>{import.meta.env.OPENAI_API_KEY}</span>;
            }
        `);

        const gate = new FrontendSecretExposureGate();
        const failures = await gate.run({ cwd: testDir });

        expect(failures.length).toBeGreaterThan(0);
    });

    it('does not flag public env prefixes in client files', async () => {
        const filePath = path.join(testDir, 'components/Header.tsx');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `
            export const key = process.env.NEXT_PUBLIC_STRIPE_KEY;
        `);

        const gate = new FrontendSecretExposureGate();
        const failures = await gate.run({ cwd: testDir });

        expect(failures).toHaveLength(0);
    });

    it('does not flag server-only API route', async () => {
        const filePath = path.join(testDir, 'pages/api/charge.ts');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `
            export default function handler() {
                return process.env.STRIPE_SECRET_KEY;
            }
        `);

        const gate = new FrontendSecretExposureGate();
        const failures = await gate.run({ cwd: testDir });

        expect(failures).toHaveLength(0);
    });

    it('does not flag .server files', async () => {
        const filePath = path.join(testDir, 'src/lib/payments.server.ts');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `
            export const stripeSecret = process.env.STRIPE_SECRET_KEY;
        `);

        const gate = new FrontendSecretExposureGate();
        const failures = await gate.run({ cwd: testDir });

        expect(failures).toHaveLength(0);
    });

    it('does not treat server scripts or test configuration as browser bundles', async () => {
        for (const file of ['scripts/migrate.mjs', 'e2e/session.ts', 'tests/helpers/db.ts', 'playwright.config.ts']) {
            const filePath = path.join(testDir, file);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, 'export const key = process.env.SESSION_SECRET;');
        }

        const gate = new FrontendSecretExposureGate({ server_path_patterns: ['(^|/)pages/api/'] });
        expect(await gate.run({ cwd: testDir })).toHaveLength(0);
    });

    it('ignores shell files even when a broad project scan passes them in', async () => {
        const shellPath = path.join(testDir, 'scripts/rigour-nmc.sh');
        fs.mkdirSync(path.dirname(shellPath), { recursive: true });
        fs.writeFileSync(shellPath, 'node -e "process.env.RIGOUR_NMC_DATABASE_URL"');

        const gate = new FrontendSecretExposureGate();
        expect(await gate.run({ cwd: testDir, patterns: ['**/*'] })).toHaveLength(0);
    });

    it('respects explicit allowlist env names', async () => {
        const filePath = path.join(testDir, 'src/views/App.tsx');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `
            export const x = process.env.INTERNAL_TOKEN_FOR_DOCS;
        `);

        const gate = new FrontendSecretExposureGate({
            allowlist_env_names: ['INTERNAL_TOKEN_FOR_DOCS'],
        });
        const failures = await gate.run({ cwd: testDir });

        expect(failures).toHaveLength(0);
    });

    it('skips when disabled', async () => {
        const filePath = path.join(testDir, 'src/components/Client.tsx');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `
            export const x = process.env.OPENAI_API_KEY;
        `);

        const gate = new FrontendSecretExposureGate({ enabled: false });
        const failures = await gate.run({ cwd: testDir });

        expect(failures).toHaveLength(0);
    });
});
