import * as _Parser from 'web-tree-sitter';
const Parser = (_Parser as any).default || _Parser;
import { ASTHandler, ASTHandlerContext } from './base.js';
import { Failure } from '../../types/index.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface LanguageConfig {
    grammarPath: string;
    extensions: string[];
    queries: {
        methods: string;
        parameters: string;
        complexity: string; // Cyclomatic
        nesting: string;    // For Cognitive Complexity
        securitySinks?: string;
        resourceLeaks?: string;
        nPlusOne?: string;
        ecosystemBlunders?: string;
    }
}

export class UniversalASTHandler extends ASTHandler {
    private parser?: any;
    private languages: Record<string, LanguageConfig> = {
        '.go': {
            grammarPath: '../../vendor/grammars/tree-sitter-go.wasm',
            extensions: ['.go'],
            queries: {
                complexity: '(if_statement) (for_statement) (select_statement) (case_clause)',
                nesting: '(if_statement (block . (if_statement))) (for_statement (block . (for_statement)))',
                parameters: '(parameter_list (parameter_declaration) @param)',
                methods: '(method_declaration) @method (function_declaration) @method',
                securitySinks: '(call_expression function: (selector_expression field: (field_identifier) @id (#match? @id "^(Command|exec|System)$")))',
                ecosystemBlunders: '(if_statement !condition: (binary_expression left: (identifier) @err (#eq? @err "err")))' // Missing err check
            }
        },
        '.py': {
            grammarPath: '../../vendor/grammars/tree-sitter-python.wasm',
            extensions: ['.py'],
            queries: {
                complexity: '(if_statement) (for_statement) (while_statement) (with_statement)',
                nesting: '(if_statement (block (if_statement)))',
                parameters: '(parameters (identifier) @param)',
                methods: '(function_definition) @method',
                securitySinks: '(call_expression function: (identifier) @func (#match? @func "^(eval|exec|os\\.system)$"))',
                ecosystemBlunders: '(parameters (default_parameter value: (list) @mutable))' // Mutable default
            }
        },
        '.java': {
            grammarPath: '../../vendor/grammars/tree-sitter-java.wasm',
            extensions: ['.java'],
            queries: {
                complexity: '(if_statement) (for_statement) (while_statement) (switch_label)',
                nesting: '(if_statement (block (if_statement))) (for_statement (block (for_statement)))',
                parameters: '(formal_parameters (formal_parameter) @param)',
                methods: '(method_declaration) @method',
                securitySinks: '(method_declaration (modifiers (native))) @native (method_invocation name: (identifier) @name (#match? @name "^(exec|System\\.load)$"))',
                ecosystemBlunders: '(catch_clause body: (block . ))' // Empty catch
            }
        },
        '.rs': {
            grammarPath: '../../vendor/grammars/tree-sitter-rust.wasm',
            extensions: ['.rs'],
            queries: {
                complexity: '(if_expression) (for_expression) (while_expression) (loop_expression) (match_arm)',
                nesting: '(if_expression (block (if_expression))) (for_expression (block (for_expression)))',
                parameters: '(parameters (parameter) @param)',
                methods: '(impl_item (function_item)) @method (function_item) @method',
                securitySinks: '(unsafe_block) @unsafe',
                ecosystemBlunders: '(call_expression function: (field_expression field: (field_identifier) @id (#eq? @id "unwrap")))' // .unwrap()
            }
        },
        '.cs': {
            grammarPath: '../../vendor/grammars/tree-sitter-c_sharp.wasm',
            extensions: ['.cs'],
            queries: {
                complexity: '(if_statement) (for_statement) (foreach_statement) (while_statement) (switch_section)',
                nesting: '(if_statement (block (if_statement))) (for_statement (block (for_statement)))',
                parameters: '(parameter_list (parameter) @param)',
                methods: '(method_declaration) @method',
                securitySinks: '(attribute name: (identifier) @attr (#eq? @attr "DllImport")) @violation'
            }
        },
        '.cpp': {
            grammarPath: '../../vendor/grammars/tree-sitter-cpp.wasm',
            extensions: ['.cpp', '.cc', '.cxx', '.h', '.hpp'],
            queries: {
                complexity: '(if_statement) (for_statement) (while_statement) (case_statement)',
                nesting: '(if_statement (compound_statement (if_statement)))',
                parameters: '(parameter_list (parameter_declaration) @param)',
                methods: '(function_definition) @method',
                securitySinks: '(call_expression function: (identifier) @name (#match? @name "^(malloc|free|system|popen)$"))'
            }
        }
    };

    supports(file: string): boolean {
        const ext = path.extname(file).toLowerCase();
        return ext in this.languages;
    }

    async run(context: ASTHandlerContext): Promise<Failure[]> {
        const failures: Failure[] = [];
        const ext = path.extname(context.file).toLowerCase();
        const config = this.languages[ext];
        if (!config) return [];

        if (!this.parser) {
            await (Parser as any).init();
            this.parser = new (Parser as any)();
        }

        try {
            const Lang = await Parser.Language.load(path.resolve(__dirname, config.grammarPath));
            this.parser.setLanguage(Lang);
            const tree = this.parser.parse(context.content);
            const astConfig = this.config.ast || {};

            // 1. Structural Methods Audit
            const methodQuery = (Lang as any).query(config.queries.methods);
            const methodMatches = methodQuery.matches(tree.rootNode);

            for (const match of methodMatches) {
                for (const capture of match.captures) {
                    const node = capture.node;
                    const name = node.childForFieldName('name')?.text || 'anonymous';

                    // SME: Cognitive Complexity (Nesting depth + Cyclomatic)
                    const nesting = (Lang as any).query(config.queries.nesting).captures(node).length;
                    const cyclomatic = (Lang as any).query(config.queries.complexity).captures(node).length + 1;
                    const cognitive = cyclomatic + (nesting * 2);

                    if (cognitive > (astConfig.complexity || 10)) {
                        failures.push({
                            id: 'SME_COGNITIVE_LOAD',
                            title: `Method '${name}' has high cognitive load (${cognitive})`,
                            details: `Deeply nested or complex logic detected in ${context.file}.`,
                            files: [context.file],
                            hint: `Flatten logical branches and extract nested loops.`
                        });
                    }
                }
            }

            // 2. Security Sinks
            if (config.queries.securitySinks) {
                const securityQuery = (Lang as any).query(config.queries.securitySinks);
                const sinks = securityQuery.captures(tree.rootNode);
                for (const capture of sinks) {
                    failures.push({
                        id: 'SME_SECURITY_SINK',
                        title: `Unsafe function call detected: ${capture.node.text}`,
                        details: `Potentially dangerous execution in ${context.file}.`,
                        files: [context.file],
                        hint: `Avoid using shell execution or eval. Use safe alternatives.`
                    });
                }
            }

            // 3. Ecosystem Blunders
            if (config.queries.ecosystemBlunders) {
                const blunderQuery = (Lang as any).query(config.queries.ecosystemBlunders);
                const blunders = blunderQuery.captures(tree.rootNode);
                for (const capture of blunders) {
                    failures.push({
                        id: 'SME_BEST_PRACTICE',
                        title: `Ecosystem anti-pattern detected`,
                        details: `Violation of ${ext} best practices in ${context.file}.`,
                        files: [context.file],
                        hint: `Review language-specific best practices (e.g., error handling or mutable defaults).`
                    });
                }
            }

        } catch (e) {
            // Parser skip
        }

        return failures;
    }
}
