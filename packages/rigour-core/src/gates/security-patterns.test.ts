import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SecurityPatternsGate, checkSecurityPatterns } from './security-patterns.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('SecurityPatternsGate', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-test-'));
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    describe('gate initialization', () => {
        it('should create gate with default config', () => {
            const gate = new SecurityPatternsGate();
            expect(gate.id).toBe('security-patterns');
            expect(gate.title).toBe('Security Pattern Detection');
        });

        it('should skip when not enabled', async () => {
            const gate = new SecurityPatternsGate({ enabled: false });
            const failures = await gate.run({ cwd: testDir });
            expect(failures).toEqual([]);
        });
    });

    describe('SQL injection detection', () => {
        it('should detect string concatenation in queries', async () => {
            const filePath = path.join(testDir, 'db.ts');
            fs.writeFileSync(filePath, `
                const userId = req.params.id;
                db.query("SELECT * FROM users WHERE id = " + userId + " LIMIT 1");
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.some(v => v.type === 'sql_injection')).toBe(true);
        });

        it('should detect template literal SQL', async () => {
            const filePath = path.join(testDir, 'query.ts');
            fs.writeFileSync(filePath, `
                db.execute(\`SELECT * FROM users WHERE id = \${userId}\`);
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.some(v => v.type === 'sql_injection')).toBe(true);
        });

        it('should NOT flag non-SQL template interpolation in normal function calls', async () => {
            const filePath = path.join(testDir, 'status.ts');
            fs.writeFileSync(filePath, `
                logger.info(\`Current version: \${current} -> \${latest}\`);
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.some(v => v.type === 'sql_injection')).toBe(false);
        });
    });

    describe('XSS detection', () => {
        it('should detect innerHTML assignment', async () => {
            const filePath = path.join(testDir, 'dom.js');
            fs.writeFileSync(filePath, `
                element.innerHTML = userInput;
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.some(v => v.type === 'xss')).toBe(true);
        });

        it('should detect dangerouslySetInnerHTML', async () => {
            const filePath = path.join(testDir, 'component.tsx');
            fs.writeFileSync(filePath, `
                <div dangerouslySetInnerHTML={{ __html: content }} />
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.some(v => v.type === 'xss')).toBe(true);
        });
    });

    describe('hardcoded secrets detection', () => {
        it('should detect hardcoded API keys', async () => {
            const filePath = path.join(testDir, 'config.ts');
            fs.writeFileSync(filePath, `
                const API_KEY = "sk-1234567890abcdefghijklmnopqrst";
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.some(v => v.type === 'hardcoded_secrets')).toBe(true);
        });

        it('should detect private keys', async () => {
            const filePath = path.join(testDir, 'key.ts');
            fs.writeFileSync(filePath, `
                const privateKey = "-----BEGIN RSA PRIVATE KEY-----";
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.some(v => v.type === 'hardcoded_secrets')).toBe(true);
        });

        it('should detect password assignments', async () => {
            const filePath = path.join(testDir, 'auth.ts');
            fs.writeFileSync(filePath, `
                const password = "supersecretpassword123";
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.some(v => v.type === 'hardcoded_secrets')).toBe(true);
        });
    });

    describe('insecure randomness detection', () => {
        it('should detect Math.random usage', async () => {
            const filePath = path.join(testDir, 'token.ts');
            fs.writeFileSync(filePath, `
                const token = Math.random().toString(36);
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.some(v => v.type === 'insecure_randomness')).toBe(true);
        });
    });

    describe('command injection detection', () => {
        it('should detect exec with user input', async () => {
            const filePath = path.join(testDir, 'shell.ts');
            fs.writeFileSync(filePath, `
                exec(\`ls \${req.query.path}\`);
            `);

            const vulns = await checkSecurityPatterns(filePath);
            expect(vulns.some(v => v.type === 'command_injection')).toBe(true);
        });
    });

    describe('severity filtering', () => {
        it('should block on high severity by default', async () => {
            const gate = new SecurityPatternsGate({ enabled: true });

            const filePath = path.join(testDir, 'test.ts');
            fs.writeFileSync(filePath, `
                element.innerHTML = userInput;
            `);

            const failures = await gate.run({ cwd: testDir });
            expect(failures.length).toBeGreaterThan(0);
        });

        it('should respect block_on_severity threshold', async () => {
            const gate = new SecurityPatternsGate({
                enabled: true,
                block_on_severity: 'critical'
            });

            // innerHTML is 'high', not 'critical'
            const filePath = path.join(testDir, 'test.ts');
            fs.writeFileSync(filePath, `
                element.innerHTML = userInput;
            `);

            const failures = await gate.run({ cwd: testDir });
            expect(failures).toHaveLength(0); // High severity not blocked
        });

        it('should skip fixture-style test files for gate-level scans', async () => {
            const gate = new SecurityPatternsGate({ enabled: true });
            const fixturePath = path.join(testDir, 'auth.test.ts');
            fs.writeFileSync(fixturePath, `
                const password = "supersecretpassword123";
                eval(req.body.code);
            `);

            const failures = await gate.run({ cwd: testDir });
            expect(failures).toHaveLength(0);
        });
    });
});
