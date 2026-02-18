/**
 * Tests for OWASP-aligned security patterns added in v3.0.0.
 * Covers: ReDoS, overly permissive code, unsafe output, missing input validation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SecurityPatternsGate, checkSecurityPatterns } from './security-patterns.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('SecurityPatternsGate — OWASP extended patterns', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owasp-test-'));
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    describe('ReDoS detection (OWASP #7)', () => {
        it('should detect dynamic regex from user input', async () => {
            const filePath = path.join(testDir, 'search.ts');
            fs.writeFileSync(filePath, `
                const pattern = new RegExp(req.query.search);
                const matches = text.match(pattern);
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.some(v => v.type === 'redos')).toBe(true);
        });

        it('should detect nested quantifiers', async () => {
            const filePath = path.join(testDir, 'regex.ts');
            fs.writeFileSync(filePath, `
                const re = /(?:a+)+b/;
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.some(v => v.type === 'redos')).toBe(true);
        });

        it('should allow safe regex patterns', async () => {
            const filePath = path.join(testDir, 'safe-regex.ts');
            fs.writeFileSync(filePath, `
                const re = /^[a-z]+$/;
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.filter(v => v.type === 'redos')).toHaveLength(0);
        });
    });

    describe('Overly Permissive Code (OWASP #9)', () => {
        it('should detect CORS wildcard origin', async () => {
            const filePath = path.join(testDir, 'server.ts');
            fs.writeFileSync(filePath, `
                import cors from 'cors';
                app.use(cors({ origin: '*' }));
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.some(v => v.type === 'overly_permissive')).toBe(true);
        });

        it('should detect CORS origin true', async () => {
            const filePath = path.join(testDir, 'server2.ts');
            fs.writeFileSync(filePath, `
                app.use(cors({ origin: true }));
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.some(v => v.type === 'overly_permissive')).toBe(true);
        });

        it('should detect 0.0.0.0 binding', async () => {
            const filePath = path.join(testDir, 'listen.ts');
            fs.writeFileSync(filePath, `
                app.listen(3000, '0.0.0.0');
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.some(v => v.type === 'overly_permissive')).toBe(true);
        });

        it('should detect chmod 777', async () => {
            const filePath = path.join(testDir, 'perms.ts');
            fs.writeFileSync(filePath, `
                fs.chmod('/tmp/data', 0o777);
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.some(v => v.type === 'overly_permissive')).toBe(true);
        });

        it('should detect wildcard CORS header', async () => {
            const filePath = path.join(testDir, 'headers.ts');
            fs.writeFileSync(filePath, `
                res.setHeader('Access-Control-Allow-Origin', '*');
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.some(v => v.type === 'overly_permissive')).toBe(true);
        });

        it('should allow specific CORS origin', async () => {
            const filePath = path.join(testDir, 'safe-cors.ts');
            fs.writeFileSync(filePath, `
                app.use(cors({ origin: 'https://myapp.com' }));
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.filter(v => v.type === 'overly_permissive')).toHaveLength(0);
        });
    });

    describe('Unsafe Output Handling (OWASP #6)', () => {
        it('should detect response reflecting user input', async () => {
            const filePath = path.join(testDir, 'handler.ts');
            fs.writeFileSync(filePath, `
                app.get('/echo', (req, res) => {
                    res.send(req.query.msg);
                });
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.some(v => v.type === 'unsafe_output')).toBe(true);
        });

        it('should detect eval with user input', async () => {
            const filePath = path.join(testDir, 'eval.ts');
            fs.writeFileSync(filePath, `
                eval(req.body.code);
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.some(v => v.type === 'unsafe_output')).toBe(true);
        });

        it('should allow safe response patterns', async () => {
            const filePath = path.join(testDir, 'safe-res.ts');
            fs.writeFileSync(filePath, `
                res.json({ status: 'ok', data: processedData });
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.filter(v => v.type === 'unsafe_output')).toHaveLength(0);
        });
    });

    describe('Missing Input Validation (OWASP #8)', () => {
        it('should detect JSON.parse on raw body', async () => {
            const filePath = path.join(testDir, 'parse.ts');
            fs.writeFileSync(filePath, `
                const data = JSON.parse(req.body);
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.some(v => v.type === 'missing_input_validation')).toBe(true);
        });

        it('should detect "as any" type assertion', async () => {
            const filePath = path.join(testDir, 'assert.ts');
            fs.writeFileSync(filePath, `
                const user = payload as any;
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.some(v => v.type === 'missing_input_validation')).toBe(true);
        });

        it('should allow validated JSON parse', async () => {
            const filePath = path.join(testDir, 'safe-parse.ts');
            fs.writeFileSync(filePath, `
                const data = JSON.parse(rawString);
                const validated = schema.parse(data);
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.filter(v => v.type === 'missing_input_validation')).toHaveLength(0);
        });
    });

    describe('config toggles for new patterns', () => {
        it('should disable redos when configured', async () => {
            const gate = new SecurityPatternsGate({ enabled: true, redos: false });
            const filePath = path.join(testDir, 'regex.ts');
            fs.writeFileSync(filePath, `
                const pattern = new RegExp(req.query.search);
            `);

            const failures = await gate.run({ cwd: testDir });
            expect(failures.filter(f => f.title?.includes('ReDoS') || f.title?.includes('regex'))).toHaveLength(0);
        });

        it('should disable overly_permissive when configured', async () => {
            const gate = new SecurityPatternsGate({ enabled: true, overly_permissive: false });
            const filePath = path.join(testDir, 'cors.ts');
            fs.writeFileSync(filePath, `
                app.use(cors({ origin: '*' }));
            `);

            const failures = await gate.run({ cwd: testDir });
            expect(failures.filter(f => f.title?.includes('CORS') || f.title?.includes('permissive'))).toHaveLength(0);
        });
    });
});
