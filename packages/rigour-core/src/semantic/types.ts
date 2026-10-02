/**
 * Semantic engine types.
 *
 * A semantic rule reports a defect only when it can show how it happens:
 * the line where the risky value enters and the line where it does harm.
 * Anything the engine cannot resolve produces no finding.
 */
import type ts from 'typescript';
import type { Provenance, Severity } from '../types/index.js';
import type { ProjectFacts } from './project-facts.js';
import type { Summaries } from './summaries.js';

export interface SemanticFinding {
    rule: string;
    severity: Severity;
    provenance: Provenance;
    /** cwd-relative posix path of the reported line. */
    file: string;
    line: number;
    /** Last line of the code the finding is about (a call), when it spans several lines. */
    endLine?: number;
    message: string;
    hint: string;
    /** Supporting locations, e.g. "http.ts:51 deps.fetch(url, init)". */
    evidence: string[];
}

export interface RuleContext {
    cwd: string;
    program: ts.Program;
    checker: ts.TypeChecker;
    sourceFile: ts.SourceFile;
    summaries: Summaries;
    /** The file's own package: declared dependencies and compiler options. */
    project: ProjectFacts;
}

export interface SemanticRule {
    id: string;
    check(ctx: RuleContext): SemanticFinding[];
}
