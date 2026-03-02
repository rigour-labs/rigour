import { runHookChecker } from './dist/hooks/checker.js';
import os from 'os';
import path from 'path';
import fs from 'fs';
import yaml from 'yaml';

let pass = 0, fail = 0;
function assert(name, condition) {
    if (condition) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ ' + name); }
}

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov2-'));
fs.writeFileSync(path.join(testDir, 'rigour.yml'), yaml.stringify({ version: 1, gates: {} }));

console.log('── MEMORY governance ──');

fs.writeFileSync(path.join(testDir, 'CLAUDE.md'), '# Rules');
let r = await runHookChecker({ cwd: testDir, files: ['CLAUDE.md'] });
assert('blocks CLAUDE.md (memory)', r.failures.some(f => f.gate === 'governance'));
assert('message says rigour_remember', r.failures.some(f => f.message.includes('rigour_remember')));

fs.writeFileSync(path.join(testDir, '.clinerules'), 'rules');
r = await runHookChecker({ cwd: testDir, files: ['.clinerules'] });
assert('blocks .clinerules (memory)', r.failures.some(f => f.gate === 'governance'));

console.log('');
console.log('── SKILLS governance ──');

fs.mkdirSync(path.join(testDir, '.claude', 'skills', 'my-skill'), { recursive: true });
fs.writeFileSync(path.join(testDir, '.claude', 'skills', 'my-skill', 'SKILL.md'), 'skill def');
r = await runHookChecker({ cwd: testDir, files: ['.claude/skills/my-skill/SKILL.md'] });
assert('blocks .claude/skills/** (skills)', r.failures.some(f => f.gate === 'governance-skills'));
assert('message says Rigour skills system', r.failures.some(f => f.message.includes('Rigour skills')));

fs.writeFileSync(path.join(testDir, '.cursorrules'), 'rules');
r = await runHookChecker({ cwd: testDir, files: ['.cursorrules'] });
assert('blocks .cursorrules (skills)', r.failures.some(f => f.gate === 'governance-skills'));

fs.mkdirSync(path.join(testDir, '.cursor', 'rules'), { recursive: true });
fs.writeFileSync(path.join(testDir, '.cursor', 'rules', 'frontend.md'), 'rules');
r = await runHookChecker({ cwd: testDir, files: ['.cursor/rules/frontend.md'] });
assert('blocks .cursor/rules/** (skills)', r.failures.some(f => f.gate === 'governance-skills'));

fs.mkdirSync(path.join(testDir, '.windsurf', 'rules'), { recursive: true });
fs.writeFileSync(path.join(testDir, '.windsurf', 'rules', 'my-rule.md'), 'rules');
r = await runHookChecker({ cwd: testDir, files: ['.windsurf/rules/my-rule.md'] });
assert('blocks .windsurf/rules/** (skills)', r.failures.some(f => f.gate === 'governance-skills'));

fs.mkdirSync(path.join(testDir, '.claude', 'commands'), { recursive: true });
fs.writeFileSync(path.join(testDir, '.claude', 'commands', 'my-cmd.md'), 'cmd');
r = await runHookChecker({ cwd: testDir, files: ['.claude/commands/my-cmd.md'] });
assert('blocks .claude/commands/** (skills)', r.failures.some(f => f.gate === 'governance-skills'));

console.log('');
console.log('── EXEMPT paths ──');

fs.writeFileSync(path.join(testDir, '.claude', 'settings.json'), '{}');
r = await runHookChecker({ cwd: testDir, files: ['.claude/settings.json'] });
const govFails1 = r.failures.filter(f => f.gate.startsWith('governance'));
assert('exempts .claude/settings.json', govFails1.length === 0);

fs.mkdirSync(path.join(testDir, '.cursor'), { recursive: true });
fs.writeFileSync(path.join(testDir, '.cursor', 'hooks.json'), '{}');
r = await runHookChecker({ cwd: testDir, files: ['.cursor/hooks.json'] });
const govFails2 = r.failures.filter(f => f.gate.startsWith('governance'));
assert('exempts .cursor/hooks.json', govFails2.length === 0);

console.log('');
console.log('── Normal code ──');

fs.writeFileSync(path.join(testDir, 'src.ts'), 'export const x = 1;');
r = await runHookChecker({ cwd: testDir, files: ['src.ts'] });
assert('allows normal code', r.failures.filter(f => f.gate.startsWith('governance')).length === 0);

console.log('');
console.log('── Granular disable ──');

// enforce_skills: false → skills allowed, memory still blocked
fs.writeFileSync(path.join(testDir, 'rigour.yml'), yaml.stringify({
    version: 1, gates: { governance: { enabled: true, enforce_skills: false } },
}));
r = await runHookChecker({ cwd: testDir, files: ['.cursorrules'] });
assert('enforce_skills:false → .cursorrules allowed', r.failures.filter(f => f.gate === 'governance-skills').length === 0);

r = await runHookChecker({ cwd: testDir, files: ['CLAUDE.md'] });
assert('enforce_skills:false → CLAUDE.md still blocked (memory)', r.failures.some(f => f.gate === 'governance'));

// enforce_memory: false → memory allowed, skills still blocked
fs.writeFileSync(path.join(testDir, 'rigour.yml'), yaml.stringify({
    version: 1, gates: { governance: { enabled: true, enforce_memory: false } },
}));
r = await runHookChecker({ cwd: testDir, files: ['CLAUDE.md'] });
assert('enforce_memory:false → CLAUDE.md allowed', r.failures.filter(f => f.gate === 'governance').length === 0);

r = await runHookChecker({ cwd: testDir, files: ['.cursorrules'] });
assert('enforce_memory:false → .cursorrules still blocked (skills)', r.failures.some(f => f.gate === 'governance-skills'));

// DLP still fires even with blocking off
fs.writeFileSync(path.join(testDir, 'rigour.yml'), yaml.stringify({
    version: 1, gates: { governance: { enabled: true, block_native_memory: false, enforce_skills: false } },
}));
fs.writeFileSync(path.join(testDir, '.cursorrules'), 'key: AKIAIOSFODNN7EXAMPLE');
r = await runHookChecker({ cwd: testDir, files: ['.cursorrules'] });
assert('DLP scans even with blocking off', r.failures.some(f => f.gate === 'governance-dlp'));

fs.rmSync(testDir, { recursive: true, force: true });
console.log('');
console.log('Result: ' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail > 0 ? 1 : 0);
