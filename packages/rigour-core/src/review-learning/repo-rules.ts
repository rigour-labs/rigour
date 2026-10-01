/**
 * Repository rules that apply to a change.
 *
 * A team's real engineering rules usually live in its agent rules files
 * (AGENTS.md, CLAUDE.md, Cursor rules, Copilot instructions), not in PR
 * threads: "migrations are append-only", "every send goes through
 * deliverOrder()". An agent loads the whole file and skims it; the reviewer
 * is better served by the few rules that name a file or identifier the
 * change actually touches.
 */
import fs from 'fs';
import path from 'path';
import { isSpecific } from './lessons.js';

const RULE_FILES = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md'];
const RULE_DIRS = ['.cursor/rules'];
const MAX_RULE_CHARS = 600;
const MAX_RULES = 5;

export interface RepoRule {
    source: string;
    text: string;
    /** Paths the rule names (files or directories). */
    paths: string[];
    /** Identifiers the rule names. */
    symbols: string[];
}

export function readRepoRules(cwd: string): RepoRule[] {
    const files = [
        ...RULE_FILES.filter(f => fs.existsSync(path.join(cwd, f))),
        ...RULE_DIRS.flatMap(dir => listRuleFiles(cwd, dir)),
    ];
    return files.flatMap(file => splitRules(file, fs.readFileSync(path.join(cwd, file), 'utf8')));
}

/** One rule per top-level bullet or paragraph; headings and import lines are not rules. */
export function splitRules(source: string, text: string): RepoRule[] {
    const blocks: string[] = [];
    let current: string[] = [];
    const flush = () => {
        const block = current.join(' ').replace(/\s+/g, ' ').trim();
        if (block.length >= 40) blocks.push(block);
        current = [];
    };
    for (const line of text.split('\n')) {
        if (/^\s*$/.test(line) || /^#{1,6}\s/.test(line) || /^@\S+$/.test(line.trim())) {
            flush();
        } else if (/^[-*]\s/.test(line)) {
            flush();
            current.push(line.replace(/^[-*]\s+/, ''));
        } else {
            current.push(line.trim());
        }
    }
    flush();
    return blocks.map(block => ({
        source,
        text: block.length > MAX_RULE_CHARS ? `${block.slice(0, MAX_RULE_CHARS)}…` : block,
        paths: [...new Set([...block.matchAll(/`([\w@.~-]+\/[\w./@*-]*)`/g)].map(m => m[1].replace(/\*.*$/, '').replace(/^\.\//, '')))].filter(Boolean),
        symbols: [...new Set([...block.matchAll(/`([A-Za-z_$][\w$]*)(?:\(\))?`/g)].map(m => m[1]))].filter(isSpecific),
    }));
}

/** Rules that name a path the change touches, or a specific identifier in it; most specific first. */
export function rulesForChange(rules: RepoRule[], files: string[], symbols: Set<string>): RepoRule[] {
    const scored = rules.map(rule => {
        const pathHits = rule.paths.filter(p => files.some(f => f === p || f.startsWith(p.endsWith('/') ? p : `${p}/`) || f.endsWith(`/${p}`))).length;
        const symbolHits = rule.symbols.filter(s => symbols.has(s)).length;
        return { rule, score: 3 * pathHits + 2 * symbolHits };
    });
    return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, MAX_RULES).map(s => s.rule);
}

export function rulesSection(rules: RepoRule[]): string {
    if (rules.length === 0) return '';
    return `REPOSITORY RULES THAT APPLY (from this repository's own rules files; check the change follows each):\n${rules.map(r => `- [${r.source}] ${r.text}`).join('\n')}`;
}

function listRuleFiles(cwd: string, dir: string): string[] {
    try {
        return fs.readdirSync(path.join(cwd, dir)).filter(f => /\.(md|mdc)$/.test(f)).map(f => `${dir}/${f}`);
    } catch {
        return [];
    }
}

/** The rules that apply to a diff's changed files and added identifiers. */
export function rulesForDiff(cwd: string, diff: string, enabled = false): RepoRule[] {
    if (!enabled) return [];
    const files = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1].trim());
    const added = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n');
    return rulesForChange(readRepoRules(cwd), files, new Set(added.match(/[A-Za-z_$][\w$]*/g) ?? []));
}
