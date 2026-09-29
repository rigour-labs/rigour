/**
 * Learned rules live in `.rigour/rules/<id>.json`, committed and reviewed
 * like code. A file that does not parse as a rule is skipped with a warning.
 */
import fs from 'fs';
import path from 'path';
import { Logger } from '../../utils/logger.js';
import { ZodError } from 'zod';
import { LearnedRuleSchema, type LearnedRule } from './types.js';

export const LEARNED_RULES_DIR = path.join('.rigour', 'rules');

export function saveLearnedRule(cwd: string, rule: LearnedRule): string {
    const dir = path.join(cwd, LEARNED_RULES_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${rule.id}.json`);
    fs.writeFileSync(file, `${JSON.stringify(LearnedRuleSchema.parse(rule), null, 2)}\n`);
    return file;
}

export function loadLearnedRules(cwd: string): LearnedRule[] {
    const dir = path.join(cwd, LEARNED_RULES_DIR);
    if (!fs.existsSync(dir)) return [];
    const rules: LearnedRule[] = [];
    for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort()) {
        try {
            rules.push(LearnedRuleSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))));
        } catch (error) {
            Logger.warn(`Skipping ${path.join(LEARNED_RULES_DIR, name)}: not a valid learned rule (${reasonOf(error)})`);
        }
    }
    return rules;
}

function reasonOf(error: unknown): string {
    if (error instanceof ZodError) {
        const [issue] = error.issues;
        return `${issue.path.join('.') || 'rule'}: ${issue.message}`;
    }
    return error instanceof Error ? error.message : String(error);
}
