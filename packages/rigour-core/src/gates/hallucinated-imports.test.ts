/**
 * Hallucinated Imports Gate — Comprehensive Regression Tests
 *
 * Coverage: Go, Python, JS/TS, Ruby, C#, Rust, Java, Kotlin
 *
 * Tests the fix for Go stdlib false positives (PicoClaw regression)
 * and validates all 8 language checkers for false positive/negative accuracy.
 *
 * @since v3.0.1
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HallucinatedImportsGate } from './hallucinated-imports.js';
import type { GateContext } from './base.js';
import path from 'path';

// Mock fs-extra — vi.hoisted ensures these are available when vi.mock runs (hoisted)
const { mockPathExists, mockPathExistsSync, mockReadFile, mockReadFileSync, mockReadJson, mockReaddirSync } = vi.hoisted(() => ({
    mockPathExists: vi.fn(),
    mockPathExistsSync: vi.fn(),
    mockReadFile: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockReadJson: vi.fn(),
    mockReaddirSync: vi.fn().mockReturnValue([]),
}));

vi.mock('fs-extra', () => {
    const mock = {
        pathExists: mockPathExists,
        pathExistsSync: mockPathExistsSync,
        readFile: mockReadFile,
        readFileSync: mockReadFileSync,
        readJson: mockReadJson,
        readdirSync: mockReaddirSync,
    };
    return {
        ...mock,
        default: mock,
    };
});

// Mock FileScanner
vi.mock('../utils/scanner.js', () => ({
    FileScanner: {
        findFiles: vi.fn().mockResolvedValue([]),
    },
}));

import { FileScanner } from '../utils/scanner.js';

const normalizePath = (input: string): string => input.replace(/\\/g, '/');

// ═══════════════════════════════════════════════════════════════
// GO
// ═══════════════════════════════════════════════════════════════

describe('HallucinatedImportsGate — Go stdlib false positives', () => {
    let gate: HallucinatedImportsGate;
    const testCwd = '/tmp/test-go-project';
    const context: GateContext = { cwd: testCwd, ignore: [] };

    beforeEach(() => {
        vi.clearAllMocks();
        mockReaddirSync.mockReturnValue([]);
        gate = new HallucinatedImportsGate({ enabled: true });
    });

    it('should NOT flag Go standard library packages as hallucinated (PicoClaw regression)', async () => {
        const goFileContent = `package main

import (
    "encoding/json"
    "path/filepath"
    "net/http"
    "crypto/rand"
    "crypto/sha256"
    "encoding/base64"
    "os/exec"
    "os/signal"
    "net/url"
    "fmt"
    "io"
    "os"
    "strings"
    "context"
    "sync"
    "time"
    "log"
    "errors"
    "io/ioutil"
    "io/fs"
    "math/rand"
    "regexp"
    "strconv"
    "bytes"
    "bufio"
    "sort"
    "testing"
    "net/http/httptest"
    "database/sql"
    "html/template"
    "text/template"
    "archive/zip"
    "compress/gzip"
    "runtime/debug"
)

func main() {}
`;

        (FileScanner.findFiles as any).mockResolvedValue(['main.go']);
        mockReadFile.mockResolvedValue(goFileContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should NOT flag external module imports (github.com, etc.)', async () => {
        const goFileContent = `package main

import (
    "github.com/gin-gonic/gin"
    "github.com/stretchr/testify/assert"
    "google.golang.org/grpc"
    "go.uber.org/zap"
    "golang.org/x/crypto/bcrypt"
)

func main() {}
`;

        (FileScanner.findFiles as any).mockResolvedValue(['main.go']);
        mockReadFile.mockResolvedValue(goFileContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should flag project-relative imports that do not resolve (with go.mod)', async () => {
        const goMod = `module github.com/myorg/myproject

go 1.22
`;
        const goFileContent = `package main

import (
    "fmt"
    "github.com/myorg/myproject/pkg/realmodule"
    "github.com/myorg/myproject/pkg/doesnotexist"
)

func main() {}
`;

        (FileScanner.findFiles as any).mockResolvedValue(['cmd/main.go', 'pkg/realmodule/handler.go']);
        mockReadFile.mockImplementation(async (filePath: string) => {
            if (filePath.includes('handler.go')) return 'package realmodule\n\nimport "fmt"\n\nfunc Handler() {}\n';
            return goFileContent;
        });
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(goMod);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('doesnotexist');
        expect(failures[0].details).not.toContain('realmodule');
    });

    it('should NOT flag anything when no go.mod exists and imports have no dots', async () => {
        const goFileContent = `package main

import (
    "fmt"
    "net/http"
    "internal/custom"
)

func main() {}
`;

        (FileScanner.findFiles as any).mockResolvedValue(['main.go']);
        mockReadFile.mockResolvedValue(goFileContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should handle single-line imports', async () => {
        const goFileContent = `package main

import "fmt"
import "encoding/json"
import "net/http"

func main() {}
`;

        (FileScanner.findFiles as any).mockResolvedValue(['main.go']);
        mockReadFile.mockResolvedValue(goFileContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should handle aliased imports', async () => {
        const goFileContent = `package main

import (
    "fmt"
    mrand "math/rand"
    _ "net/http/pprof"
    . "os"
)

func main() {}
`;

        (FileScanner.findFiles as any).mockResolvedValue(['main.go']);
        mockReadFile.mockResolvedValue(goFileContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════
// PYTHON
// ═══════════════════════════════════════════════════════════════

describe('HallucinatedImportsGate — Python stdlib coverage', () => {
    let gate: HallucinatedImportsGate;
    const testCwd = '/tmp/test-py-project';
    const context: GateContext = { cwd: testCwd, ignore: [] };

    beforeEach(() => {
        vi.clearAllMocks();
        mockReaddirSync.mockReturnValue([]);
        gate = new HallucinatedImportsGate({ enabled: true });
    });

    it('should NOT flag Python standard library imports', async () => {
        const pyContent = `
import os
import sys
import json
import hashlib
import pathlib
import subprocess
import argparse
import typing
import dataclasses
import functools
import itertools
import collections
import datetime
import re
import math
import random
import threading
import asyncio
from os.path import join, exists
from collections import defaultdict
from typing import List, Optional
from urllib.parse import urlparse
`;

        (FileScanner.findFiles as any).mockResolvedValue(['main.py']);
        mockReadFile.mockResolvedValue(pyContent);
        mockPathExists.mockResolvedValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════
// JS/TS (Node.js)
// ═══════════════════════════════════════════════════════════════

describe('HallucinatedImportsGate — JS/TS Node builtins', () => {
    let gate: HallucinatedImportsGate;
    const testCwd = path.resolve('/tmp/test-node-project');
    const testCwdNormalized = normalizePath(testCwd);
    const context: GateContext = { cwd: testCwd, ignore: [] };

    beforeEach(() => {
        vi.clearAllMocks();
        mockReaddirSync.mockReturnValue([]);
        gate = new HallucinatedImportsGate({ enabled: true });
    });

    it('should NOT flag Node.js built-in modules', async () => {
        const jsContent = `
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import url from 'url';
import os from 'os';
import stream from 'stream';
import util from 'util';
import { readFile } from 'node:fs';
import { join } from 'node:path';
`;

        (FileScanner.findFiles as any).mockResolvedValue(['index.ts']);
        mockReadFile.mockResolvedValue(jsContent);
        mockPathExists.mockResolvedValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should NOT flag Node 22.x built-in modules (async_hooks, diagnostics_channel, etc.)', async () => {
        const jsContent = `
import { AsyncLocalStorage } from 'async_hooks';
import dc from 'diagnostics_channel';
import { readFile } from 'fs/promises';
import test from 'test';
import wt from 'worker_threads';
import timers from 'timers/promises';
import { ReadableStream } from 'stream/web';
`;

        (FileScanner.findFiles as any).mockResolvedValue(['server.ts']);
        mockReadFile.mockResolvedValue(jsContent);
        mockPathExists.mockResolvedValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should resolve dependencies from nearest package.json in monorepos', async () => {
        const jsContent = `
import { app } from 'electron';
import React from 'react';
`;

        (FileScanner.findFiles as any).mockResolvedValue(['apps/desktop/src/main.ts']);
        mockReadFile.mockResolvedValue(jsContent);
        mockPathExists.mockImplementation(async (p: string) => {
            const normalized = normalizePath(p);
            return normalized === `${testCwdNormalized}/apps/desktop/package.json`
                || normalized === `${testCwdNormalized}/package.json`
                || normalized.includes('/node_modules/electron')
                || normalized.includes('/node_modules/react');
        });
        mockReadJson.mockImplementation(async (p: string) => {
            const normalized = normalizePath(p);
            if (normalized.endsWith('/apps/desktop/package.json')) {
                return {
                    dependencies: { electron: '^31.0.0', react: '^18.0.0' },
                    devDependencies: {},
                    peerDependencies: {},
                    optionalDependencies: {},
                };
            }
            // Root package.json should not incorrectly block desktop deps
            return {
                dependencies: {},
                devDependencies: {},
                peerDependencies: {},
                optionalDependencies: {},
            };
        });

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should NOT flag tsconfig path aliases that resolve in monorepos', async () => {
        const jsContent = `
import { logger } from '@/utils/logger';
import { cfg } from '~shared/config';
`;
        const tsconfigContent = `{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "~shared/*": ["../shared/src/*"]
    }
  }
}`;

        (FileScanner.findFiles as any).mockResolvedValue([
            'apps/desktop/src/main.ts',
            'apps/desktop/src/utils/logger.ts',
            'apps/shared/src/config.ts',
        ]);
        mockReadFile.mockImplementation(async (p: string) => {
            const normalized = normalizePath(p);
            if (normalized.endsWith('/apps/desktop/tsconfig.json')) return tsconfigContent;
            if (normalized.endsWith('/apps/desktop/src/main.ts')) return jsContent;
            return 'export const ok = true;';
        });
        mockPathExists.mockImplementation(async (p: string) => {
            const normalized = normalizePath(p);
            return normalized === `${testCwdNormalized}/apps/desktop/tsconfig.json`
                || normalized === `${testCwdNormalized}/package.json`;
        });
        mockReadJson.mockResolvedValue({
            dependencies: {},
            devDependencies: {},
            peerDependencies: {},
            optionalDependencies: {},
        });

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should flag tsconfig path aliases when target does not resolve', async () => {
        const jsContent = `import { logger } from '@/utils/missing';`;
        const tsconfigContent = `{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  }
}`;

        (FileScanner.findFiles as any).mockResolvedValue(['apps/desktop/src/main.ts']);
        mockReadFile.mockImplementation(async (p: string) => {
            const normalized = normalizePath(p);
            if (normalized.endsWith('/apps/desktop/tsconfig.json')) return tsconfigContent;
            return jsContent;
        });
        mockPathExists.mockImplementation(async (p: string) => {
            const normalized = normalizePath(p);
            return normalized === `${testCwdNormalized}/apps/desktop/tsconfig.json`
                || normalized === `${testCwdNormalized}/package.json`;
        });
        mockReadJson.mockResolvedValue({
            dependencies: {},
            devDependencies: {},
            peerDependencies: {},
            optionalDependencies: {},
        });

        const failures = await gate.run(context);
        expect(failures).toHaveLength(1);
        // Depending on tsconfig resolution context, this may surface as
        // a direct alias resolution failure OR a missing package fallback.
        const details = failures[0].details;
        expect(
            details.includes("Path alias '@/utils/missing' does not resolve to a project file")
            || details.includes("Package '@/utils' not in package.json dependencies")
        ).toBe(true);
    });

    it('should NOT flag ESM .js specifiers that resolve to .ts source files', async () => {
        const jsContent = `
import { helper } from './utils.js';
`;

        (FileScanner.findFiles as any).mockResolvedValue(['src/main.ts', 'src/utils.ts']);
        mockReadFile.mockImplementation(async (p: string) => {
            const normalized = p.replace(/\\/g, '/');
            if (normalized.endsWith('/src/main.ts')) return jsContent;
            return 'export const helper = () => 42;';
        });
        mockPathExists.mockImplementation(async (p: string) => {
            const normalized = p.replace(/\\/g, '/');
            return normalized === '/tmp/test-node-project/package.json';
        });
        mockReadJson.mockResolvedValue({
            dependencies: {},
            devDependencies: {},
            peerDependencies: {},
            optionalDependencies: {},
        });

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });
});

describe('HallucinatedImportsGate — ignore generated/test artifacts', () => {
    let gate: HallucinatedImportsGate;
    const testCwd = '/tmp/test-ignore-project';
    const context: GateContext = { cwd: testCwd, ignore: [] };

    beforeEach(() => {
        vi.clearAllMocks();
        mockReaddirSync.mockReturnValue([]);
        gate = new HallucinatedImportsGate({ enabled: true });
    });

    it('skips studio-dist files by default', async () => {
        (FileScanner.findFiles as any).mockResolvedValue(['packages/rigour-cli/studio-dist/assets/index.js']);
        mockReadFile.mockResolvedValue(`import 'definitely-not-a-real-package';`);
        mockPathExists.mockResolvedValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('skips test files by default', async () => {
        (FileScanner.findFiles as any).mockResolvedValue(['src/example.test.ts']);
        mockReadFile.mockResolvedValue(`import 'totally-not-installed';`);
        mockPathExists.mockResolvedValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════
// RUBY
// ═══════════════════════════════════════════════════════════════

describe('HallucinatedImportsGate — Ruby imports', () => {
    let gate: HallucinatedImportsGate;
    const testCwd = '/tmp/test-ruby-project';
    const context: GateContext = { cwd: testCwd, ignore: [] };

    beforeEach(() => {
        vi.clearAllMocks();
        mockReaddirSync.mockReturnValue([]);
        gate = new HallucinatedImportsGate({ enabled: true });
    });

    it('should NOT flag Ruby standard library requires', async () => {
        const rbContent = `
require 'json'
require 'yaml'
require 'net/http'
require 'uri'
require 'fileutils'
require 'pathname'
require 'open3'
require 'digest'
require 'openssl'
require 'csv'
require 'set'
require 'date'
require 'time'
require 'tempfile'
require 'securerandom'
require 'logger'
require 'socket'
require 'erb'
require 'optparse'
require 'stringio'
require 'zlib'
require 'base64'
require 'benchmark'
require 'singleton'
require 'forwardable'
require 'shellwords'
require 'bigdecimal'
`;

        (FileScanner.findFiles as any).mockResolvedValue(['app.rb']);
        mockReadFile.mockResolvedValue(rbContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should NOT flag gems listed in Gemfile', async () => {
        const rbContent = `
require 'rails'
require 'pg'
require 'puma'
require 'sidekiq'
require 'devise'
`;

        const gemfile = `
source 'https://rubygems.org'

gem 'rails', '~> 7.0'
gem 'pg'
gem 'puma', '~> 6.0'
gem 'sidekiq'
gem 'devise'
`;

        (FileScanner.findFiles as any).mockResolvedValue(['app.rb']);
        mockReadFile.mockResolvedValue(rbContent);
        mockPathExistsSync.mockImplementation((p: string) => p.includes('Gemfile'));
        mockReadFileSync.mockReturnValue(gemfile);
        mockPathExists.mockResolvedValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should flag unknown requires when Gemfile exists', async () => {
        const rbContent = `
require 'json'
require 'nonexistent_gem_abcxyz'
`;

        const gemfile = `
source 'https://rubygems.org'
gem 'rails'
`;

        (FileScanner.findFiles as any).mockResolvedValue(['app.rb']);
        mockReadFile.mockResolvedValue(rbContent);
        mockPathExistsSync.mockImplementation((p: string) => p.includes('Gemfile'));
        mockReadFileSync.mockReturnValue(gemfile);
        mockPathExists.mockResolvedValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('nonexistent_gem_abcxyz');
    });

    it('should flag broken require_relative paths', async () => {
        const rbContent = `
require_relative 'lib/helpers'
require_relative 'models/user'
`;

        (FileScanner.findFiles as any).mockResolvedValue(['app.rb']);
        mockReadFile.mockResolvedValue(rbContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);

        const failures = await gate.run(context);
        // Both require_relative should fail since no matching .rb files exist
        expect(failures).toHaveLength(1); // grouped into 1 failure by file
        expect(failures[0].details).toContain('lib/helpers');
        expect(failures[0].details).toContain('models/user');
    });

    it('should NOT flag require_relative that resolves to project files', async () => {
        const rbContent = `
require_relative 'lib/helpers'
`;

        (FileScanner.findFiles as any).mockResolvedValue(['app.rb', 'lib/helpers.rb']);
        mockReadFile.mockImplementation(async (filePath: string) => {
            if (filePath.includes('helpers.rb')) return 'module Helpers; end';
            return rbContent;
        });
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should NOT flag gems from .gemspec add_dependency', async () => {
        const rbContent = `
require 'thor'
require 'httparty'
`;

        const gemspec = `
Gem::Specification.new do |spec|
  spec.name = "mygem"
  spec.add_dependency "thor", "~> 1.0"
  spec.add_runtime_dependency "httparty"
end
`;

        (FileScanner.findFiles as any).mockResolvedValue(['lib/mygem.rb']);
        mockReadFile.mockResolvedValue(rbContent);
        mockPathExistsSync.mockImplementation((p: string) => !p.includes('Gemfile'));
        mockReaddirSync.mockReturnValue(['mygem.gemspec']);
        mockReadFileSync.mockReturnValue(gemspec);
        mockPathExists.mockResolvedValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should skip flagging requires when no Gemfile context exists', async () => {
        // Without Gemfile or gemspec, we can't distinguish installed gems from hallucinated ones
        const rbContent = `
require 'some_unknown_gem'
`;

        (FileScanner.findFiles as any).mockResolvedValue(['script.rb']);
        mockReadFile.mockResolvedValue(rbContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);

        const failures = await gate.run(context);
        // No Gemfile = gemDeps.size === 0 → skip flagging to avoid false positives
        expect(failures).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════
// C# (.NET)
// ═══════════════════════════════════════════════════════════════

describe('HallucinatedImportsGate — C# imports', () => {
    let gate: HallucinatedImportsGate;
    const testCwd = '/tmp/test-csharp-project';
    const context: GateContext = { cwd: testCwd, ignore: [] };

    beforeEach(() => {
        vi.clearAllMocks();
        mockReaddirSync.mockReturnValue([]);
        gate = new HallucinatedImportsGate({ enabled: true });
    });

    it('should NOT flag .NET framework namespaces', async () => {
        const csContent = `
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.EntityFrameworkCore;
`;

        (FileScanner.findFiles as any).mockResolvedValue(['Controllers/HomeController.cs']);
        mockReadFile.mockResolvedValue(csContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should NOT flag NuGet packages from .csproj', async () => {
        const csContent = `
using Newtonsoft.Json;
using Serilog;
using AutoMapper;
using FluentValidation;
using MediatR;
`;

        const csproj = `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
    <PackageReference Include="Serilog" Version="3.1.1" />
    <PackageReference Include="AutoMapper" Version="12.0.1" />
    <PackageReference Include="FluentValidation" Version="11.8.0" />
    <PackageReference Include="MediatR" Version="12.2.0" />
  </ItemGroup>
</Project>
`;

        (FileScanner.findFiles as any).mockResolvedValue(['Program.cs']);
        mockReadFile.mockResolvedValue(csContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);
        mockReaddirSync.mockReturnValue(['MyProject.csproj']);
        mockReadFileSync.mockReturnValue(csproj);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should NOT flag using static directives', async () => {
        const csContent = `
using System;
using static System.Math;
using static System.Console;
`;

        (FileScanner.findFiles as any).mockResolvedValue(['Helper.cs']);
        mockReadFile.mockResolvedValue(csContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should NOT flag using disposable pattern (using var = ...)', async () => {
        const csContent = `
using System;
using (var stream = new FileStream("test.txt", FileMode.Open))
{
    // Should not be parsed as a namespace import
}
`;

        (FileScanner.findFiles as any).mockResolvedValue(['Program.cs']);
        mockReadFile.mockResolvedValue(csContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should flag project-relative namespaces that do not resolve (with .csproj)', async () => {
        const csContent = `
using System;
using MyProject.Services.UserService;
using MyProject.Models.DoesNotExist;
`;

        const csContent2 = `
namespace MyProject.Services.UserService
{
    public class UserService { }
}
`;

        const csproj = `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>`;

        (FileScanner.findFiles as any).mockResolvedValue([
            'Controllers/HomeController.cs',
            'Services/UserService/UserService.cs',
        ]);
        mockReadFile.mockImplementation(async (filePath: string) => {
            if (filePath.includes('UserService')) return csContent2;
            return csContent;
        });
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);
        mockReaddirSync.mockReturnValue(['MyProject.csproj']);
        mockReadFileSync.mockReturnValue(csproj);

        const failures = await gate.run(context);
        // Should flag DoesNotExist but not UserService
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('DoesNotExist');
        expect(failures[0].details).not.toContain('UserService');
    });

    it('should NOT flag common ecosystem NuGet packages', async () => {
        const csContent = `
using Xunit;
using Moq;
using FluentAssertions;
using NUnit.Framework;
using Dapper;
using Polly;
using StackExchange.Redis;
using Npgsql;
using Grpc.Core;
`;

        (FileScanner.findFiles as any).mockResolvedValue(['Tests.cs']);
        mockReadFile.mockResolvedValue(csContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════
// RUST
// ═══════════════════════════════════════════════════════════════

describe('HallucinatedImportsGate — Rust imports', () => {
    let gate: HallucinatedImportsGate;
    const testCwd = '/tmp/test-rust-project';
    const context: GateContext = { cwd: testCwd, ignore: [] };

    beforeEach(() => {
        vi.clearAllMocks();
        mockReaddirSync.mockReturnValue([]);
        gate = new HallucinatedImportsGate({ enabled: true });
    });

    it('should NOT flag Rust std library crates', async () => {
        const rsContent = `
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use core::fmt;
use alloc::vec::Vec;
`;

        (FileScanner.findFiles as any).mockResolvedValue(['src/main.rs']);
        mockReadFile.mockResolvedValue(rsContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should NOT flag crates listed in Cargo.toml', async () => {
        const rsContent = `
use serde::{Serialize, Deserialize};
use tokio::runtime::Runtime;
use reqwest::Client;
use clap::Parser;
`;

        const cargoToml = `
[package]
name = "my-project"
version = "0.1.0"

[dependencies]
serde = { version = "1.0", features = ["derive"] }
tokio = { version = "1.0", features = ["full"] }
reqwest = "0.11"
clap = { version = "4.0", features = ["derive"] }
`;

        (FileScanner.findFiles as any).mockResolvedValue(['src/main.rs']);
        mockReadFile.mockResolvedValue(rsContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockImplementation((p: string) => p.includes('Cargo.toml'));
        mockReadFileSync.mockReturnValue(cargoToml);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should handle Cargo.toml dash-to-underscore conversion', async () => {
        const rsContent = `
use my_crate::something;
use another_lib::util;
`;

        const cargoToml = `
[dependencies]
my-crate = "1.0"
another-lib = "2.0"
`;

        (FileScanner.findFiles as any).mockResolvedValue(['src/main.rs']);
        mockReadFile.mockResolvedValue(rsContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockImplementation((p: string) => p.includes('Cargo.toml'));
        mockReadFileSync.mockReturnValue(cargoToml);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should NOT flag crate/self/super keywords', async () => {
        const rsContent = `
use crate::config::Settings;
use self::helpers::format;
use super::parent_module;
`;

        (FileScanner.findFiles as any).mockResolvedValue(['src/lib.rs']);
        mockReadFile.mockResolvedValue(rsContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should flag unknown extern crate not in Cargo.toml', async () => {
        const rsContent = `
extern crate serde;
extern crate nonexistent_crate;
`;

        const cargoToml = `
[dependencies]
serde = "1.0"
`;

        (FileScanner.findFiles as any).mockResolvedValue(['src/main.rs']);
        mockReadFile.mockResolvedValue(rsContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockImplementation((p: string) => p.includes('Cargo.toml'));
        mockReadFileSync.mockReturnValue(cargoToml);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('nonexistent_crate');
        expect(failures[0].details).not.toContain('serde');
    });

    it('should flag unknown use crate not in Cargo.toml', async () => {
        const rsContent = `
use serde::Serialize;
use fake_crate::FakeStruct;
`;

        const cargoToml = `
[dependencies]
serde = "1.0"
`;

        (FileScanner.findFiles as any).mockResolvedValue(['src/main.rs']);
        mockReadFile.mockResolvedValue(rsContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockImplementation((p: string) => p.includes('Cargo.toml'));
        mockReadFileSync.mockReturnValue(cargoToml);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('fake_crate');
    });

    it('should NOT flag pub use re-exports of known crates', async () => {
        const rsContent = `
pub use serde::Serialize;
pub use std::collections::HashMap;
`;

        const cargoToml = `
[dependencies]
serde = "1.0"
`;

        (FileScanner.findFiles as any).mockResolvedValue(['src/lib.rs']);
        mockReadFile.mockResolvedValue(rsContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockImplementation((p: string) => p.includes('Cargo.toml'));
        mockReadFileSync.mockReturnValue(cargoToml);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should handle [dev-dependencies] and [build-dependencies]', async () => {
        const rsContent = `
use criterion::Criterion;
use cc::Build;
`;

        const cargoToml = `
[dependencies]
serde = "1.0"

[dev-dependencies]
criterion = "0.5"

[build-dependencies]
cc = "1.0"
`;

        (FileScanner.findFiles as any).mockResolvedValue(['benches/bench.rs']);
        mockReadFile.mockResolvedValue(rsContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockImplementation((p: string) => p.includes('Cargo.toml'));
        mockReadFileSync.mockReturnValue(cargoToml);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════
// JAVA
// ═══════════════════════════════════════════════════════════════

describe('HallucinatedImportsGate — Java imports', () => {
    let gate: HallucinatedImportsGate;
    const testCwd = '/tmp/test-java-project';
    const context: GateContext = { cwd: testCwd, ignore: [] };

    beforeEach(() => {
        vi.clearAllMocks();
        mockReaddirSync.mockReturnValue([]);
        gate = new HallucinatedImportsGate({ enabled: true });
    });

    it('should NOT flag Java standard library imports', async () => {
        const javaContent = `
import java.util.List;
import java.util.Map;
import java.util.HashMap;
import java.io.File;
import java.io.IOException;
import java.net.URL;
import java.time.LocalDateTime;
import java.util.stream.Collectors;
import javax.net.ssl.SSLContext;
import jakarta.servlet.http.HttpServletRequest;
`;

        (FileScanner.findFiles as any).mockResolvedValue(['src/main/java/App.java']);
        mockReadFile.mockResolvedValue(javaContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should NOT flag import static for Java stdlib', async () => {
        const javaContent = `
import static java.lang.Math.max;
import static java.util.Collections.emptyList;
`;

        (FileScanner.findFiles as any).mockResolvedValue(['Helper.java']);
        mockReadFile.mockResolvedValue(javaContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should NOT flag build.gradle dependencies', async () => {
        const javaContent = `
import com.google.guava.collect.ImmutableList;
import org.springframework.boot.SpringApplication;
import io.netty.channel.Channel;
`;

        const buildGradle = `
plugins {
    id 'java'
}

dependencies {
    implementation 'com.google.guava:guava:32.0.0-jre'
    implementation 'org.springframework.boot:spring-boot-starter:3.1.0'
    implementation 'io.netty:netty-all:4.1.100'
}
`;

        (FileScanner.findFiles as any).mockResolvedValue(['src/main/java/App.java']);
        mockReadFile.mockResolvedValue(javaContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockImplementation((p: string) => p.includes('build.gradle'));
        mockReadFileSync.mockReturnValue(buildGradle);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should NOT flag pom.xml dependencies', async () => {
        const javaContent = `
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.lang3.StringUtils;
`;

        const pomXml = `
<project>
  <dependencies>
    <dependency>
      <groupId>com.fasterxml.jackson</groupId>
      <artifactId>jackson-databind</artifactId>
    </dependency>
    <dependency>
      <groupId>org.apache.commons</groupId>
      <artifactId>commons-lang3</artifactId>
    </dependency>
  </dependencies>
</project>
`;

        (FileScanner.findFiles as any).mockResolvedValue(['src/main/java/App.java']);
        mockReadFile.mockResolvedValue(javaContent);
        mockPathExistsSync.mockImplementation((p: string) => p.includes('pom.xml'));
        mockReadFileSync.mockReturnValue(pomXml);
        mockPathExists.mockResolvedValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should flag unknown imports when build deps context exists', async () => {
        const javaContent = `
import java.util.List;
import com.nonexistent.hallucinated.FakeClass;
`;

        const buildGradle = `
dependencies {
    implementation 'org.springframework:spring-core:6.0.0'
}
`;

        (FileScanner.findFiles as any).mockResolvedValue(['src/main/java/App.java']);
        mockReadFile.mockResolvedValue(javaContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockImplementation((p: string) => p.includes('build.gradle'));
        mockReadFileSync.mockReturnValue(buildGradle);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('com.nonexistent.hallucinated.FakeClass');
    });

    it('should NOT flag when no build context exists (avoid false positives)', async () => {
        const javaContent = `
import com.example.whatever.SomeClass;
`;

        (FileScanner.findFiles as any).mockResolvedValue(['App.java']);
        mockReadFile.mockResolvedValue(javaContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should NOT flag common test framework imports', async () => {
        const javaContent = `
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Assertions;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
`;

        (FileScanner.findFiles as any).mockResolvedValue(['Test.java']);
        mockReadFile.mockResolvedValue(javaContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════
// KOTLIN
// ═══════════════════════════════════════════════════════════════

describe('HallucinatedImportsGate — Kotlin imports', () => {
    let gate: HallucinatedImportsGate;
    const testCwd = '/tmp/test-kotlin-project';
    const context: GateContext = { cwd: testCwd, ignore: [] };

    beforeEach(() => {
        vi.clearAllMocks();
        mockReaddirSync.mockReturnValue([]);
        gate = new HallucinatedImportsGate({ enabled: true });
    });

    it('should NOT flag Kotlin standard library imports', async () => {
        const ktContent = `
import kotlin.collections.mutableListOf
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.Serializable
`;

        (FileScanner.findFiles as any).mockResolvedValue(['src/main/kotlin/App.kt']);
        mockReadFile.mockResolvedValue(ktContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should NOT flag Java stdlib imports from Kotlin (interop)', async () => {
        const ktContent = `
import java.util.UUID
import java.io.File
import java.time.Instant
import javax.crypto.Cipher
`;

        (FileScanner.findFiles as any).mockResolvedValue(['src/main/kotlin/App.kt']);
        mockReadFile.mockResolvedValue(ktContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(0);
    });

    it('should flag unknown Kotlin imports when Gradle context exists', async () => {
        const ktContent = `
import kotlin.collections.mutableListOf
import com.hallucinated.fake.Module
`;

        const buildGradle = `
dependencies {
    implementation 'org.jetbrains.kotlin:kotlin-stdlib:1.9.0'
}
`;

        (FileScanner.findFiles as any).mockResolvedValue(['src/main/kotlin/App.kt']);
        mockReadFile.mockResolvedValue(ktContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockImplementation((p: string) =>
            p.includes('build.gradle') || p.includes('build.gradle.kts')
        );
        mockReadFileSync.mockReturnValue(buildGradle);

        const failures = await gate.run(context);
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('com.hallucinated.fake.Module');
    });
});
