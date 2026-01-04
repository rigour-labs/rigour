import { Config } from '../types/index.js';

export interface Template {
    name: string;
    markers: string[];
    config: Partial<Config>;
}

export const TEMPLATES: Template[] = [
    {
        name: 'Node.js',
        markers: ['package.json'],
        config: {
            commands: {
                lint: 'npm run lint',
                test: 'npm test',
            },
            gates: {
                max_file_lines: 500,
                forbid_todos: true,
                forbid_fixme: true,
                forbid_paths: [],
                required_files: ['docs/SPEC.md', 'docs/ARCH.md', 'README.md'],
            },
        },
    },
    {
        name: 'Python',
        markers: ['pyproject.toml', 'requirements.txt', 'setup.py'],
        config: {
            commands: {
                lint: 'ruff check .',
                test: 'pytest',
            },
            gates: {
                max_file_lines: 500,
                forbid_todos: true,
                forbid_fixme: true,
                forbid_paths: [],
                required_files: ['docs/SPEC.md', 'docs/ARCH.md', 'README.md'],
            },
        },
    },
    {
        name: 'Frontend (React/Vite/Next)',
        markers: ['next.config.js', 'vite.config.ts', 'tailwind.config.js'],
        config: {
            commands: {
                lint: 'npm run lint',
                test: 'npm test',
            },
            gates: {
                max_file_lines: 300, // Frontend files often should be smaller
                forbid_todos: true,
                forbid_fixme: true,
                forbid_paths: [],
                required_files: ['docs/SPEC.md', 'docs/ARCH.md', 'README.md'],
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
    },
    output: {
        report_path: 'rigour-report.json',
    },
};
