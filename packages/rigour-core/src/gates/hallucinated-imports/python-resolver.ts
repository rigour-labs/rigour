/**
 * Python import resolution for hallucinated-imports gate.
 *
 * Handles Python-specific import validation including:
 * - Relative imports (PEP 328)
 * - Local module discovery across source roots
 * - Installed package detection from pyproject.toml, setup.py, requirements.txt, etc.
 * - Namespace packages (PEP 420)
 */

import fs from 'fs-extra';
import path from 'path';
import { HallucinatedImport } from './index.js';
import { isPythonStdlib } from '../hallucinated-imports-stdlib.js';

/**
 * Check Python imports in a source file and add hallucinated findings.
 */
export async function checkPyImports(
    content: string,
    file: string,
    cwd: string,
    projectFiles: Set<string>,
    hallucinated: HallucinatedImport[]
): Promise<void> {
    const lines = content.split('\n');
    const pySourceRoots = await findPythonSourceRoots(cwd, projectFiles);
    const pyInstalledPkgs = await loadPythonInstalledPackages(cwd, projectFiles);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        const fromMatch = line.match(/^from\s+([\w.]+)\s+import/);
        const importMatch = line.match(/^import\s+([\w.]+)/);

        const modulePath = fromMatch?.[1] || importMatch?.[1];
        if (!modulePath) continue;

        if (isPythonStdlib(modulePath)) continue;

        if (modulePath.startsWith('.')) {
            const dotMatch = modulePath.match(/^(\.+)/);
            const dotCount = dotMatch ? dotMatch[1].length : 0;
            const moduleRest = modulePath.slice(dotCount);

            let baseDir = path.dirname(file);
            for (let level = 1; level < dotCount; level++) {
                const parent = path.dirname(baseDir);
                if (parent === baseDir) break;
                baseDir = parent;
            }

            if (!moduleRest) continue;

            const moduleParts = moduleRest.replace(/\./g, '/');
            const candidateBase = path.join(baseDir, moduleParts).replace(/\\/g, '/');

            const candidates = [
                candidateBase + '.py',
                candidateBase + '/__init__.py',
            ];

            const isNamespacePackage = [...projectFiles].some(f =>
                f.startsWith(candidateBase + '/') && f.endsWith('.py')
            );

            if (!candidates.some(c => projectFiles.has(c)) && !isNamespacePackage) {
                hallucinated.push({
                    file, line: i + 1, importPath: modulePath, type: 'python',
                    reason: `Relative module '${modulePath}' not found in project`,
                });
            }
        } else {
            const topLevel = modulePath.split('.')[0];

            if (pyInstalledPkgs.has(topLevel) || pyInstalledPkgs.has(topLevel.replace(/_/g, '-'))) {
                continue;
            }

            let foundLocal = false;
            const searchRoots = ['', ...pySourceRoots];

            for (const root of searchRoots) {
                const prefix = root ? root + '/' : '';
                const pyFile = prefix + topLevel + '.py';
                const pyInit = prefix + topLevel + '/__init__.py';
                const dirPrefix = prefix + topLevel + '/';

                const isLocalModule = projectFiles.has(pyFile) || projectFiles.has(pyInit) ||
                    [...projectFiles].some(f => f.startsWith(dirPrefix) && f.endsWith('.py'));

                if (!isLocalModule) continue;
                foundLocal = true;

                const fullModulePath = prefix + modulePath.replace(/\./g, '/');
                const candidates = [
                    fullModulePath + '.py',
                    fullModulePath + '/__init__.py',
                ];
                const exists = candidates.some(c => projectFiles.has(c));
                if (exists) break;

                if (modulePath.includes('.')) {
                    hallucinated.push({
                        file, line: i + 1, importPath: modulePath, type: 'python',
                        reason: `Module '${modulePath}' partially resolves but target not found`,
                    });
                }
                break;
            }
        }
    }
}

/**
 * Find Python source roots by discovering manifests and scanning directory structure.
 * Returns array of relative paths that are on sys.path.
 */
