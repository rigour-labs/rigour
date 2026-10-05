import fs from 'fs';
import path from 'path';

/** A tool the project installed itself, never a download: node_modules/.bin from `dir` up to `root`. */
export function installedBin(dir: string, root: string, name: string): string | undefined {
    for (let current = dir; current.startsWith(root); current = path.dirname(current)) {
        for (const candidate of process.platform === 'win32' ? [`${name}.cmd`, name] : [name]) {
            const bin = path.join(current, 'node_modules', '.bin', candidate);
            if (fs.existsSync(bin)) return bin;
        }
        if (current === root) break;
    }
    return undefined;
}
