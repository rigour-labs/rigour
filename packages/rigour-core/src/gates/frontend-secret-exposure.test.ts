import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FrontendSecretExposureGate } from './frontend-secret-exposure.js';
import { mustFix } from '../review/quiet.js';
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

    describe('what blocks', () => {
        const put = (rel: string, body: string) => {
            fs.mkdirSync(path.dirname(path.join(testDir, rel)), { recursive: true });
            fs.writeFileSync(path.join(testDir, rel), body);
        };
        const byFile = async (security_block = false) => {
            const failures = await new FrontendSecretExposureGate({ security_block }).run({ cwd: testDir });
            return (file: string) => failures.find(f => f.files?.includes(file));
        };

        it('blocks a literal secret key in client code; a secret-named variable is a note', async () => {
            // Built at run time: no key-shaped literal is kept in the repository.
            put('src/components/Pay.tsx', `export const key = '${'sk_' + 'live_' + '9fQ2xWm4Lp8Zr7Tn3Kb6Vd1Y'}';\n`);
            put('src/components/Checkout.tsx', 'export const key = process.env.STRIPE_SECRET_KEY;\n');
            put('src/lib/shared.ts', 'export const key = process.env.STRIPE_SECRET_KEY;\n');
            const at = await byFile();
            expect(at('src/components/Pay.tsx')).toMatchObject({ certainty: 'proven' });
            expect(mustFix(at('src/components/Pay.tsx')!)).toBe(true);
            // Bundlers inline only public-prefixed variables: a non-public one is undefined in the browser, not leaked.
            expect(at('src/components/Checkout.tsx')).toMatchObject({ certainty: 'likely' });
            expect(mustFix(at('src/components/Checkout.tsx')!)).toBe(false);
            // A shared module may or may not be bundled for the browser: possible.
            expect(at('src/lib/shared.ts')).toMatchObject({ certainty: 'possible' });
            expect(mustFix(at('src/lib/shared.ts')!)).toBe(false);
        });

        it('blocks a secret-named variable in client code when the team set security.block', async () => {
            put('src/components/Checkout.tsx', 'export const key = process.env.STRIPE_SECRET_KEY;\n');
            const at = await byFile(true);
            expect(at('src/components/Checkout.tsx')).toMatchObject({ certainty: 'proven' });
            expect(mustFix(at('src/components/Checkout.tsx')!)).toBe(true);
        });
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

    it('treats a file outside frontend paths that imports Node built-ins as server code', async () => {
        const cli = path.join(testDir, 'packages/cli/src/commands/post.ts');
        const spawner = path.join(testDir, 'packages/core/src/exec.ts');
        const shared = path.join(testDir, 'packages/shared/src/config.ts');
        const component = path.join(testDir, 'src/components/Admin.tsx');
        for (const file of [cli, spawner, shared, component]) fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(cli, "import { execFileSync } from 'child_process';\nexport const token = process.env.GITHUB_TOKEN;\n");
        fs.writeFileSync(spawner, "import { execa } from 'execa';\nexport const env = { GH_TOKEN: process.env.GH_TOKEN };\n");
        fs.writeFileSync(shared, 'export const token = process.env.GITHUB_TOKEN;\n');
        fs.writeFileSync(component, "import fs from 'node:fs';\nexport const key = process.env.STRIPE_SECRET_KEY;\n");

        const files = (await new FrontendSecretExposureGate().run({ cwd: testDir })).flatMap(f => f.files ?? []);
        expect(files).not.toContain('packages/cli/src/commands/post.ts'); // Node-only: never bundled
        expect(files).not.toContain('packages/core/src/exec.ts'); // a package that spawns processes is Node-only too
        expect(files).toContain('packages/shared/src/config.ts'); // could be bundled: still flagged
        expect(files).toContain('src/components/Admin.tsx'); // a frontend path stays frontend
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
        const shellPath = path.join(testDir, 'scripts/rigour-team.sh');
        fs.mkdirSync(path.dirname(shellPath), { recursive: true });
        fs.writeFileSync(shellPath, 'node -e "process.env.APP_DATABASE_URL"');

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

    it('treats SvelteKit endpoints and root tool configs as server code', async () => {
        const files: Record<string, string> = {
            'src/routes/api/sync/+server.ts': 'export const GET = () => fetch(url, { headers: { key: process.env.STRIPE_SECRET_KEY } });\n',
            'drizzle.config.ts': 'export default { dbCredentials: { url: process.env.DATABASE_SECRET_URL } };\n',
            'apps/web/drizzle.config.ts': 'export default { dbCredentials: { url: process.env.DATABASE_SECRET_URL } };\n',
        };
        for (const [rel, body] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(testDir, rel)), { recursive: true });
            fs.writeFileSync(path.join(testDir, rel), body);
        }

        const failures = await new FrontendSecretExposureGate().run({ cwd: testDir });
        expect(failures).toHaveLength(0);
    });

    it('still flags a secret in a config module inside the client source tree', async () => {
        const filePath = path.join(testDir, 'src/components/site.config.ts');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'export const key = process.env.STRIPE_SECRET_KEY;\n');

        const failures = await new FrontendSecretExposureGate().run({ cwd: testDir });
        expect(failures.length).toBeGreaterThan(0);
    });
});

