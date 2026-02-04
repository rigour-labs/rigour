import { Config, Commands, Gates } from '../types/index.js';

export interface Template {
    name: string;
    markers: string[];
    config: {
        preset?: string;
        paradigm?: string;
        commands?: Partial<Commands>;
        gates?: Partial<Gates>;
        planned?: string[];
        ignore?: string[];
    };
}

export const TEMPLATES: Template[] = [
    {
        name: 'ui',
        markers: [
            'react',
            'next',
            'vue',
            'svelte',
            'next.config.js',
            'vite.config.ts',
            'tailwind.config.js',
            'base.css',
            'index.html',
        ],
        config: {
            preset: 'ui',
            ignore: [
                '.git/**',
                'node_modules/**',
                'dist/**',
                'build/**',
                '.next/**',
                '.nuxt/**',
                '.svelte-kit/**',
                'coverage/**',
                '.turbo/**',
            ],
            gates: {
                max_file_lines: 300,
                required_files: ['docs/SPEC.md', 'docs/ARCH.md', 'README.md'],
            },
            planned: [
                'Layer Boundary: Components cannot import from DB',
                'Prop-Drilling Detection: Max depth 5',
            ],
        },
    },
    {
        name: 'api',
        markers: [
            'express',
            'fastify',
            'nestjs',
            'go.mod',
            'requirements.txt',
            'pyproject.toml',
            'app.py',
            'main.go',
            'index.js',
        ],
        config: {
            preset: 'api',
            ignore: [
                '.git/**',
                // Node.js
                'node_modules/**',
                'dist/**',
                // Python
                'venv/**',
                '.venv/**',
                '__pycache__/**',
                '*.pyc',
                '.tox/**',
                '.pytest_cache/**',
                '.mypy_cache/**',
                '*.egg-info/**',
                // Go
                'vendor/**',
            ],
            gates: {
                max_file_lines: 400,
                required_files: ['docs/SPEC.md', 'docs/ARCH.md', 'README.md'],
            },
            planned: [
                'Service Layer Enforcement: Controllers -> Services only',
                'Repo Pattern: Databases access isolated to repositories/',
            ],
        },
    },
    {
        name: 'infra',
        markers: [
            'Dockerfile',
            'docker-compose.yml',
            'main.tf',
            'k8s/',
            'helm/',
            'ansible/',
        ],
        config: {
            preset: 'infra',
            ignore: [
                '.git/**',
                '.terraform/**',
                '*.tfstate',
                '*.tfstate.backup',
                '.terragrunt-cache/**',
                'charts/**/*.tgz',
            ],
            gates: {
                max_file_lines: 300,
                required_files: ['docs/RUNBOOK.md', 'docs/ARCH.md', 'README.md'],
            },
        },
    },
    {
        name: 'data',
        markers: [
            'ipynb',
            'spark',
            'pandas',
            'data/',
            'dbt_project.yml',
        ],
        config: {
            preset: 'data',
            ignore: [
                '.git/**',
                '.ipynb_checkpoints/**',
                '__pycache__/**',
                '*.pyc',
                'dbt_packages/**',
                'target/**',
                'logs/**',
                '*.parquet',
                '*.csv',
            ],
            gates: {
                max_file_lines: 500,
                required_files: ['docs/DATA_DICTIONARY.md', 'docs/PIPELINE.md', 'README.md'],
            },
            planned: [
                'Stochastic Determinism: Seed setting enforcement',
                'Data Leaks: Detecting PII in notebook outputs',
            ],
        },
    },
];

export const PARADIGM_TEMPLATES: Template[] = [
    {
        name: 'oop',
        markers: [
            'class ',
            'interface ',
            'implements ',
            'extends ',
            'constructor(',
            'private ',
            'public ',
            'protected ',
        ],
        config: {
            paradigm: 'oop',
            gates: {
                max_file_lines: 400,
                ast: {
                    complexity: 10,
                    max_methods: 10,
                    max_params: 5,
                    max_nesting: 4,
                    max_inheritance_depth: 3,
                    max_class_dependencies: 5,
                    max_function_lines: 60,
                },
            },
        },
    },
    {
        name: 'functional',
        // Removed '=>' as primary marker - too broad (appears in OOP callbacks)
        markers: [
            'export const',
            'reduce(',
            '.pipe(',
            'compose(',
            'curry(',
            'readonly ',
        ],
        config: {
            paradigm: 'functional',
            gates: {
                max_file_lines: 350,
                ast: {
                    complexity: 8,
                    max_methods: 15, // Functions, not classes
                    max_params: 4,
                    max_nesting: 3,
                    max_inheritance_depth: 3,
                    max_class_dependencies: 5,
                    max_function_lines: 40,
                },
            },
        },
    },
];

export const UNIVERSAL_CONFIG: Config = {
    version: 1,
    commands: {},
    gates: {
        max_file_lines: 500,
        forbid_todos: true,
        forbid_fixme: true,
        forbid_paths: [],
        required_files: ['docs/SPEC.md', 'docs/ARCH.md', 'docs/DECISIONS.md', 'docs/TASKS.md'],
        ast: {
            complexity: 10,
            max_methods: 10,
            max_params: 5,
            max_nesting: 4,
            max_inheritance_depth: 3,
            max_class_dependencies: 5,
            max_function_lines: 50,
        },
        dependencies: {
            forbid: [],
        },
        architecture: {
            boundaries: [],
        },
        safety: {
            max_files_changed_per_cycle: 10,
            protected_paths: ['.github/**', 'docs/**', 'rigour.yml'],
        },
        context: {
            enabled: true,
            sensitivity: 0.8,
            mining_depth: 100,
            ignored_patterns: [],
        },
        environment: {
            enabled: true,
            enforce_contracts: true,
            tools: {},
            required_env: [],
        },
        retry_loop_breaker: {
            enabled: true,
            max_retries: 3,
            auto_classify: true,
            doc_sources: {},
        },
        staleness: {
            enabled: false,
            rules: {
                'no-var': true,
                'no-commonjs': false,
                'no-arguments': false,
                'prefer-arrow': false,
                'prefer-template': false,
                'prefer-spread': false,
                'prefer-rest': false,
                'prefer-const': false,
            },
        },
    },
    output: {
        report_path: 'rigour-report.json',
    },
    planned: [],
    ignore: [],
};
