/**
 * Coverage: the reviewer accounts for every changed unit it is given, so "no findings" means "looked at each, and
 * here is what was checked", never an empty answer by default. A unit is a changed function where the language
 * parses (JS/TS, through the risk router), else a changed hunk named by git's own function context (any language).
 * A unit the judge leaves out gets one follow-up run; one still missing is reported as not reviewed, never passed.
 */
import { rankChangedFunctions } from '../../deep/risk.js';
import { changedLinesByFile, parseDiff, removedByFile } from '../../utils/diff.js';

/** The most units one review accounts for: past it, the rest are listed as not offered, ranked by risk and size. */
const MAX_UNITS = 25;

export interface ChangedUnit {
    file: string;
    /** The function's name, or git's context line for a hunk ("func (c *Conn) Close() error"), or "lines a-b". */
    name: string;
    start: number;
    end: number;
}

export interface UnitCheck {
    file: string;
    unit: string;
    /** "finding": a finding in this answer is about it; "fine": looked at, nothing to raise. */
    status: 'finding' | 'fine';
    /** What was checked, or which finding it is. */
    note: string;
    reviewer?: string;
}

export interface Coverage {
    /** Units given to the reviewer. */
    units: number;
    /** Changed units past MAX_UNITS: never given, so never claimed reviewed. */
    notOffered: number;
    accounted: number;
    /** Units the reviewer left out even after the follow-up: shown as not reviewed. */
    notReviewed: string[];
    followUp: boolean;
}

const SKIP = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock)$|\.(snap|map|min\.js|min\.css|md|mdx|txt|rst|json|ya?ml|toml|lock|svg|png|jpg|gif)$/i;
const PARSEABLE = /\.(?:[cm]?[jt]sx?)$/i;

/** The changed units of a diff, riskiest and largest first, at most MAX_UNITS; `total` counts them all. */
export function changedUnits(cwd: string, diff: string): { units: ChangedUnit[]; total: number } {
    const changed = parseDiff(diff);
    const lines = changedLinesByFile(changed);
    const parsed = rankChangedFunctions(cwd, lines, removedByFile(diff)).map(f => ({ unit: { file: f.file, name: f.name, start: f.start, end: f.end }, weight: 1_000 + f.score }));
    const parsedFiles = new Set(parsed.map(p => p.unit.file));
    const hunks = hunkUnits(diff).filter(h => !PARSEABLE.test(h.unit.file) || !parsedFiles.has(h.unit.file));
    const all = [...parsed, ...hunks].filter(u => !SKIP.test(u.unit.file)).sort((a, b) => b.weight - a.weight || a.unit.file.localeCompare(b.unit.file) || a.unit.start - b.unit.start);
    return { units: all.slice(0, MAX_UNITS).map(u => u.unit), total: all.length };
}

