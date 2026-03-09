/**
 * Language Adapter Registry
 *
 * Single source of truth for language detection and adapter resolution.
 * Gates call `registry.getAdapter(filePath)` instead of branching on extensions.
 */

import path from 'path';
import type { LanguageAdapter } from './types.js';
import { jsAdapter } from './js-adapter.js';
import { pythonAdapter } from './python-adapter.js';
import { goAdapter } from './go-adapter.js';
import { rubyAdapter } from './ruby-adapter.js';
import { rustAdapter } from './rust-adapter.js';
import { csharpAdapter } from './csharp-adapter.js';
import { javaAdapter } from './java-adapter.js';

const ALL_ADAPTERS: LanguageAdapter[] = [
    jsAdapter,
    pythonAdapter,
    goAdapter,
    rubyAdapter,
    rustAdapter,
    csharpAdapter,
    javaAdapter,
];

export class LanguageAdapterRegistry {
    private extensionMap: Map<string, LanguageAdapter> = new Map();
    private adapters: LanguageAdapter[];

    constructor(adapters: LanguageAdapter[] = ALL_ADAPTERS) {
        this.adapters = adapters;
        for (const adapter of adapters) {
            for (const ext of adapter.extensions) {
                this.extensionMap.set(ext.toLowerCase(), adapter);
            }
        }
    }

    /** Auto-detect language from file extension and return the appropriate adapter */
    getAdapter(filePath: string): LanguageAdapter | null {
        const ext = path.extname(filePath).toLowerCase();
        return this.extensionMap.get(ext) ?? null;
    }

    /** Check if a file extension is supported */
    isSupported(filePath: string): boolean {
        return this.getAdapter(filePath) !== null;
    }

    /** Get all registered language IDs */
    getSupportedLanguages(): string[] {
        return this.adapters.map(a => a.id);
    }

    /** Get all registered adapters */
    getAllAdapters(): LanguageAdapter[] {
        return [...this.adapters];
    }

    /** Get scan glob patterns that cover all registered languages */
    getScanPatterns(): string[] {
        const allExts = this.adapters
            .flatMap(a => a.extensions)
            .map(e => e.replace('.', ''));
        return [`**/*.{${allExts.join(',')}}`];
    }

    /** Get all supported file extensions */
    getSupportedExtensions(): string[] {
        return [...this.extensionMap.keys()];
    }
}

/** Singleton registry instance — import this in gates */
export const languageAdapters = new LanguageAdapterRegistry();
