import fs from 'fs-extra';
import path from 'path';
import { Config } from './types/index.js';
import { TEMPLATES, UNIVERSAL_CONFIG } from './templates/index.js';

export class DiscoveryService {
    async discover(cwd: string): Promise<Config> {
        const config = { ...UNIVERSAL_CONFIG };

        for (const template of TEMPLATES) {
            const match = await this.hasAnyMarker(cwd, template.markers);
            if (match) {
                // Merge template config
                config.commands = { ...config.commands, ...template.config.commands };
                config.gates = { ...config.gates, ...template.config.gates };
            }
        }

        return config;
    }

    private async hasAnyMarker(cwd: string, markers: string[]): Promise<boolean> {
        for (const marker of markers) {
            if (await fs.pathExists(path.join(cwd, marker))) {
                return true;
            }
        }
        return false;
    }
}
