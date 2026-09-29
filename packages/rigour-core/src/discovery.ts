import fs from 'fs-extra';
import path from 'path';
import { Config, Gates } from './types/index.js';
import { TEMPLATES, PARADIGM_TEMPLATES, UNIVERSAL_CONFIG } from './templates/index.js';
import {
    EXTENSION_MARKERS, PACKAGE_MARKERS, containsToken, hasFileWithExtension, declaresPackage, dependencyNames, detectParadigm, isPathMarker, sampleSourceFiles, stripComments,
} from './discovery-signals.js';

/**
 * Domain keywords are ambiguous alone ("health" score, "transaction" block), and a
 * domain preset adds compliance docs and stricter gates. It needs several keywords,
 * each recurring across files rather than listed once.
 */
const MIN_KEYWORDS = 2;
const MIN_KEYWORD_FILES = 2;

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
        const dependencies = await dependencyNames(cwd);
        const files = await sampleSourceFiles(cwd);
        const contents = await Promise.all(files.map(f => fs.readFile(f, 'utf-8').then(stripComments, () => '')));

        // 1. Role (ui, api, infra, data, domain presets): the first template with a marker wins.
        for (const template of TEMPLATES) {
            const marker = await this.findFirstMarker(cwd, template.markers, dependencies, contents);
            if (marker) {
                config = this.mergeConfig(config, template.config);
                matches.preset = { name: template.name, marker };
                break;
            }
        }

        // 2. Paradigm (oop, functional): only when the declarations clearly lean one way.
        const paradigm = detectParadigm(contents);
        const template = paradigm && PARADIGM_TEMPLATES.find(t => t.name === paradigm.name);
        if (paradigm && template) {
            config = this.mergeConfig(config, template.config);
            matches.paradigm = paradigm;
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

    private async findFirstMarker(cwd: string, markers: string[], dependencies: Set<string>, contents: string[]): Promise<string | null> {
        const keywords: string[] = [];
        for (const marker of markers) {
            if (PACKAGE_MARKERS.has(marker)) {
                if (declaresPackage(dependencies, marker)) return `dependency:${marker}`;
            } else if (EXTENSION_MARKERS.has(marker)) {
                if (await hasFileWithExtension(cwd, marker)) return `file:*.${marker}`;
            } else if (await fs.pathExists(path.join(cwd, marker))) {
                return marker;
            } else if (!isPathMarker(marker) && this.recurs(contents, marker)) {
                keywords.push(marker);
            }
        }
        return keywords.length >= MIN_KEYWORDS ? `content:${keywords.join(',')}` : null;
    }

    private recurs(contents: string[], keyword: string): boolean {
        return contents.filter(text => containsToken(text, keyword)).length >= MIN_KEYWORD_FILES;
    }
}
