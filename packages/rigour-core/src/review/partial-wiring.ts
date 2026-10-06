/**
 * Partial wiring: a change adds a prop to some mounts of a component, and a sibling mount of the
 * same kind (agreeing on a literal prop, such as `mode="quiz"`, in at least three files) still lacks it, so that place keeps the
 * old behaviour (a handler never called, events missing). Svelte and JSX mounts are read with a
 * brace-aware scanner; a mount that spreads props (`{...rest}`) is given the benefit of the doubt.
 * Reported on the line that adds the prop.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { Config, Failure } from '../types/index.js';
import { isTestFile } from './test-files.js';

const MOUNTING = /\.(svelte|tsx|jsx)$/;
/** Tests and stories mount components to exercise them, not to wire behaviour. */
const skipped = (file: string) => isTestFile(file) || /\.stories\./.test(file);
const GIT_TIMEOUT_MS = 10_000;

interface Mount { file: string; line: number; endLine: number; component: string; props: Set<string>; literals: Map<string, string>; spreads: boolean }

export function partialWiringFailures(cwd: string, changedLines: Record<string, Set<number>>, config: Config): Failure[] {
    if (!config.gates.change_sweep?.enabled) return [];
    const failures: Failure[] = [];
    const seen = new Set<string>();
    for (const [file, lines] of Object.entries(changedLines)) {
        if (!MOUNTING.test(file) || skipped(file) || lines.size === 0) continue;
        for (const mount of mountsIn(cwd, file)) {
            for (const { prop, line } of addedProps(cwd, mount, lines)) {
                const key = `${mount.component}\0${prop}`;
                if (seen.has(key)) continue;
                seen.add(key);
                // A missed wiring is a callback the project's own component offers (`onResume`), among mounts
                // of the same kind (a literal they agree on, `mode="quiz"`) in several files. UI-kit and icon
                // components, styling props and DOM events take different values everywhere by design.
                if (!/^on[A-Z]/.test(prop) || mount.literals.size === 0 || !isLocalComponent(cwd, mount)) continue;
                const kin = mountsOf(cwd, mount.component).filter(m => sameKind(m, mount));
                if (new Set(kin.map(m => m.file)).size < 3) continue;
                const missing = kin.filter(m => !m.props.has(prop) && !m.spreads);
                const having = kin.filter(m => m.props.has(prop));
                if (kin.length >= 3 && having.length >= 2 && missing.length >= 1 && missing.length < having.length) {
                    failures.push(unwired(mount, prop, line, missing));
                }
            }
        }
    }
    return failures;
}

/** Props on the mount written on a line the change added, with that line (where a finding belongs). */
function addedProps(cwd: string, mount: Mount, lines: Set<number>): Array<{ prop: string; line: number }> {
    const text = fs.readFileSync(path.join(cwd, mount.file), 'utf8').split('\n');
    const added = new Map<string, number>();
    for (let line = mount.line; line <= mount.endLine; line++) {
        if (!lines.has(line)) continue;
        for (const prop of mount.props) {
            if (!added.has(prop) && new RegExp(`(^|[\\s{])${prop.replace(/[$]/g, '\\$')}(\\s*=|\\s*}|\\s|$)`).test(text[line - 1] ?? '')) added.set(prop, line);
        }
    }
    return [...added].map(([prop, line]) => ({ prop, line }));
}

/** The component is imported from the project itself (a relative path or a project alias), not a package. */
function isLocalComponent(cwd: string, mount: Mount): boolean {
    const text = fs.readFileSync(path.join(cwd, mount.file), 'utf8');
    const name = mount.component.split('.')[0];
    const imported = new RegExp(`import\\s+(?:type\\s+)?(?:${name}\\b[^;]*?|\\{[^}]*\\b${name}\\b[^}]*\\})\\s*from\\s*['"]([^'"]+)['"]`).exec(text);
    return !!imported && /^(\.|\$lib\/|@\/|~\/|src\/)/.test(imported[1]);
}

function sameKind(a: Mount, b: Mount): boolean {
    return [...b.literals].every(([name, value]) => a.literals.get(name) === value);
}

const mountCache = new Map<string, Mount[]>();

