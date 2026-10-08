/**
 * The goal of a change, as its author declared it, and the deterministic checks of the change against it.
 *
 * The goal is read from the pull request's description, from headings the author writes on purpose:
 *
 *   ## Done when       a checklist; an item that names a file, path, symbol or migration in backticks is checkable
 *   ## Scope           the paths the change may touch (globs or folders, in backticks or one per bullet)
 *   ## Out of scope    paths it must not touch
 *   ## Invariants      what must stay true (recorded with the goal; not checked here)
 *
 * Only what the author declared is checked: a description without these headings has no goal to check against, and
 * nothing here ever blocks it. The checks are deterministic (no model): a changed file outside the declared scope, a
 * changed file inside the declared out-of-scope, and a "done when" item whose named files the change never touches. A
 * named symbol the change never touches is a note, never a block: an item can state a property the change keeps. Tests,
 * snapshots, lockfiles, changelogs and release notes are exempt from the scope check (they follow the code they belong
 * to), and so is a file a "Done when" item names.
 */
import micromatch from 'micromatch';
import type { Failure } from '../types/index.js';

export interface DoneItem {
    text: string;
    /** What the item names in backticks: files or paths, and symbols. */
    paths: string[];
    symbols: string[];
}

export interface Goal {
    doneWhen: DoneItem[];
    scope: string[];
    outOfScope: string[];
    invariants: string[];
}

type Section = 'doneWhen' | 'scope' | 'outOfScope' | 'invariants';

const HEADINGS: Array<[RegExp, Section]> = [
    [/^done when$/, 'doneWhen'],
    [/^(?:scope|boundary|in scope)$/, 'scope'],
    [/^(?:out of scope|not in scope|out-of-scope)$/, 'outOfScope'],
    [/^invariants?$/, 'invariants'],
];

