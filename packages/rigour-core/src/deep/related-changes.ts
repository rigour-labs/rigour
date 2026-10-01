/**
 * Related changes: a function the PR changed, called from another file the
 * PR also changed. When both sides of a call move in one PR, the contract
 * between them is the likeliest thing to break (one side reads a value live,
 * the other still passes a constant), and a reviewer reading file by file,
 * or running out of budget before the second file, misses it.
 */
import fs from 'fs';
import path from 'path';
import type { FunctionRisk } from './risk.js';

const MAX_LINKS = 8;
const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)__tests__\//;

export interface RelatedChange {
    /** The changed function, and where it is defined. */
    callee: string;
    calleeFile: string;
    calleeLine: number;
    /** Another changed file that calls it, and the first call line. */
    callerFile: string;
    callerLine: number;
}

export function relatedChanges(cwd: string, changedFiles: string[], changed: FunctionRisk[]): RelatedChange[] {
    const exported = changed.filter(f => f.signals.exported && /^[A-Za-z_$][\w$]*$/.test(f.name));
    if (exported.length === 0) return [];
    const texts = new Map(changedFiles.map(file => [file, readLines(cwd, file)] as const));
    const links: RelatedChange[] = [];
    for (const fn of exported) {
        const call = new RegExp(`(^|[^\\w$.])${fn.name.replace(/\$/g, '\\$')}\\s*\\(`);
        for (const [file, lines] of texts) {
            if (file === fn.file || !lines || TEST_FILE.test(file) || !importsFrom(lines.join('\n'), fn.name, file, fn.file)) continue;
            const index = lines.findIndex(line => call.test(line) && !/^\s*(import|export\s+\{)/.test(line));
            if (index === -1) continue;
            links.push({ callee: fn.name, calleeFile: fn.file, calleeLine: fn.start, callerFile: file, callerLine: index + 1 });
            if (links.length >= MAX_LINKS) return links;
        }
    }
    return links;
}

/** The caller imports `name` from the callee's module (relative or aliased path). */
export function importsFrom(text: string, name: string, callerFile: string, calleeFile: string): boolean {
    const target = calleeFile.replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '');
    const imports = text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g);
    for (const [, names, spec] of imports) {
        if (!new RegExp(`(^|[\\s,])${name.replace(/\$/g, '\\$')}(\\s|,|$)`).test(names)) continue;
        const module = spec.replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '');
        const resolved = module.startsWith('.')
            ? path.posix.normalize(path.posix.join(path.posix.dirname(callerFile), module))
            : module.replace(/^[@~]\//, '');
        if (target === resolved || target.endsWith(`/${resolved}`)) return true;
    }
    return false;
}

function readLines(cwd: string, file: string): string[] | undefined {
    try {
        return fs.readFileSync(path.join(cwd, file), 'utf-8').split('\n');
    } catch {
        return undefined;
    }
}
