/**
 * Staleness Detector
 * 
 * Detects when AI is suggesting deprecated or outdated patterns.
 * Uses package.json analysis and a deprecation database.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import semver from 'semver';
import type {
    StalenessResult,
    StalenessIssue,
    DeprecationEntry
} from './types.js';

/**
 * Built-in deprecation database.
 * This is bundled with Rigour and updated with releases.
 */
const BUILT_IN_DEPRECATIONS: DeprecationEntry[] = [
    // React deprecations
    {
        pattern: 'componentWillMount',
        library: 'react',
        deprecatedIn: '16.3.0',
        replacement: 'useEffect(() => { ... }, [])',
        severity: 'error',
        reason: 'Unsafe lifecycle method removed in React 18',
        docs: 'https://react.dev/reference/react/Component#unsafe_componentwillmount'
    },
    {
        pattern: 'componentWillReceiveProps',
        library: 'react',
        deprecatedIn: '16.3.0',
        replacement: 'getDerivedStateFromProps or useEffect',
        severity: 'error',
        reason: 'Unsafe lifecycle method removed in React 18'
    },
    {
        pattern: 'componentWillUpdate',
        library: 'react',
        deprecatedIn: '16.3.0',
        replacement: 'getSnapshotBeforeUpdate or useEffect',
        severity: 'error',
        reason: 'Unsafe lifecycle method removed in React 18'
    },
    {
        pattern: 'UNSAFE_componentWillMount',
        library: 'react',
        deprecatedIn: '18.0.0',
        replacement: 'useEffect(() => { ... }, [])',
        severity: 'warning',
        reason: 'Prepare for React 19 removal'
    },
    {
        pattern: 'ReactDOM.render',
        library: 'react-dom',
        deprecatedIn: '18.0.0',
        replacement: 'createRoot(container).render(<App />)',
        severity: 'error',
        reason: 'Legacy root API deprecated in React 18'
    },
    {
        pattern: 'ReactDOM.hydrate',
        library: 'react-dom',
        deprecatedIn: '18.0.0',
        replacement: 'hydrateRoot(container, <App />)',
        severity: 'error',
        reason: 'Legacy hydration API deprecated in React 18'
    },

    // Package deprecations
    {
        pattern: "import.*from ['\"]moment['\"]",
        deprecatedIn: 'ecosystem',
        replacement: "import { format } from 'date-fns'",
        severity: 'warning',
        reason: 'moment.js is in maintenance mode since September 2020',
        docs: 'https://momentjs.com/docs/#/-project-status/'
    },
    {
        pattern: "require\\(['\"]request['\"]\\)",
        deprecatedIn: 'ecosystem',
        replacement: 'Use native fetch or axios',
        severity: 'error',
        reason: 'request package deprecated in February 2020'
    },
    {
        pattern: "import.*from ['\"]request['\"]",
        deprecatedIn: 'ecosystem',
        replacement: 'Use native fetch or axios',
        severity: 'error',
        reason: 'request package deprecated in February 2020'
    },

    // JavaScript/TypeScript deprecations
    {
        pattern: '\\bvar\\s+\\w+\\s*=',
        deprecatedIn: 'es6',
        replacement: 'Use const or let',
        severity: 'warning',
        reason: 'var has function scope which leads to bugs. Use block-scoped const/let'
    },

    // Redux deprecations
    {
        pattern: 'createStore\\(',
        library: 'redux',
        deprecatedIn: '4.2.0',
        replacement: "configureStore from '@reduxjs/toolkit'",
        severity: 'warning',
        reason: 'Redux Toolkit is now the recommended way',
        docs: 'https://redux.js.org/introduction/why-rtk-is-redux-today'
    },

    // Node.js deprecations
    {
        pattern: 'new Buffer\\(',
        deprecatedIn: 'node@6.0.0',
        replacement: 'Buffer.alloc() or Buffer.from()',
        severity: 'error',
        reason: 'Buffer constructor is a security hazard'
    },

    // Express deprecations
    {
        pattern: 'app\\.del\\(',
        library: 'express',
        deprecatedIn: '4.0.0',
        replacement: 'app.delete()',
        severity: 'warning',
        reason: 'app.del() was renamed to app.delete()'
    },

    // TypeScript patterns to avoid
    {
        pattern: '\\benum\\s+\\w+',
        deprecatedIn: 'best-practice',
        replacement: 'const object with as const assertion',
        severity: 'info',
        reason: 'Enums have quirks. Consider using const objects for better tree-shaking',
        docs: 'https://www.typescriptlang.org/docs/handbook/enums.html#const-enums'
    },

    // Next.js deprecations
    {
        pattern: 'getInitialProps',
        library: 'next',
        deprecatedIn: '13.0.0',
        replacement: 'getServerSideProps or App Router with async components',
        severity: 'warning',
        reason: 'getInitialProps prevents static optimization'
    },
    {
        pattern: "from ['\"]next/router['\"]",
        library: 'next',
        deprecatedIn: '13.0.0',
        replacement: "useRouter from 'next/navigation' in App Router",
        severity: 'info',
        reason: 'Use next/navigation for App Router projects'
    },

    // ============================================================
    // SECURITY PATTERNS - Cross-language security vulnerabilities
    // ============================================================

    // Python CSRF disabled
    {
        pattern: 'csrf\\s*=\\s*False',
        deprecatedIn: 'security',
        replacement: "Never disable CSRF protection. Remove 'csrf = False' and use proper CSRF tokens.",
        severity: 'error',
        reason: 'CSRF protection is critical for security. Disabling it exposes users to cross-site request forgery attacks.'
    },
    {
        pattern: 'WTF_CSRF_ENABLED\\s*=\\s*False',
        deprecatedIn: 'security',
        replacement: "Never disable CSRF. Remove 'WTF_CSRF_ENABLED = False' from config.",
        severity: 'error',
        reason: 'Flask-WTF CSRF protection should never be disabled in production.'
    },
    {
        pattern: "@csrf_exempt",
        deprecatedIn: 'security',
        replacement: "Remove @csrf_exempt decorator. Use proper CSRF token handling instead.",
        severity: 'error',
        reason: 'csrf_exempt bypasses CSRF protection, creating security vulnerabilities.'
    },

    // Python hardcoded secrets
    {
        pattern: "SECRET_KEY\\s*=\\s*['\"][^'\"]{1,50}['\"]",
        deprecatedIn: 'security',
        replacement: "Use os.environ.get('SECRET_KEY') or secrets.token_hex(32)",
        severity: 'error',
        reason: 'Hardcoded secrets are exposed in version control and logs. Use environment variables.'
    },
    {
        pattern: "API_KEY\\s*=\\s*['\"][^'\"]+['\"]",
        deprecatedIn: 'security',
        replacement: "Use os.environ.get('API_KEY') for API credentials",
        severity: 'error',
        reason: 'Hardcoded API keys are a security risk. Use environment variables.'
    },
    {
        pattern: "PASSWORD\\s*=\\s*['\"][^'\"]+['\"]",
        deprecatedIn: 'security',
        replacement: "Never hardcode passwords. Use environment variables or secret managers.",
        severity: 'error',
        reason: 'Hardcoded passwords are a critical security vulnerability.'
    },

    // JavaScript/TypeScript prototype pollution
    {
        pattern: '\\.__proto__',
        deprecatedIn: 'security',
        replacement: "Use Object.getPrototypeOf() or Object.setPrototypeOf() instead of __proto__",
        severity: 'error',
        reason: 'Direct __proto__ access enables prototype pollution attacks.'
    },
    {
        pattern: '\\[\\s*[\'"]__proto__[\'"]\\s*\\]',
        deprecatedIn: 'security',
        replacement: "Never allow user input to access __proto__. Validate and sanitize object keys.",
        severity: 'error',
        reason: 'Bracket notation access to __proto__ is a prototype pollution vector.'
    },
    {
        pattern: '\\[\\s*[\'"]constructor[\'"]\\s*\\]\\s*\\[',
        deprecatedIn: 'security',
        replacement: "Block access to constructor property from user input.",
        severity: 'error',
        reason: 'constructor[constructor] pattern enables prototype pollution.'
    },

    // SQL Injection patterns
    {
        pattern: 'cursor\\.execute\\s*\\(\\s*f[\'"]',
        deprecatedIn: 'security',
        replacement: "Use parameterized queries: cursor.execute('SELECT * FROM users WHERE id = %s', (user_id,))",
        severity: 'error',
        reason: 'F-string SQL queries are vulnerable to SQL injection attacks.'
    },
    {
        pattern: '\\.execute\\s*\\([^)]*\\+[^)]*\\)',
        deprecatedIn: 'security',
        replacement: "Use parameterized queries instead of string concatenation.",
        severity: 'error',
        reason: 'String concatenation in SQL queries enables SQL injection.'
    },

    // XSS patterns
    {
        pattern: 'dangerouslySetInnerHTML',
        deprecatedIn: 'security',
        replacement: "Sanitize HTML with DOMPurify before using dangerouslySetInnerHTML, or use safe alternatives.",
        severity: 'warning',
        reason: 'dangerouslySetInnerHTML can lead to XSS vulnerabilities if content is not sanitized.'
    },
    {
        pattern: '\\.innerHTML\\s*=',
        deprecatedIn: 'security',
        replacement: "Use textContent for text, or sanitize HTML before setting innerHTML.",
        severity: 'warning',
        reason: 'Direct innerHTML assignment can lead to XSS attacks.'
    },

    // Insecure session/cookie settings
    {
        pattern: 'SESSION_COOKIE_SECURE\\s*=\\s*False',
        deprecatedIn: 'security',
        replacement: "Set SESSION_COOKIE_SECURE = True in production",
        severity: 'error',
        reason: 'Insecure cookies can be intercepted over HTTP connections.'
    },
    {
        pattern: 'SESSION_COOKIE_HTTPONLY\\s*=\\s*False',
        deprecatedIn: 'security',
        replacement: "Set SESSION_COOKIE_HTTPONLY = True to prevent XSS cookie theft",
        severity: 'error',
        reason: 'Non-HTTPOnly cookies are accessible via JavaScript, enabling XSS attacks.'
    },

    // Debug mode in production
    {
        pattern: 'DEBUG\\s*=\\s*True',
        deprecatedIn: 'security',
        replacement: "Use DEBUG = os.environ.get('DEBUG', 'False') == 'True'",
        severity: 'warning',
        reason: 'Debug mode in production exposes sensitive information and stack traces.'
    }
];

