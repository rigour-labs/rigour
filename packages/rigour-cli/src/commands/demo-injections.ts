/**
 * Drift injection patterns for live demo on real repos.
 * Each injection is a file to write with intentional code issues.
 */

export interface DriftInjection {
    filename: string;
    description: string;
    gate: string;
    severity: 'critical' | 'high' | 'medium';
    hookMessage: string;
    code: string;
}

/**
 * Universal injections that work in any TypeScript/JavaScript repo.
 */
export const TS_INJECTIONS: DriftInjection[] = [
    {
        filename: 'src/auth-handler.ts',
        description: 'AI writes authentication with hardcoded secret',
        gate: 'security-patterns',
        severity: 'critical',
        hookMessage: 'Possible hardcoded secret or API key detected',
        code: [
            'import express from \'express\';',
            '',
            'const API_SECRET = "sk-live-4f3c2b1a0987654321abcdef";',
            'const DB_PASSWORD = "super_secret_p@ssw0rd!";',
            '',
            'export function authenticate(req: express.Request) {',
            '    const token = req.headers.authorization;',
            '    if (token === API_SECRET) {',
            '        return { authenticated: true, role: \'admin\' };',
            '    }',
            '    return { authenticated: false };',
            '}',
        ].join('\n'),
    },
    {
        filename: 'src/ai-data-loader.ts',
        description: 'AI hallucinates a non-existent package',
        gate: 'hallucinated-imports',
        severity: 'critical',
        hookMessage: "Import 'ai-data-magic' does not resolve to any installed or known package",
        code: [
            'import { z } from \'zod\';',
            'import { magicParser } from \'ai-data-magic\';',
            'import { ultraCache } from \'quantum-cache-pro\';',
            '',
            'const schema = z.object({',
            '    name: z.string(),',
            '    email: z.string().email(),',
            '});',
            '',
            'export function loadData(raw: unknown) {',
            '    return schema.parse(raw);',
            '}',
        ].join('\n'),
    },
    {
        filename: 'src/api-handler.ts',
        description: 'AI forgets to await an async function',
        gate: 'promise-safety',
        severity: 'high',
        hookMessage: 'Unhandled promise — fetchUser() called without await or .catch()',
        code: [
            'export async function fetchUser(id: string) {',
            '    const res = await fetch(`/api/users/${id}`);',
            '    return res.json();',
            '}',
            '',
            'export function handleRequest(req: any, res: any) {',
            '    fetchUser(req.params.id);  // floating promise!',
            '    res.send(\'Processing...\');',
            '}',
        ].join('\n'),
    },
];

/**
 * Python/FastAPI injections.
 */
export const PYTHON_INJECTIONS: DriftInjection[] = [
    {
        filename: 'src/middleware/cors_config.py',
        description: 'AI sets wildcard CORS with credentials',
        gate: 'security-patterns',
        severity: 'critical',
        hookMessage: 'Wildcard CORS with allow_credentials=True — any origin can steal session tokens',
        code: [
            'from fastapi.middleware.cors import CORSMiddleware',
            '',
            'def setup_cors(app):',
            '    app.add_middleware(',
            '        CORSMiddleware,',
            '        allow_origins=["*"],',
            '        allow_credentials=True,',
            '        allow_methods=["*"],',
            '        allow_headers=["*"],',
            '    )',
        ].join('\n'),
    },
    {
        filename: 'src/middleware/logging_middleware.py',
        description: 'AI logs full request bodies including passwords',
        gate: 'security-patterns',
        severity: 'high',
        hookMessage: 'Request body logged — passwords, tokens, PII exposed in log output',
        code: [
            'import logging',
            'from starlette.middleware.base import BaseHTTPMiddleware',
            'from starlette.requests import Request',
            '',
            'logger = logging.getLogger(__name__)',
            '',
            'class LoggingMiddleware(BaseHTTPMiddleware):',
            '    async def dispatch(self, request: Request, call_next):',
            '        body = await request.body()',
            '        logger.info("Body: %s Headers: %s", body, dict(request.headers))',
            '        response = await call_next(request)',
            '        return response',
        ].join('\n'),
    },
    {
        filename: 'src/config.py',
        description: 'AI hardcodes secrets in config class',
        gate: 'security-patterns',
        severity: 'critical',
        hookMessage: 'Hardcoded SECRET_KEY and database credentials in source code',
        code: [
            'class Config:',
            '    SECRET_KEY = "super-secret-key-12345"',
            '    DATABASE_URL = "postgresql://admin:p@ssw0rd@prod-db:5432/app"',
            '    DEBUG = True',
            '    SESSION_COOKIE_SECURE = False',
            '    SESSION_COOKIE_HTTPONLY = False',
        ].join('\n'),
    },
];

/**
 * Fixed versions of TS injections (for before/after demo).
 */
export const TS_FIXES: Record<string, string> = {
    'src/auth-handler.ts': [
        'import express from \'express\';',
        '',
        'export function authenticate(req: express.Request) {',
        '    const token = req.headers.authorization;',
        '    if (!token) return { authenticated: false };',
        '    return { authenticated: validateToken(token) };',
        '}',
        '',
        'function validateToken(token: string): boolean {',
        '    return token.startsWith(\'Bearer \') && token.length > 20;',
        '}',
    ].join('\n'),
    'src/ai-data-loader.ts': [
        'import { z } from \'zod\';',
        '',
        'const schema = z.object({',
        '    name: z.string(),',
        '    email: z.string().email(),',
        '});',
        '',
        'export function loadData(raw: unknown) {',
        '    return schema.parse(raw);',
        '}',
    ].join('\n'),
    'src/api-handler.ts': [
        'import express from \'express\';',
        '',
        'export async function fetchUser(id: string) {',
        '    const res = await fetch(`/api/users/${id}`);',
        '    if (!res.ok) throw new Error(`HTTP ${res.status}`);',
        '    return res.json();',
        '}',
        '',
        'export async function handleRequest(req: express.Request, res: express.Response) {',
        '    try {',
        '        const data = await fetchUser(req.params.id);',
        '        res.json(data);',
        '    } catch (error) {',
        '        res.status(500).json({ error: \'Failed to fetch user\' });',
        '    }',
        '}',
    ].join('\n'),
};

/**
 * Detect which injection set to use based on repo contents.
 */
export function detectInjectionSet(languages: string[]): DriftInjection[] {
    if (languages.includes('Python')) {
        return PYTHON_INJECTIONS;
    }
    return TS_INJECTIONS;
}
