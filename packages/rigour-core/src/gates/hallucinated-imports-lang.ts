/**
 * Language-specific import checkers and dependency loaders for hallucinated-imports gate.
 * Go, Ruby, C#, Rust, Java/Kotlin parsers extracted to keep main gate file under 500 lines.
 */

import fs from 'fs-extra';
import path from 'path';
import { HallucinatedImport } from './hallucinated-imports.js';
import { isGoStdlib, isRubyStdlib, isDotNetFramework, isRustStdCrate, isJavaStdlib, isKotlinStdlib } from './hallucinated-imports-stdlib.js';

export function checkGoImports(
    content: string, file: string, cwd: string,
    projectFiles: Set<string>, hallucinated: HallucinatedImport[]
): void {
    const lines = content.split('\n');
    let inImportBlock = false;

    // Try to read go.mod for the module path
    const goModPath = path.join(cwd, 'go.mod');
    let modulePath: string | null = null;
    try {
        if (fs.pathExistsSync(goModPath)) {
            const goMod = fs.readFileSync(goModPath, 'utf-8');
            const moduleMatch = goMod.match(/^module\s+(\S+)/m);
            if (moduleMatch) modulePath = moduleMatch[1];
        }
    } catch { /* no go.mod — skip project-relative checks entirely */ }

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
        //    (project imports like github.com/myorg/project/pkg also have dots)
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

export function loadRubyGems(cwd: string): Set<string> {
    const gems = new Set<string>();
    try {
        const gemfilePath = path.join(cwd, 'Gemfile');
        if (fs.pathExistsSync(gemfilePath)) {
            const content = fs.readFileSync(gemfilePath, 'utf-8');
            const gemPattern = /gem\s+['"]([^'"]+)['"]/g;
            let m;
            while ((m = gemPattern.exec(content)) !== null) {
                gems.add(m[1]);
            }
        }
        // Also check .gemspec
        const gemspecs = [...new Set<string>()]; // placeholder
        const files = fs.readdirSync?.(cwd) || [];
        for (const f of files) {
            if (typeof f === 'string' && f.endsWith('.gemspec')) {
                try {
                    const spec = fs.readFileSync(path.join(cwd, f), 'utf-8');
                    const depPattern = /add_(?:runtime_)?dependency\s+['"]([^'"]+)['"]/g;
                    let dm;
                    while ((dm = depPattern.exec(spec)) !== null) {
                        gems.add(dm[1]);
                    }
                } catch { /* skip */ }
            }
        }
    } catch { /* no Gemfile */ }
    return gems;
}

export function checkCSharpImports(
    content: string, file: string, cwd: string,
    projectFiles: Set<string>, hallucinated: HallucinatedImport[]
): void {
    const lines = content.split('\n');
    const nugetPackages = loadNuGetPackages(cwd);

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
            const hasCsproj = hasCsprojFile(cwd);
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
                    const pkgPattern = /PackageReference\s+Include="([^"]+)"/g;
                    let m;
                    while ((m = pkgPattern.exec(content)) !== null) {
                        packages.add(m[1]);
                        // Also add top-level namespace (e.g. Newtonsoft.Json → Newtonsoft)
                        packages.add(m[1].split('.')[0]);
                    }
                } catch { /* skip */ }
            }
        }
    } catch { /* no .csproj */ }
    return packages;
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
    try {
        const cargoPath = path.join(cwd, 'Cargo.toml');
        if (fs.pathExistsSync(cargoPath)) {
            const content = fs.readFileSync(cargoPath, 'utf-8');
            // Match [dependencies] section entries: name = "version" or name = { ... }
            const depPattern = /^\s*(\w[\w-]*)\s*=/gm;
            let inDeps = false;
            for (const line of content.split('\n')) {
                if (/^\[(?:.*-)?dependencies/.test(line.trim())) { inDeps = true; continue; }
                if (/^\[/.test(line.trim()) && inDeps) { inDeps = false; continue; }
                if (inDeps) {
                    const m = line.match(/^\s*([\w][\w-]*)\s*=/);
                    if (m) deps.add(m[1].replace(/-/g, '_')); // Rust uses _ in code for - in Cargo
                }
            }
        }
    } catch { /* no Cargo.toml */ }
    return deps;
}

export function checkJavaKotlinImports(
    content: string, file: string, ext: string, cwd: string,
    projectFiles: Set<string>, hallucinated: HallucinatedImport[]
): void {
    const lines = content.split('\n');
    const buildDeps = loadJavaDeps(cwd);
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
                const depPattern = /(?:implementation|api|compile|testImplementation|runtimeOnly)\s*[('"]([^:'"]+)/g;
                let m;
                while ((m = depPattern.exec(content)) !== null) {
                    deps.add(m[1]); // group ID like "com.google.guava"
                }
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
        }
    } catch { /* no build files */ }
    return deps;
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