export async function findPythonSourceRoots(cwd: string, projectFiles: Set<string>): Promise<string[]> {
    const roots = new Set<string>();

    const pyprojectFiles = [...projectFiles].filter(
        f => f.endsWith('pyproject.toml') || f.endsWith('/pyproject.toml')
    );

    for (const pf of pyprojectFiles) {
        const pfDir = path.dirname(pf);
        const pfPrefix = pfDir === '.' ? '' : pfDir + '/';

        try {
            const content = await fs.readFile(path.join(cwd, pf), 'utf-8');

            const whereMatch = content.match(/where\s*=\s*\[\s*"([^"]+)"\s*\]/);
            if (whereMatch) {
                roots.add(pfPrefix + whereMatch[1]);
            }

            const pkgDirMatch = content.match(/package-dir\s*=\s*\{[^}]*""\s*:\s*"([^"]+)"/);
            if (pkgDirMatch) {
                roots.add(pfPrefix + pkgDirMatch[1]);
            }

            const poetryFromMatch = content.match(/from\s*=\s*"([^"]+)"/g);
            if (poetryFromMatch) {
                for (const m of poetryFromMatch) {
                    const fromDir = m.match(/"([^"]+)"/)?.[1];
                    if (fromDir) roots.add(pfPrefix + fromDir);
                }
            }

            if (/src_layout\s*=\s*true/i.test(content)) {
                roots.add(pfPrefix + 'src');
            }
        } catch { /* skip */ }
    }

    const setupPyFiles = [...projectFiles].filter(
        f => f === 'setup.py' || f.endsWith('/setup.py')
    );
    for (const sf of setupPyFiles) {
        const sfDir = path.dirname(sf);
        const sfPrefix = sfDir === '.' ? '' : sfDir + '/';
        try {
            const content = await fs.readFile(path.join(cwd, sf), 'utf-8');
            const pkgDirMatch = content.match(/package_dir\s*=\s*\{[^}]*['"]{2}\s*:\s*['"]([^'"]+)['"]/);
            if (pkgDirMatch) {
                roots.add(sfPrefix + pkgDirMatch[1]);
            }
        } catch { /* skip */ }
    }

    const setupCfgFiles = [...projectFiles].filter(
        f => f === 'setup.cfg' || f.endsWith('/setup.cfg')
    );
    for (const cf of setupCfgFiles) {
        const cfDir = path.dirname(cf);
        const cfPrefix = cfDir === '.' ? '' : cfDir + '/';
        try {
            const content = await fs.readFile(path.join(cwd, cf), 'utf-8');
            const pkgDirMatch = content.match(/package_dir\s*=\s*=\s*(\S+)/);
            if (pkgDirMatch) {
                roots.add(cfPrefix + pkgDirMatch[1]);
            }
        } catch { /* skip */ }
    }

    const pyFiles = [...projectFiles].filter(f => f.endsWith('.py'));
    const dirsWithPy = new Set<string>();
    for (const f of pyFiles) {
        const parts = f.split('/');
        for (let i = 0; i < parts.length - 1; i++) {
            dirsWithPy.add(parts.slice(0, i + 1).join('/'));
        }
    }

    for (const dir of dirsWithPy) {
        const baseName = path.basename(dir);
        if (['src', 'lib', 'app'].includes(baseName)) {
            roots.add(dir);
        }
    }

    return [...roots];
}

/**
 * Load installed Python package names from all manifest files in the project.
 * Discovers pyproject.toml, setup.py, setup.cfg, requirements*.txt, Pipfile.
 */
