/**
 * Language-specific import checkers and dependency loaders for hallucinated-imports gate.
 * Go, Ruby, C#, Rust, Java/Kotlin parsers extracted to keep main gate file under 500 lines.
 */

import fs from 'fs-extra';
import path from 'path';
import { HallucinatedImport } from './hallucinated-imports/index.js';
import { isGoStdlib, isRubyStdlib, isDotNetFramework, isRustStdCrate, isJavaStdlib, isKotlinStdlib } from './hallucinated-imports-stdlib.js';

export function checkGoImports(
    content: string, file: string, cwd: string,
    projectFiles: Set<string>, hallucinated: HallucinatedImport[]
): void {
    const lines = content.split('\n');
    let inImportBlock = false;

    // Find go.mod by walking up from the Go file's directory (monorepo support).
    let modulePath: string | null = null;
    const replaceModules = new Set<string>(); // Modules with local replace directives
    const fileAbsDir = path.dirname(path.resolve(cwd, file));
    const rootDir = path.resolve(cwd);
    let searchDir = fileAbsDir;

    while (searchDir.startsWith(rootDir) || searchDir === rootDir) {
        const goModPath = path.join(searchDir, 'go.mod');
        try {
            if (fs.pathExistsSync(goModPath)) {
                const goMod = fs.readFileSync(goModPath, 'utf-8');
                const moduleMatch = goMod.match(/^module\s+(\S+)/m);
                if (moduleMatch) { modulePath = moduleMatch[1]; }

                // Parse replace directives: replace github.com/foo/bar => ../local-bar
                // These modules are valid even without being in go.sum
                const replacePattern = /^replace\s+(\S+)\s+=>\s+/gm;
                let rm;
                while ((rm = replacePattern.exec(goMod)) !== null) {
                    replaceModules.add(rm[1]);
                }
                // Also handle replace blocks: replace ( ... )
                const replaceBlockMatch = goMod.match(/^replace\s*\(([\s\S]*?)\)/m);
                if (replaceBlockMatch) {
                    const blockLines = replaceBlockMatch[1].split('\n');
                    for (const bl of blockLines) {
                        const blMatch = bl.trim().match(/^(\S+)\s+=>/);
                        if (blMatch) replaceModules.add(blMatch[1]);
                    }
                }

                if (modulePath) break;
            }
        } catch { /* skip */ }
        const parent = path.dirname(searchDir);
        if (parent === searchDir) break;
        searchDir = parent;
    }

    // Check for go.work file (Go workspace mode)
    const goWorkModules = new Set<string>();
    try {
        const goWorkPath = path.join(rootDir, 'go.work');
        if (fs.pathExistsSync(goWorkPath)) {
            const goWork = fs.readFileSync(goWorkPath, 'utf-8');
            // use directives: use ./service-a or use ( ./service-a ./service-b )
            const usePattern = /use\s+(\.\S+)/g;
            let um;
            while ((um = usePattern.exec(goWork)) !== null) {
                // Read go.mod from each workspace member
                const memberModPath = path.join(rootDir, um[1], 'go.mod');
                if (fs.pathExistsSync(memberModPath)) {
                    const memberMod = fs.readFileSync(memberModPath, 'utf-8');
                    const memberModMatch = memberMod.match(/^module\s+(\S+)/m);
                    if (memberModMatch) goWorkModules.add(memberModMatch[1]);
                }
            }
        }
    } catch { /* skip */ }

    // Check for vendor/ directory — if it exists, all vendored modules are valid
    const hasVendor = fs.pathExistsSync(path.join(rootDir, 'vendor'));

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Detect import block: import ( ... )
        if (/^import\s*\(/.test(line)) { inImportBlock = true; continue; }
        if (inImportBlock && line === ')') { inImportBlock = false; continue; }

        // Single import: import "path"  or  import alias "path"
        const singleMatch = line.match(/^import\s+(?:\w+\s+)?"([^"]+)"/);
        const blockMatch = inImportBlock ? line.match(/^\s*(?:\w+\s+)?"([^"]+)"/) : null;
        const importPath = singleMatch?.[1] || blockMatch?.[1];
        if (!importPath) continue;

        // 1. Skip Go standard library — comprehensive list
        if (isGoStdlib(importPath)) continue;

        // 2. If we have a module path, check project-relative imports FIRST
        if (modulePath && importPath.startsWith(modulePath + '/')) {
            const relPath = importPath.slice(modulePath.length + 1);
            const hasMatchingFile = [...projectFiles].some(f =>
                f.endsWith('.go') && f.startsWith(relPath)
            );
            if (!hasMatchingFile) {
                hallucinated.push({
                    file, line: i + 1, importPath, type: 'go',
                    reason: `Go import '${importPath}' — package directory '${relPath}' not found in project`,
                });
            }
            continue;
        }

        // 2b. Check if import matches a go.work workspace member module
        let matchesWorkspace = false;
        for (const wm of goWorkModules) {
            if (importPath === wm || importPath.startsWith(wm + '/')) {
                matchesWorkspace = true;
                break;
            }
        }
        if (matchesWorkspace) continue;

        // 2c. Check if import matches a replace directive (local replacement)
        let matchesReplace = false;
        for (const rm of replaceModules) {
            if (importPath === rm || importPath.startsWith(rm + '/')) {
                matchesReplace = true;
                break;
            }
        }
        if (matchesReplace) continue;

        // 2d. If vendor/ exists, all external imports are valid (vendored)
        if (hasVendor && importPath.includes('.')) continue;

        // 3. Skip external modules — any import containing a dot is a domain
        //    e.g. github.com/*, google.golang.org/*, go.uber.org/*
        if (importPath.includes('.')) continue;

        // 4. No dots, no go.mod match, not stdlib → likely an internal package
        //    without go.mod context we can't verify, so skip to avoid false positives
    }
}

