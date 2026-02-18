import { Gate } from './base.js';
import { Failure, Config, Report, Status, Severity, Provenance, SEVERITY_WEIGHTS } from '../types/index.js';
import { FileGate } from './file.js';
import { ContentGate } from './content.js';
import { StructureGate } from './structure.js';
import { ASTGate } from './ast.js';
import { FileGuardGate } from './safety.js';
import { DependencyGate } from './dependency.js';
import { CoverageGate } from './coverage.js';
import { ContextGate } from './context.js';
import { ContextEngine } from '../services/context-engine.js';
import { EnvironmentGate } from './environment.js';
import { RetryLoopBreakerGate } from './retry-loop-breaker.js';
import { AgentTeamGate } from './agent-team.js';
import { CheckpointGate } from './checkpoint.js';
import { SecurityPatternsGate } from './security-patterns.js';
import { DuplicationDriftGate } from './duplication-drift.js';
import { HallucinatedImportsGate } from './hallucinated-imports.js';
import { InconsistentErrorHandlingGate } from './inconsistent-error-handling.js';
import { ContextWindowArtifactsGate } from './context-window-artifacts.js';
import { PromiseSafetyGate } from './promise-safety.js';
import { execa } from 'execa';
import { Logger } from '../utils/logger.js';

export class GateRunner {
    private gates: Gate[] = [];

    constructor(private config: Config) {
        this.initializeGates();
    }

    private initializeGates() {
        // Retry Loop Breaker Gate - HIGHEST PRIORITY (runs first)
        if (this.config.gates.retry_loop_breaker?.enabled !== false) {
            this.gates.push(new RetryLoopBreakerGate(this.config.gates.retry_loop_breaker));
        }

        if (this.config.gates.max_file_lines) {
            this.gates.push(new FileGate({ maxLines: this.config.gates.max_file_lines }));
        }
        this.gates.push(
            new ContentGate({
                forbidTodos: !!this.config.gates.forbid_todos,
                forbidFixme: !!this.config.gates.forbid_fixme,
            })
        );
        if (this.config.gates.required_files) {
            this.gates.push(new StructureGate({ requiredFiles: this.config.gates.required_files }));
        }
        this.gates.push(new ASTGate(this.config.gates));
        this.gates.push(new DependencyGate(this.config));
        this.gates.push(new FileGuardGate(this.config.gates));
        this.gates.push(new CoverageGate(this.config.gates));

        if (this.config.gates.context?.enabled) {
            this.gates.push(new ContextGate(this.config.gates));
        }

        // Agent Team Governance Gate (for Opus 4.6 / GPT-5.3 multi-agent workflows)
        if (this.config.gates.agent_team?.enabled) {
            this.gates.push(new AgentTeamGate(this.config.gates.agent_team));
        }

        // Checkpoint Supervision Gate (for long-running GPT-5.3 coworking mode)
        if (this.config.gates.checkpoint?.enabled) {
            this.gates.push(new CheckpointGate(this.config.gates.checkpoint));
        }

        // Security Patterns Gate (code-level vulnerability detection) — enabled by default since v2.15
        if (this.config.gates.security?.enabled !== false) {
            this.gates.push(new SecurityPatternsGate(this.config.gates.security));
        }

        // v2.16+ AI-Native Drift Detection Gates (enabled by default)
        if (this.config.gates.duplication_drift?.enabled !== false) {
            this.gates.push(new DuplicationDriftGate(this.config.gates.duplication_drift));
        }

        if (this.config.gates.hallucinated_imports?.enabled !== false) {
            this.gates.push(new HallucinatedImportsGate(this.config.gates.hallucinated_imports));
        }

        if (this.config.gates.inconsistent_error_handling?.enabled !== false) {
            this.gates.push(new InconsistentErrorHandlingGate(this.config.gates.inconsistent_error_handling));
        }

        if (this.config.gates.context_window_artifacts?.enabled !== false) {
            this.gates.push(new ContextWindowArtifactsGate(this.config.gates.context_window_artifacts));
        }

        // v2.17+ Promise Safety Gate (async/promise AI failure modes)
        if (this.config.gates.promise_safety?.enabled !== false) {
            this.gates.push(new PromiseSafetyGate(this.config.gates.promise_safety));
        }

        // Environment Alignment Gate (Should be prioritized)
        if (this.config.gates.environment?.enabled) {
            this.gates.unshift(new EnvironmentGate(this.config.gates));
        }
    }

