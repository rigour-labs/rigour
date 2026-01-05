import { GoldenRecord } from '../services/context-engine.js';
import { Failure } from '../types/index.js';

export interface GateContext {
    cwd: string;
    record?: GoldenRecord;
    ignore?: string[];
    patterns?: string[];
}

export abstract class Gate {
    constructor(public readonly id: string, public readonly title: string) { }

    abstract run(context: GateContext): Promise<Failure[]>;

    protected createFailure(details: string, files?: string[], hint?: string): Failure {
        return {
            id: this.id,
            title: this.title,
            details,
            files,
            hint,
        };
    }
}
