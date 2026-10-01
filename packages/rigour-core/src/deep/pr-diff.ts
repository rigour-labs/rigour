/**
 * A diff as a reviewer reads it: one section per file, every new-side line
 * carrying its line number, so a finding can name the exact line to fix.
 * Lockfiles, build output and minified files carry no reviewable logic and
 * are left out.
 */
const GENERATED = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|go\.sum)$|(^|\/)(dist|build|out|coverage|\.next|node_modules)\/|\.min\.(js|css)$|\.(snap|map)$/;

export interface DiffSection {
    file: string;
    /** The section with new-side line numbers. */
    text: string;
    addedLines: number;
}

export function diffSections(diff: string): DiffSection[] {
    const sections: DiffSection[] = [];
    let current: DiffSection | null = null;
    let newLine = 0;
    let out: string[] = [];
    const flush = () => {
        if (current && !GENERATED.test(current.file)) sections.push({ ...current, text: out.join('\n') });
    };
    for (const line of diff.split('\n')) {
        if (line.startsWith('diff --git ')) {
            flush();
            current = { file: '', text: '', addedLines: 0 };
            out = [];
        } else if (!current) {
            continue;
        } else if (line.startsWith('+++ ')) {
            current.file = line.startsWith('+++ b/') ? line.slice(6).trim() : '';
            out.push(`FILE ${current.file || '(deleted)'}`);
        } else if (line.startsWith('@@')) {
            newLine = Number(/\+(\d+)/.exec(line)?.[1] ?? 1);
            out.push(line);
        } else if (line.startsWith('+')) {
            out.push(`${String(newLine++).padStart(5)} + ${line.slice(1)}`);
            current.addedLines++;
        } else if (line.startsWith('-') && !line.startsWith('--- ')) {
            out.push(`      - ${line.slice(1)}`);
        } else if (line.startsWith(' ')) {
            out.push(`${String(newLine++).padStart(5)}   ${line.slice(1)}`);
        }
    }
    flush();
    return sections.filter(s => s.file);
}
