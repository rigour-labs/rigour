/**
 * Generated files: code a tool wrote, not a change anyone authored.
 *
 * A finding in a generated client, schema dump or lockfile cannot be fixed
 * where it is reported (the next codegen run overwrites it) and is noise in a
 * review. They are recognised by name and by the marker generators put at the
 * top of the file.
 */
import fs from 'fs';
import path from 'path';

const GENERATED_NAME = /(\.|-|_)(gen|generated|pb)\.[cm]?[jt]sx?$|\.d\.ts\.map$|(^|\/)(__generated__|generated|gen)\/|\.min\.[cm]?js$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const GENERATED_MARKER = /@generated\b|\bauto-?generated\b|\bDO NOT EDIT\b|\bThis file (?:is|was) (?:automatically )?generated\b/i;
const HEADER_BYTES = 1024;

export function isGeneratedFile(cwd: string, file: string): boolean {
    if (GENERATED_NAME.test(file)) return true;
    let fd: number | undefined;
    try {
        fd = fs.openSync(path.join(cwd, file), 'r');
        const buffer = Buffer.alloc(HEADER_BYTES);
        const read = fs.readSync(fd, buffer, 0, HEADER_BYTES, 0);
        return GENERATED_MARKER.test(buffer.subarray(0, read).toString('utf8'));
    } catch {
        return false;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

/** The changed lines without generated files. */
export function withoutGenerated(cwd: string, changedLines: Record<string, Set<number>>): Record<string, Set<number>> {
    return Object.fromEntries(Object.entries(changedLines).filter(([file]) => !isGeneratedFile(cwd, file)));
}