/**
 * Project context extracted from package.json and other config files.
 */
interface ProjectContext {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    nodeVersion?: string;
    typescriptVersion?: string;
}

/**
 * Staleness Detector class.
 */
export class StalenessDetector {
    private deprecations: DeprecationEntry[];
    private projectContext: ProjectContext | null = null;
    private rootDir: string;
    private remoteRulesUrl = 'https://raw.githubusercontent.com/rigour-labs/rules/main/deprecations.json';

    constructor(rootDir: string, customDeprecations: DeprecationEntry[] = []) {
        this.rootDir = rootDir;
        this.deprecations = [...BUILT_IN_DEPRECATIONS, ...customDeprecations];
    }

    /**
     * Fetch latest deprecation rules from Rigour's remote registry.
     * This ensures the tool stays up-to-date even without a package update.
     */
    async syncRemoteRules(): Promise<number> {
        try {
            // Using dynamic import for fetch to avoid Node < 18 issues
            const response = await fetch(this.remoteRulesUrl);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const data = await response.json();
            if (data.deprecations && Array.isArray(data.deprecations)) {
                // Merge remote rules, avoiding duplicates
                const existingPatterns = new Set(this.deprecations.map(d => d.pattern));
                const newRules = data.deprecations.filter((d: DeprecationEntry) => !existingPatterns.has(d.pattern));

                this.deprecations.push(...newRules);
                return newRules.length;
            }
            return 0;
        } catch (error) {
            console.warn('Failed to sync remote rules, using built-in database:', error);
            return 0;
        }
    }

