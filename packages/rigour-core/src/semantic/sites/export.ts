/**
 * Call sites for a set of files, through the same program construction the
 * semantic engine uses (project modules resolved, libraries skipped).
 */
import path from 'path';
import { loadProjectConfig, programBatches } from '../program.js';
import { findCallSites, type CallSite } from './call-sites.js';

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

export function exportCallSites(cwd: string, files: string[]): CallSite[] {
    const roots = files.filter(f => SOURCE.test(f) && !/\.d\.[cm]?ts$/i.test(f)).map(f => path.resolve(cwd, f));
    if (roots.length === 0) return [];
    const wanted = new Set(roots.map(r => path.normalize(r)));
    const sites: CallSite[] = [];
    for (const program of programBatches(roots, loadProjectConfig(cwd).options)) {
        for (const sourceFile of program.getSourceFiles()) {
            if (wanted.delete(path.normalize(sourceFile.fileName))) sites.push(...findCallSites(cwd, program.getTypeChecker(), sourceFile));
        }
    }
    return sites;
}
