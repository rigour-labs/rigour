import fs from 'fs-extra';
import path from 'path';
import type { PatternIndex } from '../pattern-index/types.js';

export interface DependencyGraph {
    version: 1;
    generatedAt: string;
    nodes: string[];
    edges: Array<{ from: string; to: string }>;
}

const IMPORT_PATTERNS = [
    /(?:import|export)\s+(?:[^'"\n]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /from\s+([\w.]+)\s+import\s+/g,
];

function resolveImport(from: string, specifier: string, files: Set<string>): string | null {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
    const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.py`];
    for (const indexName of ['index.ts', 'index.tsx', 'index.js', 'index.jsx']) {
        candidates.push(path.posix.join(base, indexName));
    }
    return candidates.find((candidate) => files.has(candidate)) ?? null;
}

function importsFrom(content: string): string[] {
    const imports = new Set<string>();
    for (const pattern of IMPORT_PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) imports.add(match[1]);
    }
    return [...imports];
}

export async function buildDependencyGraph(cwd: string, index: PatternIndex): Promise<DependencyGraph> {
    const files = new Set(index.files.map((file) => file.path.split(path.sep).join('/')));
    const edges: DependencyGraph['edges'] = [];

    for (const from of files) {
        try {
            const content = await fs.readFile(path.join(cwd, from), 'utf8');
            for (const specifier of importsFrom(content)) {
                const to = resolveImport(from, specifier, files);
                if (to) edges.push({ from, to });
            }
        } catch {
            // A disappearing file is handled by the next incremental index update.
        }
    }

    const graph: DependencyGraph = {
        version: 1,
        generatedAt: new Date().toISOString(),
        nodes: [...files],
        edges,
    };
    const graphPath = path.join(cwd, '.rigour', 'dependency-graph.json');
    await fs.ensureDir(path.dirname(graphPath));
    await fs.writeJson(graphPath, graph, { spaces: 2 });
    return graph;
}

export async function updateDependencyGraph(
    cwd: string,
    index: PatternIndex,
    existing: DependencyGraph,
    changedFiles: string[],
): Promise<DependencyGraph> {
    const files = new Set(index.files.map(file => file.path.split(path.sep).join('/')));
    const root = path.resolve(cwd);
    const changed = new Set(changedFiles.flatMap(file => {
        const relative = path.relative(root, path.resolve(root, file));
        if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [];
        return [relative.split(path.sep).join('/')];
    }));
    const edges = existing.edges.filter(edge => !changed.has(edge.from) && files.has(edge.from) && files.has(edge.to));
    for (const from of changed) {
        if (!files.has(from)) continue;
        try {
            const content = await fs.readFile(path.join(cwd, from), 'utf8');
            for (const specifier of importsFrom(content)) {
                const to = resolveImport(from, specifier, files);
                if (to) edges.push({ from, to });
            }
        } catch {
            // Deleted files are removed from the node and edge sets.
        }
    }
    const graph: DependencyGraph = { version: 1, generatedAt: new Date().toISOString(), nodes: [...files], edges };
    await fs.writeJson(path.join(cwd, '.rigour', 'dependency-graph.json'), graph, { spaces: 2 });
    return graph;
}

export function affectedDependents(graph: DependencyGraph, changedFiles: string[]): string[] {
    const affected = new Set(changedFiles);
    let changed = true;
    while (changed) {
        changed = false;
        for (const edge of graph.edges) {
            if (affected.has(edge.to) && !affected.has(edge.from)) {
                affected.add(edge.from);
                changed = true;
            }
        }
    }
    return [...affected];
}
