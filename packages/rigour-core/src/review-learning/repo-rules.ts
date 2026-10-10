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
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { isSpecific, meaningfulWords } from './lessons.js';

const RULE_FILES = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md'];
const RULE_DIRS = ['.cursor/rules'];
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
    /** Where the rule applies: the folder of the nested rules file it came from (`services/billing/`); the whole repository when absent. */
    scope?: string;
    /** Identifiers the rule names. */
    symbols: string[];
    /** Worded as a requirement: a break can block. Guidance otherwise: a break is shown. */
    requirement: boolean;
    /** The line in its source the rule starts on, for pointing at the full rule. */
    line?: number;
}

/** The most rule files read, imports included: a loop or a sprawling import tree stops here. */
const MAX_RULE_SOURCES = 50;

/** Folders of someone else's code a repository carries: a rules file in one is that project's, not this team's. */
const VENDORED = /(^|\/)(vendor|vendors|third_party|third-party|node_modules|bower_components|external|externals)\//;

/**
 * Every rule file of the repository: the root ones, the AGENTS.md and CLAUDE.md files in folders below it (outside
 * vendored folders), the rule directories, and every file a rule file imports with an `@path` line (relative to the
 * importing file, inside the repository). A judge does not load these by itself; this is how the repository's rules
 * reach it. A nested file's rules apply to its own folder only, and so do the rules of the files it imports.
 */
export function readRepoRules(cwd: string): RepoRule[] {
    const queue: Array<{ file: string; scope?: string }> = [
        ...RULE_FILES.filter(f => fs.existsSync(path.join(cwd, f))).map(file => ({ file })),
        ...nestedRuleFiles(cwd).map(file => ({ file, scope: `${path.posix.dirname(file)}/` })),
        ...RULE_DIRS.flatMap(dir => listRuleFiles(cwd, dir)).map(file => ({ file })),
    ];
    const read = new Set<string>();
    const rules: RepoRule[] = [];
    while (queue.length && read.size < MAX_RULE_SOURCES) {
        const { file, scope } = queue.shift()!;
        // The same file imported from two places is read once, with the scope it was first reached with: a root import first.
        if (read.has(file)) continue;
        read.add(file);
        let text: string;
        try {
            text = fs.readFileSync(path.join(cwd, file), 'utf8');
        } catch {
            continue;
        }
        rules.push(...splitRules(file, text).map(rule => (scope ? { ...rule, scope } : rule)));
        for (const m of text.matchAll(/^@(\S+)\s*$/gm)) {
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1].replace(/^\.\//, '')));
            if (target.startsWith('..') || path.isAbsolute(m[1]) || m[1].startsWith('~') || !fs.existsSync(path.join(cwd, target))) continue;
            // Root imports go to the front, so a file both a root and a nested file import keeps the repository-wide scope.
            if (scope) queue.push({ file: target, scope });
            else queue.unshift({ file: target });
        }
    }
    return rules;
}

/** AGENTS.md and CLAUDE.md in folders below the root, as git tracks them, outside vendored folders. */
function nestedRuleFiles(cwd: string): string[] {
    const listed = spawnSync('git', ['ls-files', '-z', '--', '*/AGENTS.md', '*/CLAUDE.md'], { cwd, encoding: 'utf8', timeout: 5000 });
    return listed.status === 0 ? listed.stdout.split('\0').filter(f => f && !VENDORED.test(f)) : [];
}

/** A top-level list item: a bullet or a numbered item (`1.`, `2)`). Each is a rule of its own. */
const ITEM = /^(?:[-*]|\d+[.)])\s+/;
/** A rule is at least this long; a shorter list item is a part of the sentence that introduces its list. */
const MIN_RULE_CHARS = 40;
/** A lead-in that asks something of the reader ("must call one of these:") is a rule, not prose. */
const ASKS = new RegExp(`${REQUIREMENT.source}|\\bshould\\b`, 'i');

/**
 * One rule per top-level bullet, numbered item or paragraph; headings and import lines are not rules. A paragraph
 * ending in a colon right before a list introduces it: when the items are too short to be rules alone ("withLock()"),
 * the lead-in and its items are one rule; when they are rules, the lead-in is a rule of its own only if it asks
 * something (must, never, should…), and otherwise it is prose ("The rules below:") and not a rule.
 */
