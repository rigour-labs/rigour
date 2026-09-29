/**
 * Intent checks in a scoped deep review (`rigour review --deep`,
 * `rigour check <paths> --deep`): the only questions put to the model are
 * ones the code cannot answer, at sites the engine has already proven.
 *
 * Today that is optional-read-no-fallback: at an `await Promise.all([...])`
 * with no failure handling, is one read optional while another is required?
 * Off unless `deep.intent_checks` is set; see docs/DEEP_ANALYSIS.md for the
 * measured accuracy that decides the default.
 */
import path from 'path';
import type { InferenceProvider } from '../inference/types.js';
import type { Failure } from '../types/index.js';
import { loadProjectConfig, programBatches } from '../semantic/program.js';
import { findParallelReads, type ParallelReadSite } from '../semantic/intent/parallel-reads.js';
import { classifyReads, findingsFor, yesNoModel } from '../semantic/intent/intent-check.js';
import type { SemanticFinding } from '../semantic/types.js';

/** Each read costs two model calls; bound the cost of one review. */
const MAX_SITES = 10;
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

export async function runIntentChecks(
    cwd: string,
    files: string[],
    provider: InferenceProvider,
    onProgress?: (message: string) => void,
): Promise<Failure[]> {
    const sites = findSites(cwd, files.filter(f => SOURCE.test(f) && !/\.d\.[cm]?ts$/i.test(f)));
    if (sites.length === 0) return [];
    const checked = sites.slice(0, MAX_SITES);
    onProgress?.(`  Asking the model about ${checked.length} Promise.all site(s)${sites.length > MAX_SITES ? ` (first ${MAX_SITES} of ${sites.length})` : ''}...`);
    const model = yesNoModel(provider);
    const failures: Failure[] = [];
    for (const site of checked) {
        failures.push(...findingsFor(site, await classifyReads(model, site)).map(toFailure));
    }
    return failures;
}

function findSites(cwd: string, files: string[]): ParallelReadSite[] {
    const roots = files.map(f => path.resolve(cwd, f));
    const wanted = new Set(roots.map(r => path.normalize(r)));
    const sites: ParallelReadSite[] = [];
    for (const program of programBatches(roots, loadProjectConfig(cwd).options)) {
        for (const sourceFile of program.getSourceFiles()) {
            if (wanted.has(path.normalize(sourceFile.fileName))) sites.push(...findParallelReads(cwd, program.getTypeChecker(), sourceFile));
        }
    }
    return sites;
}

function toFailure(finding: SemanticFinding): Failure {
    return {
        id: 'deep-analysis',
        title: `[${finding.rule}] ${finding.message.split('. ')[0]}`.slice(0, 120),
        details: `${finding.message}\n${finding.evidence.map(e => `  at ${e}`).join('\n')}`,
        files: [finding.file],
        line: finding.line,
        hint: finding.hint,
        severity: finding.severity,
        provenance: finding.provenance,
        category: finding.rule,
        source: 'hybrid',
        verified: false,
    };
}
