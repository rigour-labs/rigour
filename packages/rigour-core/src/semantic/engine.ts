/**
 * Runs semantic rules over a set of JS/TS files.
 */
import path from 'path';
import { loadProjectConfig, programBatches } from './program.js';
import { ProjectFacts } from './project-facts.js';
import { Summaries } from './summaries.js';
import type { SemanticFinding, SemanticRule } from './types.js';
import { inMemoryAggregation } from './rules/in-memory-aggregation.js';
import { credentialRedirect } from './rules/credential-redirect.js';
import { degradedResponseCached } from './rules/degraded-response-cached.js';
import { CANDIDATE_RULES, ECOSYSTEM_RULES } from './rules/ecosystem/index.js';

/** Rules that run by default. */
export const BUILT_IN_RULES: SemanticRule[] = [inMemoryAggregation, credentialRedirect, degradedResponseCached, ...ECOSYSTEM_RULES];

/** Every rule Rigour ships, candidates included: what can be named to run. */
export const ALL_RULES: SemanticRule[] = [...BUILT_IN_RULES, ...CANDIDATE_RULES];

export interface EngineOptions {
    rules?: SemanticRule[];
    batchSize?: number;
}

/** Analyze `files` (cwd-relative or absolute). Declaration files are skipped. */
export function analyzeFiles(cwd: string, files: string[], opts: EngineOptions = {}): SemanticFinding[] {
    const rules = opts.rules ?? BUILT_IN_RULES;
    const roots = files
        .filter(f => /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(f) && !/\.d\.[cm]?ts$/i.test(f))
        .map(f => path.resolve(cwd, f));
    if (roots.length === 0 || rules.length === 0) return [];

    const { options } = loadProjectConfig(cwd);
    const rootSet = new Set(roots.map(r => path.normalize(r)));
    const findings: SemanticFinding[] = [];
    const project = new ProjectFacts(cwd);

    for (const program of programBatches(roots, options, opts.batchSize)) {
        const checker = program.getTypeChecker();
        const summaries = new Summaries(checker);
        for (const sourceFile of program.getSourceFiles()) {
            if (!rootSet.has(path.normalize(sourceFile.fileName))) continue;
            for (const rule of rules) {
                findings.push(...rule.check({ cwd, program, checker, sourceFile, summaries, project }));
            }
            rootSet.delete(path.normalize(sourceFile.fileName));
        }
    }
    return dedupe(findings);
}

function dedupe(findings: SemanticFinding[]): SemanticFinding[] {
    const seen = new Set<string>();
    return findings.filter(f => {
        const key = `${f.rule}:${f.file}:${f.line}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
