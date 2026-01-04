import fs from 'fs-extra';
import path from 'path';
import { Gate, GateContext } from './base.js';
import { Failure } from '../types/index.js';

export interface StructureGateConfig {
    requiredFiles: string[];
}

export class StructureGate extends Gate {
    constructor(private config: StructureGateConfig) {
        super('structure-check', 'Project Structure');
    }

    async run(context: GateContext): Promise<Failure[]> {
        const missing: string[] = [];
        for (const file of this.config.requiredFiles) {
            const filePath = path.join(context.cwd, file);
            if (!(await fs.pathExists(filePath))) {
                missing.push(file);
            }
        }

        if (missing.length > 0) {
            return [
                this.createFailure(
                    'The following required files are missing:',
                    missing,
                    'Create these files to maintain project documentation and consistency.'
                ),
            ];
        }

        return [];
    }
}