export function checkRubyImports(
    content: string, file: string, cwd: string,
    projectFiles: Set<string>, hallucinated: HallucinatedImport[]
): void {
    const lines = content.split('\n');

    // Parse Gemfile for known gem dependencies
    const gemDeps = loadRubyGems(cwd);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Skip comments
        if (line.startsWith('#')) continue;

        // require_relative 'path' — must resolve to a real file
        const relMatch = line.match(/require_relative\s+['"]([^'"]+)['"]/);
        if (relMatch) {
            const reqPath = relMatch[1];
            const dir = path.dirname(file);
            const resolved = path.join(dir, reqPath).replace(/\\/g, '/');
            const candidates = [resolved + '.rb', resolved];
            if (!candidates.some(c => projectFiles.has(c))) {
                hallucinated.push({
                    file, line: i + 1, importPath: reqPath, type: 'ruby',
                    reason: `require_relative '${reqPath}' — file not found in project`,
                });
            }
            continue;
        }

        // require 'something' — check stdlib, gems, then local
        const reqMatch = line.match(/^require\s+['"]([^'"]+)['"]/);
        if (reqMatch) {
            const reqPath = reqMatch[1];

            // Skip Ruby stdlib
            if (isRubyStdlib(reqPath)) continue;

            // Skip gems listed in Gemfile
            const gemName = reqPath.split('/')[0];
            if (gemDeps.has(gemName)) continue;

            // Check if it resolves to a project file
            const candidates = [
                reqPath + '.rb',
                reqPath,
                'lib/' + reqPath + '.rb',
                'lib/' + reqPath,
            ];
            const found = candidates.some(c => projectFiles.has(c));
            if (!found) {
                // If we have a Gemfile and it's not in it, it might be hallucinated
                if (gemDeps.size > 0) {
                    hallucinated.push({
                        file, line: i + 1, importPath: reqPath, type: 'ruby',
                        reason: `require '${reqPath}' — not in stdlib, Gemfile, or project files`,
                    });
                }
            }
        }
    }
}

export function loadRubyGems(cwd: string, projectFiles?: Set<string>): Set<string> {
    const gems = new Set<string>();

    const parseGemfile = (filePath: string) => {
        try {
            if (!fs.pathExistsSync(filePath)) return;
            const content = fs.readFileSync(filePath, 'utf-8');
            const gemPattern = /gem\s+['"]([^'"]+)['"]/g;
            let m;
            while ((m = gemPattern.exec(content)) !== null) {
                gems.add(m[1]);
            }
        } catch { /* skip */ }
    };

    const parseGemspec = (filePath: string) => {
        try {
            if (!fs.pathExistsSync(filePath)) return;
            const spec = fs.readFileSync(filePath, 'utf-8');
            // add_runtime_dependency, add_dependency, add_development_dependency
            const depPattern = /add_(?:runtime_|development_)?dependency\s+['"]([^'"]+)['"]/g;
            let dm;
            while ((dm = depPattern.exec(spec)) !== null) {
                gems.add(dm[1]);
            }
        } catch { /* skip */ }
    };

    // Parse root Gemfile
    parseGemfile(path.join(cwd, 'Gemfile'));

    // Discover ALL Gemfiles and .gemspec files in the project (monorepo support)
    if (projectFiles) {
        for (const f of projectFiles) {
            if (f.endsWith('Gemfile') || f.endsWith('/Gemfile')) {
                parseGemfile(path.join(cwd, f));
            }
            if (f.endsWith('.gemspec')) {
                parseGemspec(path.join(cwd, f));
            }
        }
    } else {
        // Fallback: check root directory only
        try {
            const files = fs.readdirSync?.(cwd) || [];
            for (const f of files) {
                if (typeof f === 'string' && f.endsWith('.gemspec')) {
                    parseGemspec(path.join(cwd, f));
                }
            }
        } catch { /* skip */ }
    }

    return gems;
}