/** Hunks named by git's function context, merged per file and context; weighted by the lines they add. */
function hunkUnits(diff: string): Array<{ unit: ChangedUnit; weight: number }> {
    const units = new Map<string, { unit: ChangedUnit; weight: number }>();
    let file = '';
    let current: { unit: ChangedUnit; weight: number } | undefined;
    for (const line of diff.split('\n')) {
        if (line.startsWith('+++ ')) {
            file = line.slice(4).replace(/^b\//, '').trim();
            current = undefined;
        } else if (line.startsWith('@@ ')) {
            current = file && file !== '/dev/null' ? hunkUnit(units, file, line) : undefined;
        } else if (current && line.startsWith('+')) {
            current.weight++;
        }
    }
    return [...units.values()];
}

/** The unit a hunk header belongs to: the one already open for the same file and context, or a new one. */
function hunkUnit(units: Map<string, { unit: ChangedUnit; weight: number }>, file: string, header: string): { unit: ChangedUnit; weight: number } | undefined {
    const hunk = header.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
    if (!hunk) return undefined;
    const start = Number(hunk[1]);
    const end = start + Math.max(0, Number(hunk[2] ?? 1) - 1);
    const context = hunk[3].trim();
    const key = `${file}\u0000${context || start}`;
    const existing = units.get(key);
    if (existing) {
        existing.unit.end = Math.max(existing.unit.end, end);
        return existing;
    }
    const made = { unit: { file, name: context || `lines ${start}-${end}`, start, end }, weight: 0 };
    units.set(key, made);
    return made;
}

/** The input file the prompt names: one unit per line, as the judge must name it back. */
export function unitsText(units: ChangedUnit[], notOffered: number): string {
    const list = units.map(u => `- ${u.file} :: ${u.name} (lines ${u.start}-${u.end})`).join('\n');
    return `${list}\n${notOffered ? `(${notOffered} more changed unit(s) are not in this list; do not report on them.)\n` : ''}`;
}

/** The step in the reviewer's instructions. */
export function coverageStep(unitsFile: string): string {
    return `
Coverage. ${unitsFile} lists the changed units of this change (functions, or hunks named by their
   enclosing code). For EVERY unit listed, add one entry to functions, naming the file and the unit
   exactly as listed: status "finding" when a finding in your answer is about it (note: which one), or
   status "fine" with a note saying what you checked in it and why it holds (one line, specific to the
   code). A unit you did not look at is not fine: read it. Leaving a unit out means it was not reviewed.
`;
}

export const COVERAGE_FORMAT = ` "functions":[{"file":"...","unit":"<as listed>","status":"finding"|"fine","note":"..."}],
`;

/** The one follow-up run for units the answer left out. */
export function followUpPrompt(repoRoot: string, head: string, diffFile: string, missing: ChangedUnit[]): string {
    return `You reviewed the change at ${head} in ${repoRoot} (the diff is ${diffFile}), and your answer did not
account for these changed units:
${missing.map(u => `- ${u.file} :: ${u.name} (lines ${u.start}-${u.end})`).join('\n')}

Review each one now, read-only: open it, follow what it calls and its callers as far as you need. For EVERY unit
above, add one entry to functions (status "finding" with the finding, or "fine" with what you checked and why it
holds). Report a finding only with the same evidence as before: file, line, an exact quote, the input and the
consequence; anything weaker is not a finding.

Your final message must be ONLY this JSON, starting with { and ending with }:
{"prior_points":[],"reads":[],"functions":[{"file":"...","unit":"<as listed>","status":"finding"|"fine","note":"..."}],
 "findings":[{"class":"...","severity":"blocking"|"should","file":"...","line":0,"issue":"...","why":"...","input":"...","consequence":"...","quote":"...","absent":"..."}]}`;
}

/** How far outside a unit's lines a finding may sit and still be about it (a hunk's edges are approximate). */
const LINE_SLACK = 3;

/**
 * The units no answer accounted for. One entry accounts for one unit: the unit of that file with the same name, else
 * the only one of that file's remaining units whose name contains it. An entry needs a note; a "finding" entry also
 * needs a finding that survived validation (`findings`), in that file and within the unit's lines.
 */
export function unaccounted(units: ChangedUnit[], checks: UnitCheck[], findings: Array<{ file?: string; line?: number }>): ChangedUnit[] {
    const norm = (s: string) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    const supported = (c: UnitCheck, u: ChangedUnit) => c.status === 'fine'
        || findings.some(f => f.file === u.file && f.line !== undefined && f.line >= u.start - LINE_SLACK && f.line <= u.end + LINE_SLACK);
    const left = [...units];
    const usable = checks.filter(c => c.note?.trim() && c.unit?.trim());
    const used = new Set<UnitCheck>();
    const take = (c: UnitCheck, u: ChangedUnit | undefined) => {
        if (!u) return;
        left.splice(left.indexOf(u), 1);
        used.add(c);
    };
    for (const c of usable) take(c, left.find(u => u.file === c.file && norm(u.name) === norm(c.unit) && supported(c, u)));
    for (const c of usable) {
        if (used.has(c) || norm(c.unit).length < 3) continue;
        const candidates = left.filter(u => u.file === c.file && norm(u.name).includes(norm(c.unit)) && supported(c, u));
        if (candidates.length === 1) take(c, candidates[0]);
    }
    return left;
}

export function unitLabel(u: ChangedUnit): string {
    return `${u.file} :: ${u.name}`;
}