    /**
     * Allows adding custom gates dynamically (SOLID - Open/Closed Principle)
     */
    addGate(gate: Gate) {
        this.gates.push(gate);
    }

    async run(cwd: string, patterns?: string[]): Promise<Report> {
        const start = Date.now();
        const failures: Failure[] = [];
        const summary: Record<string, Status> = {};

        const ignore = this.config.ignore;

        // 0. Run Context Discovery
        let record;
        if (this.config.gates.context?.enabled) {
            const engine = new ContextEngine(this.config);
            record = await engine.discover(cwd);
        }

        // 1. Run internal gates
        for (const gate of this.gates) {
            try {
                const gateFailures = await gate.run({ cwd, record, ignore, patterns });
                if (gateFailures.length > 0) {
                    failures.push(...gateFailures);
                    summary[gate.id] = 'FAIL';
                } else {
                    summary[gate.id] = 'PASS';
                }
            } catch (error: any) {
                Logger.error(`Gate ${gate.id} failed with error: ${error.message}`);
                summary[gate.id] = 'ERROR';
                failures.push({
                    id: gate.id,
                    title: `Gate Error: ${gate.title}`,
                    details: error.message,
                    severity: 'medium',
                    provenance: 'traditional',
                    hint: 'There was an internal error running this gate. Check the logs.',
                });
            }
        }

        // 2. Run command gates (lint, test, etc.)
        const commands = this.config.commands;
        if (commands) {
            for (const [key, cmd] of Object.entries(commands)) {
                if (!cmd) {
                    summary[key] = 'SKIP';
                    continue;
                }

                try {
                    Logger.info(`Running command gate: ${key} (${cmd})`);
                    await execa(cmd, { shell: true, cwd });
                    summary[key] = 'PASS';
                } catch (error: any) {
                    summary[key] = 'FAIL';
                    failures.push({
                        id: key,
                        title: `${key.toUpperCase()} Check Failed`,
                        details: error.stderr || error.stdout || error.message,
                        severity: 'medium',
                        provenance: 'traditional',
                        hint: `Fix the issues reported by \`${cmd}\`. Use rigorous standards (SOLID, DRY) in your resolution.`,
                    });
                }
            }
        }

        const status: Status = failures.length > 0 ? 'FAIL' : 'PASS';

        // Severity-weighted scoring: each failure deducts based on its severity
        const severityBreakdown: Record<string, number> = {};
        let totalDeduction = 0;
        for (const f of failures) {
            const sev = (f.severity || 'medium') as Severity;
            severityBreakdown[sev] = (severityBreakdown[sev] || 0) + 1;
            totalDeduction += SEVERITY_WEIGHTS[sev] ?? 5;
        }
        const score = Math.max(0, 100 - totalDeduction);

        // Two-score system: separate AI health from structural quality
        // IMPORTANT: Only ai-drift affects ai_health_score, only traditional affects structural_score.
        // Security and governance affect the overall score but NOT the sub-scores,
        // preventing security criticals from incorrectly zeroing structural_score.
        let aiDeduction = 0;
        let structuralDeduction = 0;
        const provenanceCounts = {
            'ai-drift': 0,
            'traditional': 0,
            'security': 0,
            'governance': 0,
        };
        for (const f of failures) {
            const sev = (f.severity || 'medium') as Severity;
            const weight = SEVERITY_WEIGHTS[sev] ?? 5;
            const prov = f.provenance || 'traditional';
            provenanceCounts[prov] = (provenanceCounts[prov] || 0) + 1;

            switch (prov) {
                case 'ai-drift':
                    aiDeduction += weight;
                    break;
                case 'traditional':
                    structuralDeduction += weight;
                    break;
                // security and governance contribute to overall score (totalDeduction)
                // but do NOT pollute the sub-scores
                case 'security':
                case 'governance':
                    break;
            }
        }

        return {
            status,
            summary,
            failures,
            stats: {
                duration_ms: Date.now() - start,
                score,
                ai_health_score: Math.max(0, 100 - aiDeduction),
                structural_score: Math.max(0, 100 - structuralDeduction),
                severity_breakdown: severityBreakdown,
                provenance_breakdown: provenanceCounts,
            },
        };
    }
}