export function checkCSharpImports(
    content: string, file: string, cwd: string,
    projectFiles: Set<string>, hallucinated: HallucinatedImport[]
): void {
    const lines = content.split('\n');
    // Search for .csproj in file's directory and parent dirs (monorepo support)
    const nugetPackages = loadNuGetPackagesForFile(file, cwd);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Match: using Namespace; and using static Namespace.Class;
        // Skip: using alias = Namespace; and using (var x = ...) disposable
        const usingMatch = line.match(/^using\s+(?:static\s+)?([\w.]+)\s*;/);
        if (!usingMatch) continue;

        const namespace = usingMatch[1];

        // 1. Skip .NET framework and BCL namespaces
        if (isDotNetFramework(namespace)) continue;

        // 2. Skip NuGet packages from .csproj
        const topLevel = namespace.split('.')[0];
        if (nugetPackages.has(topLevel) || nugetPackages.has(namespace.split('.').slice(0, 2).join('.'))) continue;

        // 3. Check if the namespace maps to any .cs file in the project
        //    C# namespaces often have a root prefix (project name) not in the directory tree
        //    e.g. MyProject.Services.UserService → check Services/UserService AND MyProject/Services/UserService
        const nsParts = namespace.split('.');
        const nsPath = namespace.replace(/\./g, '/');
        // Also check without root prefix (common convention: namespace root != directory root)
        const nsPathNoRoot = nsParts.slice(1).join('/');

        const csFiles = [...projectFiles].filter(f => f.endsWith('.cs'));
        const hasMatch = csFiles.some(f =>
            f.includes(nsPath) || (nsPathNoRoot && f.includes(nsPathNoRoot))
        );

        // Only flag if we have .csproj context (proves this is a real .NET project)
        if (!hasMatch && namespace.includes('.') && nugetPackages.size >= 0) {
            // Check if we actually have .csproj context (a real .NET project)
            const hasCsproj = nugetPackages.size > 0 || hasCsprojFile(cwd);
            if (hasCsproj) {
                hallucinated.push({
                    file, line: i + 1, importPath: namespace, type: 'csharp',
                    reason: `Namespace '${namespace}' — no matching files in project, not in NuGet packages`,
                });
            }
        }
    }
}

export function hasCsprojFile(cwd: string): boolean {
    try {
        const files = fs.readdirSync?.(cwd) || [];
        return files.some((f: any) => typeof f === 'string' && f.endsWith('.csproj'));
    } catch { return false; }
}

