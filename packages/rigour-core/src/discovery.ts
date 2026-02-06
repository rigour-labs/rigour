import fs from 'fs-extra';
import path from 'path';
import { Config, Gates } from './types/index.js';
import { TEMPLATES, PARADIGM_TEMPLATES, UNIVERSAL_CONFIG } from './templates/index.js';

export interface DiscoveryResult {
    config: Config;
    matches: {
        preset?: { name: string; marker: string };
        paradigm?: { name: string; marker: string };
    };
}

export class DiscoveryService {
    async discover(cwd: string): Promise<DiscoveryResult> {
        let config = { ...UNIVERSAL_CONFIG };
        const matches: DiscoveryResult['matches'] = {};

        // 1. Detect Role (ui, api, infra, data)
        for (const template of TEMPLATES) {
            const marker = await this.findFirstMarker(cwd, template.markers, true); // Search content for roles too
            if (marker) {
                config = this.mergeConfig(config, template.config);
                matches.preset = { name: template.name, marker };
                break; // Only one role for now
            }
        }

        // 2. Detect Paradigm (oop, functional)
        for (const template of PARADIGM_TEMPLATES) {
            const marker = await this.findFirstMarker(cwd, template.markers, true); // Search content
            if (marker) {
                config = this.mergeConfig(config, template.config);
                matches.paradigm = { name: template.name, marker };
                break;
            }
        }

        return { config, matches };
    }

    private mergeConfig(base: Config, extension: any): Config {
        // Deep merge for gates to preserve defaults when overrides are partial
        const mergedGates = { ...base.gates };
        if (extension.gates) {
            for (const [key, value] of Object.entries(extension.gates)) {
                if (typeof value === 'object' && value !== null && !Array.isArray(value) && (mergedGates as any)[key]) {
                    (mergedGates as any)[key] = { ...(mergedGates as any)[key], ...value };
                } else {
                    (mergedGates as any)[key] = value;
                }
            }
        }

        return {
            ...base,
            preset: extension.preset || base.preset,
            paradigm: extension.paradigm || base.paradigm,
            commands: { ...base.commands, ...extension.commands },
            gates: mergedGates as Gates,
            ignore: [...new Set([...(base.ignore || []), ...(extension.ignore || [])])],
        };
    }

    private async findFirstMarker(cwd: string, markers: string[], searchContent: boolean = false): Promise<string | null> {
        for (const marker of markers) {
            const fullPath = path.join(cwd, marker);

            // File/Directory existence check
            if (await fs.pathExists(fullPath)) {
                return marker;
            }

            // Deep content check for paradigms
            if (searchContent) {
                const match = await this.existsInContent(cwd, marker);
                if (match) return `content:${marker}`;
            }
        }
        return null;
    }

    private async existsInContent(cwd: string, pattern: string): Promise<boolean> {
        // Simple heuristic: search in top 5 source files
        const files = await this.findSourceFiles(cwd);
        for (const file of files) {
            const content = await fs.readFile(file, 'utf-8');
            if (content.includes(pattern)) return true;
        }
        return false;
    }

    private async findSourceFiles(cwd: string): Promise<string[]> {
        const extensions = ['.ts', '.js', '.py', '.go', '.java', '.tf', 'package.json'];
        const samples: string[] = [];
        const commonDirs = ['.', 'src', 'app', 'lib', 'api', 'pkg'];

        for (const dir of commonDirs) {
            const fullDir = path.join(cwd, dir);
            if (!(await fs.pathExists(fullDir))) continue;

            const files = await fs.readdir(fullDir);
            for (const file of files) {
                if (extensions.some(ext => file.endsWith(ext))) {
                    samples.push(path.join(fullDir, file));
                    if (samples.length >= 5) return samples;
                }
            }
        }
        return samples;
    }
}
