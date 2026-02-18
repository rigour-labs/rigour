import type { DeprecationEntry } from './types.js';

/**
 * Built-in deprecation database.
 * Bundled with Rigour and updated with releases.
 */
export const BUILT_IN_DEPRECATIONS: DeprecationEntry[] = [
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
