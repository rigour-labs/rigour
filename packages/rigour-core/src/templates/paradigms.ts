import type { Template } from './presets.js';

export const PARADIGM_TEMPLATES: Template[] = [
    {
        name: 'oop',
        markers: [
            'class ', 'interface ', 'implements ', 'extends ',
            'constructor(', 'private ', 'public ', 'protected ',
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
        // Removed '=>' as primary marker — too broad (appears in OOP callbacks)
        markers: [
            'export const', 'reduce(', '.pipe(', 'compose(', 'curry(', 'readonly ',
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