export async function loadPythonInstalledPackages(cwd: string, projectFiles?: Set<string>): Promise<Set<string>> {
    const packages = new Set<string>();

    const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

    const addPkg = (name: string) => {
        if (!name || name === 'dependencies') return;
        packages.add(normalize(name));
        packages.add(name.replace(/-/g, '_').toLowerCase());
    };

    const extractPyprojectDeps = (content: string) => {
        const depsMatch = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/g);
        if (depsMatch) {
            for (const block of depsMatch) {
                const pkgs = block.match(/"([^">=<!\s\[]+)/g);
                if (pkgs) {
                    for (const pkg of pkgs) {
                        addPkg(pkg.replace(/^"/, '').split(/[>=<!\[]/)[0].trim());
                    }
                }
            }
        }
        const optDepsMatch = content.match(/optional-dependencies\s*\]([\s\S]*?)(?:\n\[|\n$)/g);
        if (optDepsMatch) {
            for (const block of optDepsMatch) {
                const pkgs = block.match(/"([^">=<!\s\[]+)/g);
                if (pkgs) {
                    for (const pkg of pkgs) {
                        addPkg(pkg.replace(/^"/, '').split(/[>=<!\[]/)[0].trim());
                    }
                }
            }
        }
        const poetryMatch = content.match(/\[tool\.poetry\.(?:dev-)?dependencies\]([\s\S]*?)(?:\n\[|$)/g);
        if (poetryMatch) {
            for (const block of poetryMatch) {
                const pkgs = block.match(/^(\w[\w.-]*)\s*=/gm);
                if (pkgs) {
                    for (const pkg of pkgs) {
                        const name = pkg.replace(/\s*=.*/, '').trim();
                        if (name !== 'python') addPkg(name);
                    }
                }
            }
        }
    };

    const extractRequirementsDeps = (content: string) => {
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
            const name = trimmed.split(/[>=<!\[;@\s]/)[0].trim();
            if (name) addPkg(name);
        }
    };

    const allFiles = projectFiles ? [...projectFiles] : [];
    const pyprojectPaths = allFiles.filter(f => f.endsWith('pyproject.toml'));

    const rootPyprojectPath = path.join(cwd, 'pyproject.toml');
    if (await fs.pathExists(rootPyprojectPath)) {
        try {
            extractPyprojectDeps(await fs.readFile(rootPyprojectPath, 'utf-8'));
        } catch { /* skip */ }
    }

    for (const pf of pyprojectPaths) {
        if (pf === 'pyproject.toml') continue;
        try {
            extractPyprojectDeps(await fs.readFile(path.join(cwd, pf), 'utf-8'));
        } catch { /* skip */ }
    }

    const setupPyPaths = allFiles.filter(f => f.endsWith('setup.py'));
    for (const sf of setupPyPaths) {
        try {
            const content = await fs.readFile(path.join(cwd, sf), 'utf-8');
            const reqMatch = content.match(/install_requires\s*=\s*\[([\s\S]*?)\]/);
            if (reqMatch) {
                const pkgs = reqMatch[1].match(/['"]([^'">=<!\s\[]+)/g);
                if (pkgs) {
                    for (const pkg of pkgs) {
                        addPkg(pkg.replace(/^['"]/, '').split(/[>=<!\[]/)[0].trim());
                    }
                }
            }
        } catch { /* skip */ }
    }

    const reqPaths = allFiles.filter(f =>
        /(?:^|\/)requirements[^/]*\.txt$/.test(f)
    );
    for (const reqFile of ['requirements.txt', 'requirements-dev.txt', 'requirements_dev.txt', 'requirements-test.txt']) {
        const reqPath = path.join(cwd, reqFile);
        if (await fs.pathExists(reqPath)) {
            try {
                extractRequirementsDeps(await fs.readFile(reqPath, 'utf-8'));
            } catch { /* skip */ }
        }
    }
    for (const rf of reqPaths) {
        try {
            extractRequirementsDeps(await fs.readFile(path.join(cwd, rf), 'utf-8'));
        } catch { /* skip */ }
    }

    const pipfilePaths = allFiles.filter(f => f.endsWith('Pipfile'));
    for (const pf of pipfilePaths) {
        try {
            const content = await fs.readFile(path.join(cwd, pf), 'utf-8');
            const pkgs = content.match(/^(\w[\w.-]*)\s*=/gm);
            if (pkgs) {
                for (const pkg of pkgs) {
                    const name = pkg.replace(/\s*=.*/, '').trim();
                    if (!['python_version', 'python_full_version', 'name', 'url', 'verify_ssl'].includes(name)) {
                        addPkg(name);
                    }
                }
            }
        } catch { /* skip */ }
    }

    const eggInfoDirs = allFiles.filter(f =>
        (f.includes('.egg-info/') || f.includes('.dist-info/')) && f.endsWith('top_level.txt')
    );
    for (const ei of eggInfoDirs) {
        try {
            const content = await fs.readFile(path.join(cwd, ei), 'utf-8');
            for (const line of content.split('\n')) {
                const name = line.trim();
                if (name) addPkg(name);
            }
        } catch { /* skip */ }
    }

    return packages;
}
