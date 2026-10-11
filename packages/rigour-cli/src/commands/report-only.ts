/**
 * Report-only: a team's first week. Every gate (the edit check, the stop review, the push gate, git's pre-push hook
 * included) says what it would have blocked and lets the work through; `rigour setup --block` makes them block.
 * The scan for credentials before a tool call is not one of them and keeps denying a real secret.
 *
 * Read at run time, so the hook commands never change between the first week and after: from rigour.yml
 * (`hooks.report_only`, a team's choice, written by `rigour setup --team --report-only`) or from a marker in the
 * repository's git directory (a person's, written by `rigour setup --report-only`, never in the working tree).
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { Config } from '@rigour-labs/core';

const MARKER = 'rigour-report-only';

/** What a gate says instead of blocking. */
export const REPORT_ONLY_PREFIX = 'Rigour (report only; nothing was blocked, `rigour setup --block` makes it block):';

function markerPath(cwd: string): string | undefined {
    const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' });
    return common.status === 0 ? path.join(common.stdout.trim(), MARKER) : undefined;
}

/** Whether this repository's gates only report. */
export function reportOnly(cwd: string, config?: Config): boolean {
    if (config?.hooks?.report_only) return true;
    const marker = markerPath(cwd);
    return !!marker && fs.existsSync(marker);
}

/** Sets or clears the person's switch for this repository; false outside a git repository. */
export function setReportOnlyHere(cwd: string, on: boolean): boolean {
    const marker = markerPath(cwd);
    if (!marker) return false;
    if (on) fs.writeFileSync(marker, 'Rigour reports and never blocks here (rigour setup --report-only). `rigour setup --block` makes it block.\n');
    else fs.rmSync(marker, { force: true });
    return true;
}
