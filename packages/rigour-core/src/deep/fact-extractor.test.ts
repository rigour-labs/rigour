import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the internal extractFileFacts by importing extractFacts and factsToPromptString
// But we need to test extraction logic directly, so we also test via the public API
const mockGlobby = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());

vi.mock('globby', () => ({
    globby: mockGlobby,
}));

vi.mock('fs-extra', () => ({
    default: {
        readFile: mockReadFile,
    },
}));

import { extractFacts, factsToPromptString, type FileFacts } from './fact-extractor.js';

describe('Fact Extractor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // ── TypeScript extraction ──

    describe('TypeScript/JavaScript extraction', () => {
        it('should extract classes with methods and dependencies', async () => {
            mockGlobby.mockResolvedValue(['src/service.ts']);
            mockReadFile.mockResolvedValue(`
import { Logger } from './logger';

export class UserService {
    constructor(
        private db: Database,
        private logger: Logger
    ) {}

    async findById(id: string): Promise<User> {
        return this.db.find(id);
    }

    async create(data: CreateUserDto): Promise<User> {
        this.logger.info('Creating user');
        return this.db.create(data);
    }

    async update(id: string, data: UpdateUserDto): Promise<User> {
        return this.db.update(id, data);
    }

    async delete(id: string): Promise<void> {
        return this.db.delete(id);
    }
}
`);

            const facts = await extractFacts('/project');
            expect(facts).toHaveLength(1);
            expect(facts[0].language).toBe('typescript');
            expect(facts[0].classes).toHaveLength(1);
            expect(facts[0].classes[0].name).toBe('UserService');
            expect(facts[0].classes[0].methodCount).toBeGreaterThanOrEqual(4);
            expect(facts[0].classes[0].dependencies).toContain('Database');
            expect(facts[0].classes[0].dependencies).toContain('Logger');
        });

        it('should extract functions with params and async detection', async () => {
            mockGlobby.mockResolvedValue(['src/utils.ts']);
            mockReadFile.mockResolvedValue(`
export async function processData(input: string, config: Config, options: Options): Promise<Result> {
    if (input.length > 0) {
        if (config.validate) {
            if (options.strict) {
                return validate(input);
            }
        }
    }
    return { data: input };
}

export function simpleHelper(x: number): number {
    return x * 2;
}
`);

            const facts = await extractFacts('/project');
            const funcs = facts[0].functions;
            expect(funcs.length).toBeGreaterThanOrEqual(1);

            const processData = funcs.find(f => f.name === 'processData');
            expect(processData).toBeDefined();
            expect(processData!.isAsync).toBe(true);
            expect(processData!.isExported).toBe(true);
            expect(processData!.paramCount).toBe(3);
            expect(processData!.maxNesting).toBeGreaterThanOrEqual(3);
        });

        it('should extract imports from ES modules and require', async () => {
            mockGlobby.mockResolvedValue(['src/index.ts']);
            mockReadFile.mockResolvedValue(`
import { Router } from 'express';
import path from 'path';
const fs = require('fs-extra');
import type { Config } from './types';

export function init() {
    const router = Router();
    return router;
}
`);

            const facts = await extractFacts('/project');
            expect(facts[0].imports).toContain('express');
            expect(facts[0].imports).toContain('path');
            expect(facts[0].imports).toContain('fs-extra');
            expect(facts[0].imports).toContain('./types');
        });

        it('should extract error handling patterns', async () => {
            mockGlobby.mockResolvedValue(['src/api.ts']);
            mockReadFile.mockResolvedValue(`
async function fetchData() {
    try {
        const res = await fetch('/api');
        return res.json();
    } catch (err) {
        console.error(err);
        throw err;
    }
}

async function riskyOp() {
    try {
        await doSomething();
    } catch (err) {
    }
}

fetchData().then(data => {
    process(data);
}).catch(() => {});
`);

            const facts = await extractFacts('/project');
            expect(facts[0].errorHandling.length).toBeGreaterThanOrEqual(2);

            const tryCatches = facts[0].errorHandling.filter(e => e.type === 'try-catch');
            expect(tryCatches.length).toBeGreaterThanOrEqual(2);

            // Strategy detection finds console.error first → 'log'
            const strategies = tryCatches.map(e => e.strategy);
            expect(strategies.length).toBeGreaterThanOrEqual(2);
        });

        it('should detect test files and count assertions', async () => {
            mockGlobby.mockResolvedValue(['src/utils.test.ts']);
            mockReadFile.mockResolvedValue(`
import { describe, it, expect } from 'vitest';

describe('Utils', () => {
    it('should add numbers', () => {
        expect(add(1, 2)).toBe(3);
        expect(add(0, 0)).toBe(0);
    });

    it('should handle negatives', () => {
        expect(add(-1, 1)).toBe(0);
    });
});
`);

            const facts = await extractFacts('/project');
            expect(facts[0].hasTests).toBe(true);
            expect(facts[0].testAssertions).toBeGreaterThanOrEqual(3);
        });

        it('should extract exports', async () => {
            mockGlobby.mockResolvedValue(['src/types.ts']);
            mockReadFile.mockResolvedValue(`
export interface User {
    id: string;
    name: string;
}

export const DEFAULT_CONFIG = {};

export function createUser(): User {
    return { id: '1', name: 'test' };
}

export type Severity = 'high' | 'low';
`);

            const facts = await extractFacts('/project');
            expect(facts[0].exports).toContain('User');
            expect(facts[0].exports).toContain('DEFAULT_CONFIG');
            expect(facts[0].exports).toContain('createUser');
            expect(facts[0].exports).toContain('Severity');
        });
    });

    // ── Python extraction ──

    describe('Python extraction', () => {
        it('should extract Python classes', async () => {
            mockGlobby.mockResolvedValue(['app/service.py']);
            mockReadFile.mockResolvedValue(`
class UserService:
    def __init__(self, db):
        self.db = db

    def find_by_id(self, user_id):
        return self.db.find(user_id)

    def create(self, data):
        return self.db.create(data)

    def _validate(self, data):
        pass
`);

            const facts = await extractFacts('/project');
            expect(facts[0].language).toBe('python');
            expect(facts[0].classes).toHaveLength(1);
            expect(facts[0].classes[0].name).toBe('UserService');
            expect(facts[0].classes[0].methodCount).toBeGreaterThanOrEqual(3);
        });

        it('should extract Python imports', async () => {
            mockGlobby.mockResolvedValue(['app/main.py']);
            mockReadFile.mockResolvedValue(`
import os
from pathlib import Path
import json
from typing import Optional
from app.service import UserService

def main():
    svc = UserService()
    return svc
`);

            const facts = await extractFacts('/project');
            expect(facts[0].imports).toContain('os');
            expect(facts[0].imports).toContain('pathlib');
            expect(facts[0].imports).toContain('app.service');
        });
    });

    // ── Go extraction ──

    describe('Go extraction', () => {
        it('should extract Go structs with fields and methods', async () => {
            mockGlobby.mockResolvedValue(['pkg/server.go']);
            mockReadFile.mockResolvedValue(`package server

import (
    "net/http"
    "sync"
)

type Server struct {
    addr    string
    port    int
    handler http.Handler
    mu      sync.Mutex
    *Base
}

func NewServer(addr string, port int) *Server {
    return &Server{addr: addr, port: port}
}

func (s *Server) Start() error {
    s.mu.Lock()
    defer s.mu.Unlock()
    return http.ListenAndServe(s.addr, s.handler)
}

func (s *Server) Stop() error {
    return nil
}

func (s *Server) Handler() http.Handler {
    return s.handler
}
`);

            const facts = await extractFacts('/project');
            expect(facts[0].language).toBe('go');
            expect(facts[0].structs).toBeDefined();
            expect(facts[0].structs!.length).toBeGreaterThanOrEqual(1);

            const server = facts[0].structs![0];
            expect(server.name).toBe('Server');
            expect(server.fieldCount).toBeGreaterThanOrEqual(4); // addr, port, handler, mu, Base
            expect(server.methodCount).toBeGreaterThanOrEqual(3); // Start, Stop, Handler
            expect(server.methods).toContain('Start');
            expect(server.methods).toContain('Stop');
            expect(server.embeds).toContain('Base');
        });

        it('should extract Go interfaces', async () => {
            mockGlobby.mockResolvedValue(['pkg/store.go']);
            mockReadFile.mockResolvedValue(`package store

type Store interface {
    Get(key string) (string, error)
    Set(key string, value string) error
    Delete(key string) error
    List(prefix string) ([]string, error)
    Close() error
    Watch(key string) <-chan Event
}

type SimpleStore struct {
    data map[string]string
}
`);

            const facts = await extractFacts('/project');
            expect(facts[0].interfaces).toBeDefined();
            expect(facts[0].interfaces!.length).toBeGreaterThanOrEqual(1);

            const store = facts[0].interfaces![0];
            expect(store.name).toBe('Store');
            expect(store.methodCount).toBe(6);
            expect(store.methods).toContain('Get');
            expect(store.methods).toContain('Close');
        });

        it('should extract Go functions with receiver methods', async () => {
            mockGlobby.mockResolvedValue(['pkg/handler.go']);
            mockReadFile.mockResolvedValue(`package handler

type Handler struct {
    service Service
}

func NewHandler(svc Service) *Handler {
    return &Handler{service: svc}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    if r.Method == "GET" {
        h.handleGet(w, r)
    } else {
        h.handlePost(w, r)
    }
}

func (h *Handler) handleGet(w http.ResponseWriter, r *http.Request) {
    data, err := h.service.Find(r.URL.Query().Get("id"))
    if err != nil {
        http.Error(w, err.Error(), 500)
        return
    }
    json.NewEncoder(w).Encode(data)
}
`);

            const facts = await extractFacts('/project');
            const funcs = facts[0].functions;

            // Should have receiver methods named as Receiver.Method
            const serveHTTP = funcs.find(f => f.name === 'Handler.ServeHTTP');
            expect(serveHTTP).toBeDefined();

            const handleGet = funcs.find(f => f.name === 'Handler.handleGet');
            expect(handleGet).toBeDefined();

            // NewHandler should be a standalone func (no receiver)
            const newHandler = funcs.find(f => f.name === 'NewHandler');
            expect(newHandler).toBeDefined();
            expect(newHandler!.isExported).toBe(true);
        });

        it('should count concurrency metrics', async () => {
            mockGlobby.mockResolvedValue(['pkg/worker.go']);
            mockReadFile.mockResolvedValue(`package worker

import "sync"

func StartWorkers(n int) {
    var mu sync.Mutex
    var wg sync.WaitGroup
    ch := make(chan int, 10)

    for i := 0; i < n; i++ {
        wg.Add(1)
        go processItem(ch, &mu, &wg)
    }

    go monitorWorkers(ch)

    defer close(ch)
}

func processItem(ch chan int, mu *sync.Mutex, wg *sync.WaitGroup) {
    defer wg.Done()
    for item := range ch {
        mu.Lock()
        process(item)
        mu.Unlock()
    }
}
`);

            const facts = await extractFacts('/project');
            expect(facts[0].goroutines).toBeGreaterThanOrEqual(2);
            expect(facts[0].channels).toBeGreaterThanOrEqual(1);
            expect(facts[0].defers).toBeGreaterThanOrEqual(2);
            expect(facts[0].mutexes).toBeGreaterThanOrEqual(2);
        });
    });

    // ── Quality metrics ──

    describe('Quality metrics', () => {
        it('should detect magic numbers', async () => {
            mockGlobby.mockResolvedValue(['src/calc.ts']);
            mockReadFile.mockResolvedValue(`
export function calculate(input: number): number {
    const base = input * 42;
    const tax = base * 17;
    const fee = 325 + 1250;
    const limit = 9999;
    return base + tax + fee + limit;
}
`);

            const facts = await extractFacts('/project');
            expect(facts[0].magicNumbers).toBeGreaterThanOrEqual(3);
        });

        it('should count TODOs', async () => {
            mockGlobby.mockResolvedValue(['src/app.ts']);
            mockReadFile.mockResolvedValue(`
// TODO: implement caching
export function getData() {
    // FIXME: this is slow
    const data = fetch('/api');
    // HACK: workaround for bug
    return data;
}
`);

            const facts = await extractFacts('/project');
            expect(facts[0].todoCount).toBe(4); // TODO, FIXME, HACK, WORKAROUND
        });

        it('should calculate comment ratio', async () => {
            mockGlobby.mockResolvedValue(['src/app.ts']);
            mockReadFile.mockResolvedValue(`
// This is a comment
// Another comment
export function foo() {
    return 1;
}

function bar() {
    return 2;
}
`);

            const facts = await extractFacts('/project');
            expect(facts[0].commentRatio).toBeGreaterThan(0);
        });

        it('should skip trivial files (< 3 lines)', async () => {
            mockGlobby.mockResolvedValue(['src/empty.ts']);
            mockReadFile.mockResolvedValue(`// empty\n`);

            const facts = await extractFacts('/project');
            expect(facts).toHaveLength(0);
        });
    });

    // ── factsToPromptString ──

    describe('factsToPromptString', () => {
        it('should serialize file facts to a prompt string', () => {
            const facts: FileFacts[] = [
                {
                    path: 'src/service.ts',
                    language: 'typescript',
                    lineCount: 150,
                    classes: [{
                        name: 'UserService',
                        lineStart: 5,
                        lineEnd: 140,
                        methodCount: 8,
                        methods: ['find', 'create', 'update', 'delete', 'validate', 'transform', 'cache', 'notify'],
                        publicMethods: ['find', 'create', 'update', 'delete'],
                        lineCount: 135,
                        dependencies: ['Database', 'Logger'],
                    }],
                    functions: [],
                    imports: ['express', './types', 'lodash'],
                    exports: ['UserService'],
                    errorHandling: [
                        { type: 'try-catch', lineStart: 10, isEmpty: false, strategy: 'throw' },
                        { type: 'try-catch', lineStart: 30, isEmpty: true, strategy: 'ignore' },
                    ],
                    testAssertions: 0,
                    hasTests: false,
                },
            ];

            const result = factsToPromptString(facts);
            expect(result).toContain('FILE: src/service.ts');
            expect(result).toContain('CLASS UserService');
            expect(result).toContain('135 lines');
            expect(result).toContain('8 methods');
            expect(result).toContain('deps: Database, Logger');
            expect(result).toContain('ERROR_HANDLING');
            expect(result).toContain('1 empty catches');
            expect(result).toContain('IMPORTS: 3');
        });

        it('should include Go structs and concurrency info', () => {
            const facts: FileFacts[] = [
                {
                    path: 'pkg/worker.go',
                    language: 'go',
                    lineCount: 200,
                    classes: [],
                    functions: [{
                        name: 'StartWorkers',
                        lineStart: 10,
                        lineEnd: 60,
                        lineCount: 50,
                        paramCount: 2,
                        params: ['n int', 'config Config'],
                        maxNesting: 3,
                        hasReturn: true,
                        isAsync: true,
                        isExported: true,
                    }],
                    imports: ['sync', 'context'],
                    exports: [],
                    errorHandling: [],
                    testAssertions: 0,
                    hasTests: false,
                    structs: [{
                        name: 'Worker',
                        lineStart: 5,
                        lineEnd: 15,
                        fieldCount: 4,
                        methodCount: 3,
                        methods: ['Start', 'Stop', 'Process'],
                        lineCount: 10,
                        embeds: [],
                    }],
                    goroutines: 5,
                    channels: 2,
                    defers: 3,
                    mutexes: 1,
                },
            ];

            const result = factsToPromptString(facts);
            expect(result).toContain('STRUCT Worker');
            expect(result).toContain('4 fields');
            expect(result).toContain('3 methods');
            expect(result).toContain('CONCURRENCY');
            expect(result).toContain('goroutines:5');
            expect(result).toContain('channels:2');
            expect(result).toContain('defers:3');
            expect(result).toContain('mutexes:1');
        });

        it('should respect maxChars budget', () => {
            const manyFacts: FileFacts[] = Array.from({ length: 100 }, (_, i) => ({
                path: `src/file${i}.ts`,
                language: 'typescript',
                lineCount: 100,
                classes: [],
                functions: [{
                    name: `func${i}`,
                    lineStart: 1,
                    lineEnd: 50,
                    lineCount: 50,
                    paramCount: 2,
                    params: ['a', 'b'],
                    maxNesting: 2,
                    hasReturn: true,
                    isAsync: false,
                    isExported: true,
                }],
                imports: ['express', 'lodash', 'react'],
                exports: [`func${i}`],
                errorHandling: [],
                testAssertions: 0,
                hasTests: false,
            }));

            const result = factsToPromptString(manyFacts, 500);
            expect(result.length).toBeLessThanOrEqual(600); // Allow some slack
        });
    });
});