/** The section a line opens, if it is a heading (`## Scope`, `**Scope**`, `Scope:` alone on a line); `null` for another heading. */
function headingOf(line: string): Section | null | undefined {
    const markdown = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    const bold = /^\s{0,3}(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*$/.exec(line);
    const label = /^\s{0,3}([A-Za-z][A-Za-z -]{1,30}):\s*$/.exec(line);
    const text = (markdown ?? bold ?? label)?.[1];
    if (!text) return undefined;
    const name = text.replace(/[:*_`]/g, '').trim().toLowerCase();
    for (const [pattern, section] of HEADINGS) if (pattern.test(name)) return section;
    return markdown || bold ? null : undefined; // another heading ends the section; a stray "Label:" line does not
}

const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/;
const TICKED = /`([^`\n]+)`/g;

const FILE_EXTENSIONS = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs', 'jsx', 'json', 'jsonc', 'md', 'mdx', 'yml', 'yaml', 'sql', 'py', 'go', 'rs', 'java', 'rb', 'kt', 'kts',
    'swift', 'svelte', 'vue', 'css', 'scss', 'sass', 'less', 'html', 'htm', 'toml', 'lock', 'sh', 'bash', 'zsh', 'sha256', 'txt', 'csv', 'xml', 'graphql', 'gql', 'proto',
    'ini', 'cfg', 'conf', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'scala', 'ex', 'exs', 'dart', 'lua', 'tf', 'hcl', 'snap']);

/**
 * A token that names a file or path: has a folder separator or a glob, or ends in a known file extension. Member
 * access (`JSON.parse`, `session.leadId`, `res.status`) is a symbol, not a file.
 */
function isPath(token: string): boolean {
    if (/[/*?[\]{}]/.test(token)) return true;
    const extension = /\.([A-Za-z0-9]{1,8})$/.exec(token)?.[1];
    return !!extension && FILE_EXTENSIONS.has(extension);
}

/** A token that names a symbol: an identifier, optionally dotted, optionally called. */
function symbolOf(token: string): string | undefined {
    const m = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\(\))?$/.exec(token.trim());
    return m && m[1].length >= 3 ? m[1] : undefined;
}

/** The goal a pull request's description declares; empty when it declares none. */
export function parseGoal(description: string): Goal {
    const goal: Goal = { doneWhen: [], scope: [], outOfScope: [], invariants: [] };
    let section: Section | undefined;
    for (const line of description.replace(/\r\n/g, '\n').split('\n')) {
        const heading = headingOf(line);
        if (heading !== undefined) {
            section = heading ?? undefined;
            continue;
        }
        if (!section) continue;
        const item = ITEM.exec(line)?.[1];
        if (!item) continue;
        const ticked = [...item.matchAll(TICKED)].map(m => m[1].trim());
        if (section === 'doneWhen') {
            goal.doneWhen.push({ text: item, paths: ticked.filter(isPath), symbols: ticked.filter(t => !isPath(t)).map(symbolOf).filter((s): s is string => !!s) });
        } else if (section === 'invariants') {
            goal.invariants.push(item);
        } else {
            // A scope entry is what it names in backticks, or the bullet itself when it is a bare path.
            const paths = ticked.length ? ticked.filter(isPath) : isPath(item) && !/\s/.test(item) ? [item] : [];
            goal[section].push(...paths.map(p => p.replace(/^\.\//, '')));
        }
    }
    return goal;
}

/** Whether the description declares anything the deterministic checks can check. */
export function hasCheckableGoal(goal: Goal): boolean {
    return goal.scope.length > 0 || goal.outOfScope.length > 0 || goal.doneWhen.some(item => item.paths.length + item.symbols.length > 0);
}

/** Whether a file is covered by a declared path: a glob, a folder (with or without a trailing slash), or the file itself. */
function covers(pattern: string, file: string): boolean {
    if (/[*?[\]{}]/.test(pattern)) return micromatch.isMatch(file, pattern, { dot: true });
    const folder = pattern.replace(/\/+$/, '');
    return file === folder || file.startsWith(`${folder}/`);
}

/** Tests, snapshots, lockfiles, changelogs and release notes follow the code they belong to: never scope drift on their own. */
const EXEMPT = [/(^|\/)(__tests__|tests?|spec|__snapshots__)\//, /\.(test|spec)\.[A-Za-z0-9]+$/, /\.snap$/,
    /(^|\/)(CHANGELOG|CHANGES|HISTORY|RELEASE_NOTES)(\.md)?$/i, /(^|\/)(releases|release-notes)\/[^/]+\.md$/, /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum|Gemfile\.lock|composer\.lock|bun\.lockb)$/];

/**
 * The goal's deterministic findings for a change. `changedLines` is the review's changed lines per file (generated files
 * already left out); a deleted file has none and is read from the diff's headers. A named symbol must appear on an
 * added or removed line.
 */
export function goalFailures(goal: Goal, changedLines: Record<string, Set<number>>, diff: string): Failure[] {
    const changed: Record<string, number | undefined> = {};
    for (const [file, lines] of Object.entries(changedLines)) changed[file] = lines.size ? Math.min(...lines) : undefined;
    for (const m of diff.matchAll(/^--- a\/(.+)\n\+\+\+ \/dev\/null$/gm)) if (!(m[1] in changed)) changed[m[1]] = undefined;
    const touched = diff.split('\n').filter(line => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line)).map(line => line.slice(1)).join('\n');
    const failures: Failure[] = [];
    const files = Object.keys(changed).sort();
    // A file a "Done when" item names is part of the goal, whatever Scope lists.
    const inScope = [...goal.scope, ...goal.doneWhen.flatMap(item => item.paths)];
    for (const file of files) {
        if (EXEMPT.some(pattern => pattern.test(file))) continue;
        const excluded = goal.outOfScope.find(pattern => covers(pattern, file));
        const outside = !excluded && goal.scope.length > 0 && !inScope.some(pattern => covers(pattern, file));
        if (!excluded && !outside) continue;
        failures.push({
            id: 'goal-scope',
            title: excluded ? `Changes ${file}, which the description declares out of scope (\`${excluded}\`)` : `Changes ${file}, outside the scope the description declares`,
            details: excluded
                ? `The pull request's description lists \`${excluded}\` under "Out of scope", and this change edits ${file}.`
                : `The pull request's description limits the change to ${goal.scope.map(s => `\`${s}\``).join(', ')}, and this change edits ${file}.`,
            severity: 'high',
            provenance: 'ai-drift',
            files: [file],
            ...(changed[file] ? { line: changed[file] } : {}),
            hint: 'Move this change to its own pull request, or add the path to the description\'s Scope if it belongs to this goal.',
        });
    }
    for (const item of goal.doneWhen) {
        const missingPaths = item.paths.filter(p => !files.some(file => covers(p.replace(/^\.\//, ''), file) || file.endsWith(`/${p}`)));
        const missingSymbols = item.symbols.filter(symbol => !new RegExp(`(^|[^\\w$])${symbol.replace(/[.$]/g, m => `\\${m}`)}([^\\w$]|$)`, 'm').test(touched));
        // A file the change never touches is proof the item is not done; a symbol is not: an item can name one it keeps as is ("still the only check").
        if (missingPaths.length) failures.push({
            id: 'goal-done-when',
            title: `"Done when" names ${missingPaths.map(m => `\`${m}\``).join(', ')}, and the change never touches ${missingPaths.length === 1 ? 'it' : 'them'}`,
            details: `The description's "Done when" says: ${item.text}`,
            severity: 'high',
            provenance: 'ai-drift',
            files: [],
            hint: 'Make the change the item asks for, or correct the item if the goal changed.',
        });
        if (missingSymbols.length) failures.push({
            id: 'goal-done-when',
            title: `${missingSymbols.map(m => `\`${m}\``).join(', ')} named in "Done when", not changed by this pull request: check it's met`,
            details: `The description's "Done when" says: ${item.text}`,
            severity: 'medium',
            provenance: 'ai-drift',
            files: [],
            advisory: true,
            hint: 'If the item asks for a change, make it; if it states something the change keeps true, nothing to do.',
        });
    }
    return failures;
}