export function loadNuGetPackages(cwd: string): Set<string> {
    const packages = new Set<string>();
    try {
        const files = fs.readdirSync?.(cwd) || [];
        for (const f of files) {
            if (typeof f === 'string' && f.endsWith('.csproj')) {
                try {
                    const content = fs.readFileSync(path.join(cwd, f), 'utf-8');

                    // PackageReference — NuGet packages
                    const pkgPattern = /PackageReference\s+Include="([^"]+)"/g;
                    let m;
                    while ((m = pkgPattern.exec(content)) !== null) {
                        packages.add(m[1]);
                        packages.add(m[1].split('.')[0]);
                    }

                    // ProjectReference — sibling projects (their namespaces become valid)
                    const projRefPattern = /ProjectReference\s+Include="([^"]+)"/g;
                    let pr;
                    while ((pr = projRefPattern.exec(content)) !== null) {
                        // Extract project name from path: "../MyLib/MyLib.csproj" → "MyLib"
                        const projName = path.basename(pr[1], '.csproj');
                        packages.add(projName);
                    }

                    // RootNamespace — project's own root namespace
                    const nsMatch = content.match(/<RootNamespace>([^<]+)<\/RootNamespace>/);
                    if (nsMatch) {
                        packages.add(nsMatch[1]);
                        packages.add(nsMatch[1].split('.')[0]);
                    }
                } catch { /* skip */ }
            }

            // Legacy packages.config format
            if (typeof f === 'string' && f === 'packages.config') {
                try {
                    const content = fs.readFileSync(path.join(cwd, f), 'utf-8');
                    const pkgPattern = /id="([^"]+)"/g;
                    let m;
                    while ((m = pkgPattern.exec(content)) !== null) {
                        packages.add(m[1]);
                        packages.add(m[1].split('.')[0]);
                    }
                } catch { /* skip */ }
            }
        }

        // Check Directory.Build.props for shared package references
        const buildPropsPath = path.join(cwd, 'Directory.Build.props');
        if (fs.pathExistsSync(buildPropsPath)) {
            try {
                const content = fs.readFileSync(buildPropsPath, 'utf-8');
                const pkgPattern = /PackageReference\s+Include="([^"]+)"/g;
                let m;
                while ((m = pkgPattern.exec(content)) !== null) {
                    packages.add(m[1]);
                    packages.add(m[1].split('.')[0]);
                }
            } catch { /* skip */ }
        }
    } catch { /* no .csproj */ }
    return packages;
}

/**
 * Search for .csproj files by walking up from the C# file's directory.
 * Monorepo support: a C# file in tests/csharp/MyProject/ needs to find .csproj
 * in that directory, not just the project root.
 */
export function loadNuGetPackagesForFile(file: string, cwd: string): Set<string> {
    const allPackages = new Set<string>();
    const rootDir = path.resolve(cwd);
    let searchDir = path.dirname(path.resolve(cwd, file));

    while (searchDir.startsWith(rootDir) || searchDir === rootDir) {
        const pkgs = loadNuGetPackages(searchDir);
        for (const p of pkgs) allPackages.add(p);

        const parent = path.dirname(searchDir);
        if (parent === searchDir) break;
        searchDir = parent;
    }
    return allPackages;
}

export function checkRustImports(
    content: string, file: string, cwd: string,
    projectFiles: Set<string>, hallucinated: HallucinatedImport[]
): void {
    const lines = content.split('\n');
    const cargoDeps = loadCargoDeps(cwd);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('//') || line.startsWith('/*')) continue;

        // extern crate foo;
        const externMatch = line.match(/^extern\s+crate\s+(\w+)/);
        if (externMatch) {
            const crateName = externMatch[1];
            if (isRustStdCrate(crateName)) continue;
            if (cargoDeps.has(crateName)) continue;
            hallucinated.push({
                file, line: i + 1, importPath: crateName, type: 'rust',
                reason: `extern crate '${crateName}' — not in Cargo.toml or Rust std`,
            });
            continue;
        }

        // use foo::bar::baz;  or  use foo::{bar, baz};
        const useMatch = line.match(/^(?:pub\s+)?use\s+(\w+)::/);
        if (useMatch) {
            const crateName = useMatch[1];
            if (isRustStdCrate(crateName)) continue;
            if (cargoDeps.has(crateName)) continue;
            // 'crate' and 'self' and 'super' are Rust path keywords
            if (['crate', 'self', 'super'].includes(crateName)) continue;
            hallucinated.push({
                file, line: i + 1, importPath: crateName, type: 'rust',
                reason: `use ${crateName}:: — crate not in Cargo.toml or Rust std`,
            });
        }
    }
}

