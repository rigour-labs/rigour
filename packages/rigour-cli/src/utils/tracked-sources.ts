/**
 * Tracked, non-test JS/TS source files of a git checkout: the default input of
 * the export commands the driftbench pipelines call.
 */
import { execFileSync } from 'child_process';

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
/** Declarations, tests, fixtures, and generated bundles (dist, build, *-dist, minified). */
const NOT_SOURCE = /\.d\.[cm]?ts$|(?:^|\/)(?:__tests__|__mocks__|tests?|fixtures?|dist|build|[\w-]+-dist)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.min\.[cm]?js$/i;

export function trackedSourceFiles(cwd: string): string[] {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    return out.split('\0').filter(f => f && SOURCE.test(f) && !NOT_SOURCE.test(f));
}