export function splitRules(source: string, text: string): RepoRule[] {
    const parts: Array<{ text: string; item: boolean; line: number }> = [];
    let current: string[] = [];
    let start = 0;
    let item = false;
    const flush = () => {
        const block = current.join(' ').replace(/\s+/g, ' ').trim();
        if (block) parts.push({ text: block, item, line: start });
        current = [];
    };
    text.split('\n').forEach((line, i) => {
        if (/^\s*$/.test(line) || /^#{1,6}\s/.test(line) || /^@\S+$/.test(line.trim())) {
            flush();
            item = false;
        } else if (ITEM.test(line)) {
            flush();
            item = true;
            start = i + 1;
            current.push(line.replace(ITEM, ''));
        } else {
            if (!current.length) start = i + 1;
            current.push(line.trim());
        }
    });
    flush();
    const kept: Array<{ text: string; line: number }> = [];
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const leadIn = !part.item && part.text.endsWith(':') && !!parts[i + 1]?.item;
        if (!leadIn) {
            if (part.text.length >= MIN_RULE_CHARS) kept.push(part);
            continue;
        }
        let j = i + 1;
        while (parts[j]?.item) j++;
        const items = parts.slice(i + 1, j);
        if (items.every(it => it.text.length < MIN_RULE_CHARS)) {
            kept.push({ text: `${part.text} ${items.map(it => it.text).join('; ')}`, line: part.line });
            i = j - 1;
        } else if (ASKS.test(part.text) && part.text.length >= MIN_RULE_CHARS) {
            kept.push(part);
        }
    }
    const blocks = kept;
    // A "Why:" or "How to apply:" paragraph belongs to the rule above it: alone it is not checkable.
    const merged: Array<{ text: string; line: number }> = [];
    for (const block of blocks) {
        if (CONTINUES.test(block.text) && merged.length) merged[merged.length - 1] = { ...merged[merged.length - 1], text: `${merged[merged.length - 1].text} ${block.text}` };
        else merged.push(block);
    }
    return merged.map(({ text: block, line }) => ({
        id: crypto.createHash('sha256').update(`${source}\u0000${block.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`).digest('hex').slice(0, 10),
        source,
        // Whole: a rule cut mid-sentence is a garbled instruction. The brief serves an over-long one by its first sentence and line.
        text: block,
        line,
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
function rulesForChange(rules: RepoRule[], files: string[], symbols: Set<string>, limit = MAX_RULES, namedOnly = false): RepoRule[] {
    // A folder's own rules are served only when the change touches that folder: never checked, so never broken, elsewhere.
    rules = rules.filter(rule => !rule.scope || files.some(f => f.startsWith(rule.scope!)));
    const changeWords = new Set([...files.flatMap(f => f.split(/[/._-]+/)), ...symbols].flatMap(meaningfulWords));
    const scored = rules.map(rule => {
        const pathHits = rule.paths.filter(p => files.some(f => f === p || f.startsWith(p.endsWith('/') ? p : `${p}/`) || f.endsWith(`/${p}`))).length;
        const symbolHits = rule.symbols.filter(s => symbols.has(s)).length;
        const shared = new Set(meaningfulWords(rule.text).filter(w => changeWords.has(w))).size;
        return { rule, named: 3 * pathHits + 2 * symbolHits, shared };
    });
    return scored.filter(s => s.named > 0 || (!namedOnly && s.shared >= 2)).sort((a, b) => b.named - a.named || b.shared - a.shared).slice(0, limit).map(s => s.rule);
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

/**
 * The rules that apply to a diff's changed files and added identifiers, the top `limit`. `namedOnly`: only rules that
 * name a path or identifier the change touches (a briefing has no code to judge applicability against, so a rule that
 * merely shares words with a large change is noise there).
 */
export function rulesForDiff(cwd: string, diff: string, enabled = false, limit = MAX_RULES, namedOnly = false): RepoRule[] {
    if (!enabled) return [];
    const files = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1].trim());
    const added = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n');
    return rulesForChange(readRepoRules(cwd), files, new Set(added.match(/[A-Za-z_$][\w$]*/g) ?? []), limit, namedOnly);
}
