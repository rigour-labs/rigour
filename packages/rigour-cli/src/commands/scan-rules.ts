/**
 * `rigour scan-rules [--rules a,b] [files...]`: semantic rule findings as JSON
 * lines, for the driftbench rule validator. It runs only the named rules (all
 * built-in ones by default) and nothing else, so a candidate rule can be
 * measured on fix commits and on code as it stands.
 */
import { analyzeFiles, BUILT_IN_RULES } from '@rigour-labs/core';
import { trackedSourceFiles } from '../utils/tracked-sources.js';

export function scanRulesCommand(cwd: string, files: string[], options: { rules?: string }): void {
    const wanted = (options.rules ?? '').split(',').map(r => r.trim()).filter(Boolean);
    const unknown = wanted.filter(id => !BUILT_IN_RULES.some(rule => rule.id === id));
    if (unknown.length) throw new Error(`Unknown rule(s): ${unknown.join(', ')}`);
    const rules = wanted.length ? BUILT_IN_RULES.filter(rule => wanted.includes(rule.id)) : BUILT_IN_RULES;
    const targets = files.length ? files : trackedSourceFiles(cwd);
    for (const finding of analyzeFiles(cwd, targets, { rules })) {
        const { rule, file, line, severity, message } = finding;
        process.stdout.write(JSON.stringify({ rule, file, line, severity, message }) + '\n');
    }
}