    /**
     * Check NPM registry for live deprecation status of project dependencies.
     * This is the ultimate "up-to-date" check.
     */
    async checkLiveRegistry(context: ProjectContext): Promise<StalenessIssue[]> {
        const issues: StalenessIssue[] = [];
        const { execa } = await import('execa');

        // We only check top-level dependencies to avoid noise/performance hits
        const deps = Object.keys(context.dependencies);

        for (const dep of deps) {
            try {
                // Run 'npm info <package> --json' to get metadata
                const { stdout } = await execa('npm', ['info', dep, '--json']);
                const info = JSON.parse(stdout);

                // 1. Check if package is deprecated
                if (info.deprecated) {
                    issues.push({
                        line: 0, // Package-level
                        pattern: dep,
                        severity: 'error',
                        reason: `Package "${dep}" is marked as DEPRECATED in NPM registry: ${info.deprecated}`,
                        replacement: 'Check package README for suggested alternatives',
                        docs: `https://www.npmjs.com/package/${dep}`
                    });
                }

                // 2. Check for latest version staleness
                const current = context.dependencies[dep].replace(/^[\^~>=<]+/, '');
                const latest = info['dist-tags']?.latest;

                if (latest && semver.major(latest) > semver.major(current)) {
                    issues.push({
                        line: 0,
                        pattern: dep,
                        severity: 'info',
                        reason: `Package "${dep}" has a new major version available (${latest}). Your version: ${current}`,
                        replacement: `npm install ${dep}@latest`,
                        docs: `https://www.npmjs.com/package/${dep}`
                    });
                }
            } catch (error) {
                // Silently skip if npm check fails
                continue;
            }
        }

        return issues;
    }

