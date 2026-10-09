import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mustFix } from '../review/quiet.js';
import { HallucinatedImportsGate } from './hallucinated-imports/index.js';

// Real files, no mocks: each case is the smallest repository that shows it.
let repo: string;
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };
const run = async (files: string[]) => new HallucinatedImportsGate({ enabled: true }).run({ cwd: repo, patterns: files });
const flagged = (failures: Awaited<ReturnType<typeof run>>) => failures.map(f => [f.files?.[0], mustFix(f) ? 'block' : 'note', [...new Set([...f.details.matchAll(/L\d+: import '([^']+)'/g)].map(m => m[1]))]]);
beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), 'imports-')); });
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('Rust imports, read from the crate\'s own manifest', () => {
    beforeEach(() => {
        // A workspace below the repository root, as many repositories with Rust beside other code have it.
        write('native/Cargo.toml', '[workspace]\nmembers = ["crates/*"]\n\n[workspace.dependencies]\nserde = "1"\njni = "0.22"\nrusqlite = "0.40"\n');
        write('native/crates/core_db/Cargo.toml', '[package]\nname = "core-db"\n\n[dependencies]\nrusqlite = { workspace = true }\n');
        write('native/crates/core_db/src/lib.rs', 'pub mod schema;\npub fn open() {}\n');
        write('native/crates/ffi/Cargo.toml', [
            '[package]', 'name = "ffi"', '', '[lib]', 'name = "core_ffi"', '',
            '[dependencies]', 'core-db = { path = "../core_db" }', 'serde = { workspace = true }', 'json = { package = "serde_json", version = "1" }', '',
            '[target.\'cfg(target_os = "android")\'.dependencies]', 'jni = { workspace = true }', '',
            '[build-dependencies]', 'cc = "1"', '', '[dev-dependencies]', 'rusqlite = { workspace = true }', '',
        ].join('\n'));
    });

    it('resolves crate/self/super, workspace members, path, target, build, dev and renamed dependencies, and local modules', async () => {
        write('native/crates/ffi/src/lib.rs', [
            'mod log;', 'pub mod convert;', 'extern crate cc;',
            'use crate::convert::to_rgb;', 'use self::log::init;', 'use super::thing;',
            'use core_db::open;', 'use serde::Serialize;', 'use json::Value;', 'use jni::JNIEnv;', 'use cc::Build;',
            'use log::Level;', 'use std::path::Path;',
            'pub use serde::de;', 'use de::Deserialize;',
            '#[cfg(test)]', 'mod tests {', '    use rusqlite::Connection;', '}',
        ].join('\n'));
        write('native/crates/ffi/tests/it.rs', 'use core_ffi::convert;\n');
        expect(flagged(await run(['native/crates/ffi/src/lib.rs', 'native/crates/ffi/tests/it.rs']))).toEqual([]);
    });

    it('still blocks a crate its manifest does not declare, and a re-exported name is never a crate elsewhere', async () => {
        write('native/crates/core_db/src/settings.rs', 'use rusqlite::Connection;\nuse madeup_crate::Thing;\nuse de::Deserialize;\n');
        expect(flagged(await run(['native/crates/core_db/src/settings.rs']))).toEqual([['native/crates/core_db/src/settings.rs', 'block', ['madeup_crate', 'de']]]);
    });

    it('notes, never blocks, a crate it cannot check because no Cargo.toml was found', async () => {
        write('scripts/tool.rs', 'use std::fs;\nuse madeup_crate::Thing;\n');
        expect(flagged(await run(['scripts/tool.rs']))).toEqual([['scripts/tool.rs', 'note', ['madeup_crate']]]);
    });
});

describe('Go imports, read from go.mod', () => {
    beforeEach(() => {
        write('go.mod', 'module example.com/app\n\ngo 1.22\n\nrequire example.com/app/client/v2 v2.9.0\n\nrequire (\n\tgithub.com/acme/kit v1.0.0\n)\n');
        write('client/client.go', 'package client\n');
        write('internal/util/util_e2e.go', '//go:build e2e\n\npackage util\n');
        write('internal/util/doc.go', 'package util\n');
    });

    it('resolves a module go.mod requires under the same prefix, in-module packages and build-tagged files', async () => {
        write('cmd/e2e/svc_test.go', 'package e2e\n\nimport (\n\t"fmt"\n\t"example.com/app/client/v2"\n\t"example.com/app/internal/util"\n\t"github.com/acme/kit/log"\n)\n');
        expect(flagged(await run(['cmd/e2e/svc_test.go']))).toEqual([]);
    });

    it('finds an in-module package in a folder the scan leaves out, like build/', async () => {
        write('tools/build/build.go', 'package build\n');
        write('tools/build.go', 'package tools\n\nimport "example.com/app/tools/build"\n');
        expect(flagged(await run(['tools/build.go']))).toEqual([]);
    });

    it('still blocks an in-module package that does not exist, and a folder that only shares a prefix', async () => {
        write('cmd/main.go', 'package main\n\nimport (\n\t"example.com/app/nope"\n\t"example.com/app/internal/uti"\n)\n');
        expect(flagged(await run(['cmd/main.go']))).toEqual([['cmd/main.go', 'block', ['example.com/app/nope', 'example.com/app/internal/uti']]]);
    });
});