export function loadCargoDeps(cwd: string): Set<string> {
    const deps = new Set<string>();

    const parseCargoToml = (filePath: string) => {
        try {
            if (!fs.pathExistsSync(filePath)) return;
            const content = fs.readFileSync(filePath, 'utf-8');

            // Parse ALL dependency sections: [dependencies], [dev-dependencies], [build-dependencies]
            // Also handle [target.'cfg(...)'.dependencies]
            let inDeps = false;
            for (const line of content.split('\n')) {
                const trimmed = line.trim();
                // Match any dependencies section header
                if (/^\[(?:(?:dev|build)-)?dependencies(?:\.]|\])/.test(trimmed) ||
                    /^\[target\.[^\]]*\.(?:(?:dev|build)-)?dependencies\]/.test(trimmed) ||
                    /^\[workspace\.dependencies\]/.test(trimmed)) {
                    inDeps = true; continue;
                }
                if (/^\[/.test(trimmed) && inDeps) { inDeps = false; continue; }
                if (inDeps) {
                    const m = trimmed.match(/^([\w][\w-]*)\s*=/);
                    if (m) deps.add(m[1].replace(/-/g, '_')); // Rust uses _ in code for - in Cargo
                }
            }

            // Handle [dependencies.foo] format (inline table)
            const inlineDepPattern = /^\[(?:(?:dev|build)-)?dependencies\.([\w][\w-]*)\]/gm;
            let dm;
            while ((dm = inlineDepPattern.exec(content)) !== null) {
                deps.add(dm[1].replace(/-/g, '_'));
            }

            // Handle [features] section — optional deps are valid when feature is enabled
            let inFeatures = false;
            for (const line of content.split('\n')) {
                const trimmed = line.trim();
                if (trimmed === '[features]') { inFeatures = true; continue; }
                if (/^\[/.test(trimmed) && inFeatures) { inFeatures = false; continue; }
                if (inFeatures) {
                    // Features reference dep names: feature = ["dep:foo", "bar/feature"]
                    const depRefs = trimmed.match(/"dep:(\w[\w-]*)"/g);
                    if (depRefs) {
                        for (const ref of depRefs) {
                            const name = ref.match(/"dep:(\w[\w-]*)"/)?.[1];
                            if (name) deps.add(name.replace(/-/g, '_'));
                        }
                    }
                }
            }
        } catch { /* skip */ }
    };

    // Parse the Cargo.toml in the working directory
    parseCargoToml(path.join(cwd, 'Cargo.toml'));

    // Walk up to find workspace Cargo.toml
    let searchDir = cwd;
    const rootDir = path.parse(cwd).root;
    while (searchDir !== rootDir) {
        const parentCargoPath = path.join(searchDir, 'Cargo.toml');
        if (fs.pathExistsSync(parentCargoPath)) {
            const content = fs.readFileSync(parentCargoPath, 'utf-8');
            if (content.includes('[workspace]')) {
                parseCargoToml(parentCargoPath);
                break;
            }
        }
        const parent = path.dirname(searchDir);
        if (parent === searchDir) break;
        searchDir = parent;
    }

    return deps;
}

export function checkJavaKotlinImports(
    content: string, file: string, ext: string, cwd: string,
    projectFiles: Set<string>, hallucinated: HallucinatedImport[]
): void {
    const lines = content.split('\n');
    // Search for build.gradle/pom.xml by walking up from the file's directory (monorepo support)
    const buildDeps = loadJavaDepsForFile(file, cwd);
    const isKotlin = ext === '.kt';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // import com.example.package.Class
        const importMatch = line.match(/^import\s+(?:static\s+)?([\w.]+)/);
        if (!importMatch) continue;

        const importPath = importMatch[1];

        // Skip Java stdlib
        if (isJavaStdlib(importPath)) continue;

        // Skip Kotlin stdlib
        if (isKotlin && isKotlinStdlib(importPath)) continue;

        // Skip known build dependencies (by group prefix)
        const parts = importPath.split('.');
        const group2 = parts.slice(0, 2).join('.');
        const group3 = parts.slice(0, 3).join('.');
        if (buildDeps.has(group2) || buildDeps.has(group3)) continue;

        // Check if it resolves to a project file
        const javaPath = importPath.replace(/\./g, '/');
        const candidates = [
            javaPath + '.java',
            javaPath + '.kt',
            'src/main/java/' + javaPath + '.java',
            'src/main/kotlin/' + javaPath + '.kt',
        ];
        const found = candidates.some(c => projectFiles.has(c)) ||
            [...projectFiles].some(f => f.includes(javaPath));

        if (!found) {
            // Only flag if we have build deps context (Gradle/Maven project)
            if (buildDeps.size > 0) {
                hallucinated.push({
                    file, line: i + 1, importPath, type: isKotlin ? 'kotlin' : 'java',
                    reason: `import '${importPath}' — not in stdlib, build deps, or project files`,
                });
            }
        }
    }
}