    /**
     * Load project context from package.json.
     */
    async loadProjectContext(): Promise<ProjectContext> {
        if (this.projectContext) {
            return this.projectContext;
        }

        const pkgPath = path.join(this.rootDir, 'package.json');

        try {
            const content = await fs.readFile(pkgPath, 'utf-8');
            const pkg = JSON.parse(content);

            this.projectContext = {
                dependencies: pkg.dependencies || {},
                devDependencies: pkg.devDependencies || {},
                nodeVersion: pkg.engines?.node,
                typescriptVersion: (pkg.devDependencies?.typescript || pkg.dependencies?.typescript)
            };

            return this.projectContext;
        } catch {
            this.projectContext = {
                dependencies: {},
                devDependencies: {}
            };
            return this.projectContext;
        }
    }

    /**
     * Check code for staleness issues.
     */
    async checkStaleness(code: string, filePath?: string, options: { live?: boolean } = {}): Promise<StalenessResult> {
        const context = await this.loadProjectContext();
        const issues: StalenessIssue[] = [];

        // 1. Check built-in/remote rules
        const lines = code.split('\n');
        for (const deprecation of this.deprecations) {
            // Check if this deprecation applies to the project
            if (deprecation.library && !this.hasLibrary(deprecation.library, context)) {
                continue;
            }

            // Check version constraints
            if (deprecation.library && deprecation.deprecatedIn !== 'ecosystem' &&
                deprecation.deprecatedIn !== 'best-practice' &&
                deprecation.deprecatedIn !== 'es6') {

                const installed = this.getInstalledVersion(deprecation.library, context);
                if (installed && !semver.gte(
                    semver.coerce(installed) || '0.0.0',
                    semver.coerce(deprecation.deprecatedIn) || '0.0.0'
                )) {
                    // Project is on older version where this isn't deprecated yet
                    continue;
                }
            }

            // Check for pattern match
            const regex = new RegExp(deprecation.pattern, 'g');
            for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                    issues.push({
                        line: i + 1,
                        pattern: deprecation.pattern,
                        severity: deprecation.severity,
                        reason: deprecation.reason || `Deprecated in ${deprecation.deprecatedIn}`,
                        replacement: deprecation.replacement,
                        docs: deprecation.docs
                    });
                }
                regex.lastIndex = 0;
            }
        }

        // 2. Perform live registry check if requested (only once per run/file usually)
        if (options.live) {
            const liveIssues = await this.checkLiveRegistry(context);
            issues.push(...liveIssues);
        }

        // Determine overall status
        let status: StalenessResult['status'] = 'FRESH';
        if (issues.some(i => i.severity === 'error')) {
            status = 'DEPRECATED';
        } else if (issues.some(i => i.severity === 'warning')) {
            status = 'STALE';
        }

        // Build project context for response
        const projectContextOutput: Record<string, string> = {};
        for (const [name, version] of Object.entries(context.dependencies)) {
            if (['react', 'react-dom', 'next', 'typescript', 'redux', 'express'].includes(name)) {
                projectContextOutput[name] = version;
            }
        }
        for (const [name, version] of Object.entries(context.devDependencies)) {
            if (['typescript'].includes(name)) {
                projectContextOutput[name] = version;
            }
        }

        return {
            status,
            issues,
            projectContext: projectContextOutput
        };
    }

    /**
     * Check if project has a library.
     */
    private hasLibrary(library: string, context: ProjectContext): boolean {
        return library in context.dependencies || library in context.devDependencies;
    }

    /**
     * Get installed version of a library.
     */
    private getInstalledVersion(library: string, context: ProjectContext): string | null {
        const version = context.dependencies[library] || context.devDependencies[library];
        if (!version) return null;

        // Remove version prefix (^, ~, >=, etc.)
        return version.replace(/^[\^~>=<]+/, '');
    }

    /**
     * Add custom deprecation rules.
     */
    addDeprecation(entry: DeprecationEntry): void {
        this.deprecations.push(entry);
    }

    /**
     * Load deprecations from a YAML file.
     */
    async loadDeprecationsFromFile(filePath: string): Promise<void> {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const { parse } = await import('yaml');
            const data = parse(content);

            if (data.deprecations && Array.isArray(data.deprecations)) {
                this.deprecations.push(...data.deprecations);
            }
        } catch (error) {
            console.error(`Failed to load deprecations from ${filePath}:`, error);
        }
    }

    /**
     * Get all deprecations for display.
     */
    getAllDeprecations(): DeprecationEntry[] {
        return [...this.deprecations];
    }
}

/**
 * Quick helper to check code for staleness.
 */
export async function checkCodeStaleness(
    rootDir: string,
    code: string
): Promise<StalenessResult> {
    const detector = new StalenessDetector(rootDir);
    return detector.checkStaleness(code);
}
