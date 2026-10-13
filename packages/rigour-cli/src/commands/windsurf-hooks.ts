/**
 * Which project file Windsurf's Cascade hooks are read from. Windsurf is now Devin Desktop, which reads
 * `.devin/hooks.json` and falls back to the legacy `.windsurf/hooks.json` only when `.devin/hooks.json` is absent
 * or defines no hooks (https://docs.devin.ai/desktop/cascade/hooks). Old Windsurf reads the legacy file only.
 * Rigour writes where the editor reads, and never creates `.devin/hooks.json` just for itself.
 */
import fs from 'fs';
import path from 'path';
import { jsonText } from './json-file.js';
import { isEmptyConfig, readInstallRecord, withoutRigour } from './install-record.js';

export const DEVIN_HOOKS = '.devin/hooks.json';
export const WINDSURF_HOOKS = '.windsurf/hooks.json';

type Read = (rel: string) => string;

const readIn = (cwd: string): Read => rel => { try { return fs.readFileSync(path.join(cwd, rel), 'utf8'); } catch { return ''; } };

/** Whether a hooks file defines at least one hook. A file that is not JSON counts: the editor is not ignoring it for being empty. */
function definesHooks(text: string): boolean {
    try {
        const hooks = JSON.parse(text)?.hooks;
        return !!hooks && typeof hooks === 'object' && Object.values(hooks).some(list => Array.isArray(list) && list.length > 0);
    } catch {
        return true;
    }
}

/** The file Devin Desktop reads for this workspace: `.devin/hooks.json` when it defines hooks, else the legacy one. */
export function liveWindsurfHooks(read: Read): string {
    const devin = read(DEVIN_HOOKS);
    return devin && definesHooks(devin) ? DEVIN_HOOKS : WINDSURF_HOOKS;
}

/** Where Rigour's Windsurf hooks go in this repository. */
export function windsurfHooksPath(cwd: string): string {
    return liveWindsurfHooks(readIn(cwd));
}

/** Rigour's hooks sit only in the legacy file, which Devin Desktop ignores because `.devin/hooks.json` defines hooks. */
export function rigourHooksIgnored(read: Read): boolean {
    return liveWindsurfHooks(read) === DEVIN_HOOKS && namesRigourHooks(read(WINDSURF_HOOKS)) && !namesRigourHooks(read(DEVIN_HOOKS));
}

function namesRigourHooks(text: string): boolean {
    return /rigour/i.test(text) && /\bhooks\s+check\b/.test(text);
}

/**
 * Once Rigour's hooks are in `.devin/hooks.json`: its own entries come out of the legacy file, the person's stay. A
 * legacy file Rigour created and that is now empty is deleted. Returns what happened, or nothing when there was nothing to do.
 */
export function removeFromLegacy(cwd: string): string | undefined {
    if (windsurfHooksPath(cwd) !== DEVIN_HOOKS) return undefined;
    const file = path.join(cwd, WINDSURF_HOOKS);
    let text: string;
    let parsed: unknown;
    try {
        text = fs.readFileSync(file, 'utf8');
        parsed = JSON.parse(text);
    } catch {
        return undefined; // absent, or not JSON: not Rigour's to change
    }
    const stripped = withoutRigour(parsed);
    if (JSON.stringify(stripped) === JSON.stringify(parsed)) return undefined;
    if (isEmptyConfig(stripped) && WINDSURF_HOOKS in readInstallRecord(cwd).created) {
        fs.unlinkSync(file);
        return `deleted ${WINDSURF_HOOKS}, which held only Rigour's hooks`;
    }
    fs.writeFileSync(file, jsonText(stripped, text));
    return `removed Rigour's entries from ${WINDSURF_HOOKS} (your entries there kept)`;
}