export function loadJavaDeps(cwd: string): Set<string> {
    const deps = new Set<string>();
    try {
        // Gradle: build.gradle or build.gradle.kts
        for (const gradleFile of ['build.gradle', 'build.gradle.kts']) {
            const gradlePath = path.join(cwd, gradleFile);
            if (fs.pathExistsSync(gradlePath)) {
                const content = fs.readFileSync(gradlePath, 'utf-8');
                // Match: implementation 'group:artifact:version' or "group:artifact:version"
                const depPattern = /(?:implementation|api|compile|testImplementation|testCompile|runtimeOnly|compileOnly|annotationProcessor)\s*[('"]([^:'"]+)/g;
                let m;
                while ((m = depPattern.exec(content)) !== null) {
                    deps.add(m[1]); // group ID like "com.google.guava"
                }
                // Also match Kotlin DSL format: implementation("group:artifact:version")
                const kotlinDslPattern = /(?:implementation|api|testImplementation|runtimeOnly|compileOnly)\s*\(\s*"([^:"]+)/g;
                while ((m = kotlinDslPattern.exec(content)) !== null) {
                    deps.add(m[1]);
                }
            }
        }

        // Gradle settings.gradle(.kts) — find included modules
        for (const settingsFile of ['settings.gradle', 'settings.gradle.kts']) {
            const settingsPath = path.join(cwd, settingsFile);
            if (fs.pathExistsSync(settingsPath)) {
                try {
                    const content = fs.readFileSync(settingsPath, 'utf-8');
                    // include ':module-a', ':module-b'
                    const includePattern = /include\s*[('"]([^'"]+)/g;
                    let im;
                    while ((im = includePattern.exec(content)) !== null) {
                        const moduleName = im[1].replace(/^:/, '');
                        deps.add(moduleName);
                    }
                    // includeBuild('../composite-project')
                    const compositePat = /includeBuild\s*\(\s*['"]([^'"]+)/g;
                    while ((im = compositePat.exec(content)) !== null) {
                        // Read the included build's group
                        const compositePath = path.resolve(cwd, im[1], 'build.gradle');
                        if (fs.pathExistsSync(compositePath)) {
                            const compositeContent = fs.readFileSync(compositePath, 'utf-8');
                            const groupMatch = compositeContent.match(/group\s*=\s*['"]([^'"]+)/);
                            if (groupMatch) deps.add(groupMatch[1]);
                        }
                    }
                } catch { /* skip */ }
            }
        }

        // Maven: pom.xml
        const pomPath = path.join(cwd, 'pom.xml');
        if (fs.pathExistsSync(pomPath)) {
            const content = fs.readFileSync(pomPath, 'utf-8');
            const groupPattern = /<groupId>([^<]+)<\/groupId>/g;
            let m;
            while ((m = groupPattern.exec(content)) !== null) {
                deps.add(m[1]);
            }
            // Maven <modules> — multi-module projects
            const modulePattern = /<module>([^<]+)<\/module>/g;
            while ((m = modulePattern.exec(content)) !== null) {
                deps.add(m[1]);
                // Also load deps from submodule pom.xml
                const subPomPath = path.join(cwd, m[1], 'pom.xml');
                if (fs.pathExistsSync(subPomPath)) {
                    try {
                        const subContent = fs.readFileSync(subPomPath, 'utf-8');
                        const subGroupPattern = /<groupId>([^<]+)<\/groupId>/g;
                        let sm;
                        while ((sm = subGroupPattern.exec(subContent)) !== null) {
                            deps.add(sm[1]);
                        }
                    } catch { /* skip */ }
                }
            }
        }
    } catch { /* no build files */ }
    return deps;
}

/**
 * Search for build.gradle/pom.xml by walking up from the Java/Kotlin file's directory.
 * Monorepo support: a Java file in sdks/sandbox/java/ needs to find build.gradle there.
 */
export function loadJavaDepsForFile(file: string, cwd: string): Set<string> {
    const allDeps = new Set<string>();
    const rootDir = path.resolve(cwd);
    let searchDir = path.dirname(path.resolve(cwd, file));

    while (searchDir.startsWith(rootDir) || searchDir === rootDir) {
        const deps = loadJavaDeps(searchDir);
        for (const d of deps) allDeps.add(d);

        const parent = path.dirname(searchDir);
        if (parent === searchDir) break;
        searchDir = parent;
    }
    return allDeps;
}

export async function loadPackageJson(cwd: string): Promise<any> {
    try {
        const pkgPath = path.join(cwd, 'package.json');
        if (await fs.pathExists(pkgPath)) {
            return await fs.readJson(pkgPath);
        }
    } catch (e) { }
    return null;
}
