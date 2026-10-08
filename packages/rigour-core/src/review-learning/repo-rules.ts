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
import crypto from 'crypto';
import { isSpecific, meaningfulWords } from './lessons.js';

const RULE_FILES = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md'];
const RULE_DIRS = ['.cursor/rules'];
const MAX_RULE_CHARS = 600;
const MAX_RULES = 5;
/** A paragraph that continues the rule before it (its reason, how to apply it, an example) rather than a rule of its own. */
const CONTINUES = /^\**\s*(why|how to apply|example|examples|evidence|exception|exceptions|fix|note)\b\s*:?\**\s*:?/i;
/** Worded as a requirement: the team said must, never, always, only, every, do not. A rule without these is guidance. */
const REQUIREMENT = /\b(must|never|always|only|every|do not|don't|forbidden|required|non-negotiable)\b/i;

export interface RepoRule {
    /** Stable across runs: the source file and the rule's words. */
    id: string;
    source: string;
    text: string;
    /** Paths the rule names (files or directories). */
    paths: string[];
    /** Identifiers the rule names. */
    symbols: string[];
    /** Worded as a requirement: a break can block. Guidance otherwise: a break is shown. */
    requirement: boolean;
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
    // A "Why:" or "How to apply:" paragraph belongs to the rule above it: alone it is not checkable.
    const merged: string[] = [];
    for (const block of blocks) {
        if (CONTINUES.test(block) && merged.length) merged[merged.length - 1] = `${merged[merged.length - 1]} ${block}`;
        else merged.push(block);
    }
    return merged.map(block => ({
        id: crypto.createHash('sha256').update(`${source}\u0000${block.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`).digest('hex').slice(0, 10),
        source,
        text: block.length > MAX_RULE_CHARS ? `${block.slice(0, MAX_RULE_CHARS)}…` : block,
        requirement: REQUIREMENT.test(block),
        paths: [...new Set([...block.matchAll(/`([\w@.~-]+\/[\w./@*-]*)`/g)].map(m => m[1].replace(/\*.*$/, '').replace(/^\.\//, '')))].filter(Boolean),
        symbols: [...new Set([...block.matchAll(/`([A-Za-z_$][\w$]*)(?:\(\))?`/g)].map(m => m[1]))].filter(isSpecific),
    }));
}

/**
 * The rules most likely to apply to a change, most specific first: a rule naming a path the change
 * touches or an identifier in it ranks above one that only shares words with it (the change's paths
 * and added names, split into words), and a rule sharing fewer than two words is left out. Ranking,
 * not filtering: on a large change most rules share some words, so the judge decides applicability
 * rule by rule from the top `limit`.
 */
function rulesForChange(rules: RepoRule[], files: string[], symbols: Set<string>, limit = MAX_RULES): RepoRule[] {
    const changeWords = new Set([...files.flatMap(f => f.split(/[/._-]+/)), ...symbols].flatMap(meaningfulWords));
    const scored = rules.map(rule => {
        const pathHits = rule.paths.filter(p => files.some(f => f === p || f.startsWith(p.endsWith('/') ? p : `${p}/`) || f.endsWith(`/${p}`))).length;
        const symbolHits = rule.symbols.filter(s => symbols.has(s)).length;
        const shared = new Set(meaningfulWords(rule.text).filter(w => changeWords.has(w))).size;
        return { rule, named: 3 * pathHits + 2 * symbolHits, shared };
    });
    return scored.filter(s => s.named > 0 || s.shared >= 2).sort((a, b) => b.named - a.named || b.shared - a.shared).slice(0, limit).map(s => s.rule);
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

/** The rules that apply to a diff's changed files and added identifiers, the top `limit`. */
export function rulesForDiff(cwd: string, diff: string, enabled = false, limit = MAX_RULES): RepoRule[] {
    if (!enabled) return [];
    const files = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1].trim());
    const added = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n');
    return rulesForChange(readRepoRules(cwd), files, new Set(added.match(/[A-Za-z_$][\w$]*/g) ?? []), limit);
}