/** Every mount of `component` in the repository's Svelte and JSX files. */
function mountsOf(cwd: string, component: string): Mount[] {
    const key = `${cwd}\0${component}`;
    const cached = mountCache.get(key);
    if (cached) return cached;
    const grep = spawnSync('git', ['grep', '--untracked', '-l', '-F', '-e', `<${component}`], { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
    const files = grep.status === 0 ? grep.stdout.split('\n').filter(f => f && MOUNTING.test(f) && !skipped(f)) : [];
    const mounts = files.flatMap(file => mountsIn(cwd, file).filter(m => m.component === component));
    mountCache.set(key, mounts);
    return mounts;
}

/** Component tags (capitalised) in a file, with their props, read without breaking on `>` inside braces or quotes. */
function mountsIn(cwd: string, file: string): Mount[] {
    let text: string;
    try {
        text = fs.readFileSync(path.join(cwd, file), 'utf8');
    } catch {
        return [];
    }
    const mounts: Mount[] = [];
    const tag = /<([A-Z][\w.]*)(?=[\s/>])/g;
    for (let match = tag.exec(text); match; match = tag.exec(text)) {
        const end = tagEnd(text, match.index + match[0].length);
        if (end < 0) continue;
        const body = text.slice(match.index + match[0].length, end);
        const line = text.slice(0, match.index).split('\n').length;
        mounts.push({ file, line, endLine: line + body.split('\n').length - 1, component: match[1], ...props(body) });
    }
    return mounts;
}

/** Index of the `>` that closes the tag starting at `from`, skipping braces and quotes. */
function tagEnd(text: string, from: number): number {
    let depth = 0;
    let quote = '';
    for (let i = from; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === quote) quote = '';
        } else if (c === '"' || c === "'" || c === '`') {
            quote = c;
        } else if (c === '{') {
            depth++;
        } else if (c === '}') {
            depth--;
        } else if (c === '>' && depth === 0) {
            return i;
        }
    }
    return -1;
}

/**
 * A tag's props: `name="literal"`, `name={…}`, the shorthand `{name}`, and whether it spreads
 * `{...rest}`. Text inside braces is code, not props, and never read as one.
 */
function props(body: string): { props: Set<string>; literals: Map<string, string>; spreads: boolean } {
    let top = '';
    let depth = 0;
    let quote = '';
    let inner = '';
    for (const c of body) {
        if (quote) {
            if (depth === 0) top += c;
            else inner += c;
            if (c === quote) quote = '';
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            quote = c;
            if (depth === 0) top += c;
            else inner += c;
            continue;
        }
        if (c === '{') {
            if (depth > 0) inner += c;
            depth++;
            continue;
        }
        if (c === '}') {
            depth--;
            if (depth > 0) {
                inner += c;
                continue;
            }
            const content = inner.trim();
            top += /^\.\.\./.test(content) ? '{...}' : /^[A-Za-z_$][\w$]*$/.test(content) ? `{${content}}` : '{}';
            inner = '';
            continue;
        }
        if (depth === 0) top += c;
        else inner += c;
    }
    const names = new Set<string>();
    const literals = new Map<string, string>();
    for (const m of top.matchAll(/([A-Za-z_$][\w$:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{)/g)) {
        names.add(m[1]);
        if (m[2] !== undefined || m[3] !== undefined) literals.set(m[1], m[2] ?? m[3]);
    }
    for (const m of top.matchAll(/(?<![=\w$])\{([A-Za-z_$][\w$]*)\}/g)) names.add(m[1]);
    return { props: names, literals, spreads: top.includes('{...}') };
}

function unwired(mount: Mount, prop: string, line: number, missing: Mount[]): Failure {
    const where = missing.slice(0, 5).map(m => `\`${m.file}:${m.line}\``).join(', ');
    return {
        id: 'partial-wiring',
        title: 'Wired in some places, not all',
        details: `\`${prop}\` is passed to \`<${mount.component}>\` here and in other mounts of the same kind, but not at ${where}, so that place keeps the old behaviour.`,
        severity: 'medium',
        provenance: 'traditional',
        files: [mount.file],
        line,
        hint: `Pass \`${prop}\` there too, or say why that mount should not have it.`,
    };
}
