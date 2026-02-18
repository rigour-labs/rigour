/**
 * Hallucinated Imports Gate — Go Standard Library False Positive Regression Tests
 *
 * Tests the fix for https://github.com/rigour-labs/rigour/issues/XXX
 * Previously, Go stdlib packages with slashes (encoding/json, net/http, etc.)
 * were flagged as hallucinated imports because the gate only recognized
 * single-word stdlib packages (fmt, os, io).
 *
 * @since v3.0.1
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HallucinatedImportsGate } from './hallucinated-imports.js';
import type { GateContext } from './base.js';
// fs-extra is mocked via module-level mock fns above

// Mock fs-extra — vi.hoisted ensures these are available when vi.mock runs (hoisted)
const { mockPathExists, mockPathExistsSync, mockReadFile, mockReadFileSync, mockReadJson } = vi.hoisted(() => ({
    mockPathExists: vi.fn(),
    mockPathExistsSync: vi.fn(),
    mockReadFile: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockReadJson: vi.fn(),
}));

vi.mock('fs-extra', () => {
    const mock = {
        pathExists: mockPathExists,
        pathExistsSync: mockPathExistsSync,
        readFile: mockReadFile,
        readFileSync: mockReadFileSync,
        readJson: mockReadJson,
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

describe('HallucinatedImportsGate — Go stdlib false positives', () => {
    let gate: HallucinatedImportsGate;
    const testCwd = '/tmp/test-go-project';

    const context: GateContext = {
        cwd: testCwd,
        ignore: [],
    };

    beforeEach(() => {
        vi.clearAllMocks();
        gate = new HallucinatedImportsGate({ enabled: true });
    });

    /**
     * This is the exact scenario from PicoClaw — Go stdlib packages with slashes
     * were being flagged as hallucinated. These are ALL real Go stdlib packages.
     */
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

        const goFile = 'main.go';
        (FileScanner.findFiles as any).mockResolvedValue([goFile]);
        mockReadFile.mockResolvedValue(goFileContent);
        mockPathExists.mockResolvedValue(false);
        mockPathExistsSync.mockReturnValue(false); // no go.mod

        const failures = await gate.run(context);

        // ZERO failures — every import above is a real Go stdlib package
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
        mockPathExistsSync.mockReturnValue(true); // go.mod exists
        mockReadFileSync.mockReturnValue(goMod);

        const failures = await gate.run(context);

        // Should flag doesnotexist but NOT realmodule
        expect(failures).toHaveLength(1);
        expect(failures[0].details).toContain('doesnotexist');
        expect(failures[0].details).not.toContain('realmodule');
    });

    it('should NOT flag anything when no go.mod exists and imports have no dots', async () => {
        // Without go.mod, we can't determine the project module path,
        // so we skip project-relative checks to avoid false positives
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

describe('HallucinatedImportsGate — Python stdlib coverage', () => {
    let gate: HallucinatedImportsGate;
    const testCwd = '/tmp/test-py-project';

    const context: GateContext = {
        cwd: testCwd,
        ignore: [],
    };

    beforeEach(() => {
        vi.clearAllMocks();
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

describe('HallucinatedImportsGate — JS/TS Node builtins', () => {
    let gate: HallucinatedImportsGate;
    const testCwd = '/tmp/test-node-project';

    const context: GateContext = {
        cwd: testCwd,
        ignore: [],
    };

    beforeEach(() => {
        vi.clearAllMocks();
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
});
