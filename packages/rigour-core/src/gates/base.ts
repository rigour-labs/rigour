import { GoldenRecord } from '../services/context-engine.js';
import { Failure, Severity, Provenance } from '../types/index.js';
import type { FileSystemCache } from '../services/filesystem-cache.js';

export interface GateContext {
    cwd: string;
    record?: GoldenRecord;
    ignore?: string[];
    patterns?: string[];
    /** Shared file cache across gates — reduces memory ~80% on large repos */
    fileCache?: FileSystemCache;
    /** A gate that could not check (nothing to compare with) says why: the run shows SKIP, never PASS. */
    skip?: (reason: string) => void;
}

export abstract class Gate {
    constructor(public readonly id: string, public readonly title: string) { }

    abstract run(context: GateContext): Promise<Failure[]>;

    /**
     * A gate whose findings are notes until the team opts in to blocking: `rigour check` reports them, its summary says
     * NOTE for the gate, and its verdict ignores them, as the review's does (they are `likely`).
     */
    get advisory(): boolean { return false; }

    /** Default provenance for this gate — subclasses override */
    protected get provenance(): Provenance { return 'traditional'; }

    protected createFailure(details: string, files?: string[], hint?: string, title?: string, line?: number, endLine?: number, severity?: Severity): Failure {
        return {
            id: this.id,
            title: title || this.title,
            details,
            severity: severity || 'medium',
            provenance: this.provenance,
            files,
            line,
            endLine,
            hint,
        };
    }
}
