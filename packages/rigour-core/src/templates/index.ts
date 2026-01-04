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
    },
    output: {
        report_path: 'rigour-report.json',
    },
    planned: [],
};
