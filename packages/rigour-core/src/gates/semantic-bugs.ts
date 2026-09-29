/**
 * Semantic Bugs Gate: type-aware rules that prove a defect before reporting it.
 *
 * Each rule traces a value from where it enters to where it does harm, across
 * files when needed (see src/semantic/). A finding names both ends; anything
 * the engine cannot resolve produces no finding.
 */
import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import { analyzeFiles, BUILT_IN_RULES } from '../semantic/engine.js';
import type { SemanticFinding } from '../semantic/types.js';

export interface SemanticBugsConfig {
    enabled?: boolean;
    /** Rule ids to run; all built-in rules when omitted. */
    rules?: string[];
}

const SOURCE_PATTERNS = ['**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}'];
const TEST_FILE = /(?:^|\/)(?:__tests__|__mocks__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

export class SemanticBugsGate extends Gate {
    constructor(private readonly config: SemanticBugsConfig = {}) {
        super('semantic-bugs', 'Semantic Bug Detection');
    }

    protected get provenance(): Provenance { return 'traditional'; }

    async run(context: GateContext): Promise<Failure[]> {
        const files = (await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: context.patterns || SOURCE_PATTERNS,
            ignore: context.ignore,
        })).filter(file => /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file) && !/\.d\.[cm]?ts$/i.test(file) && !TEST_FILE.test(file));
        if (files.length === 0) return [];

        const wanted = this.config.rules;
        const rules = wanted?.length ? BUILT_IN_RULES.filter(rule => wanted.includes(rule.id)) : BUILT_IN_RULES;
        Logger.info(`Semantic Bugs: analyzing ${files.length} files with ${rules.length} rule(s)`);
        return analyzeFiles(context.cwd, files, { rules }).map(finding => this.toFailure(finding));
    }

    private toFailure(finding: SemanticFinding): Failure {
        const failure = this.createFailure(
            `${finding.message}\n${finding.evidence.map(e => `  at ${e}`).join('\n')}`,
            [finding.file],
            finding.hint,
            `[${finding.rule}] ${finding.message.split('. ')[0]}`.slice(0, 120),
            finding.line,
            undefined,
            finding.severity,
        );
        return { ...failure, provenance: finding.provenance, source: 'ast', category: finding.rule, verified: true, confidence: 1 };
    }
}
