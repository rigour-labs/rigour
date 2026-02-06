import { Gate } from './base.js';
import { Failure, Config, Report, Status } from '../types/index.js';
import { FileGate } from './file.js';
import { ContentGate } from './content.js';
import { StructureGate } from './structure.js';
import { ASTGate } from './ast.js';
import { SafetyGate } from './safety.js';
import { DependencyGate } from './dependency.js';
import { CoverageGate } from './coverage.js';
import { ContextGate } from './context.js';
import { ContextEngine } from '../services/context-engine.js';
import { EnvironmentGate } from './environment.js';
import { RetryLoopBreakerGate } from './retry-loop-breaker.js';
import { AgentTeamGate } from './agent-team.js';
import { CheckpointGate } from './checkpoint.js';
import { SecurityPatternsGate } from './security-patterns.js';
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
        this.gates.push(new SafetyGate(this.config.gates));
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

        // Security Patterns Gate (code-level vulnerability detection)
        if (this.config.gates.security?.enabled) {
            this.gates.push(new SecurityPatternsGate(this.config.gates.security));
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
                        hint: `Fix the issues reported by \`${cmd}\`. Use rigorous standards (SOLID, DRY) in your resolution.`,
                    });
                }
            }
        }

        const status: Status = failures.length > 0 ? 'FAIL' : 'PASS';
        const score = Math.max(0, 100 - (failures.length * 5)); // Basic SME scoring logic

        return {
            status,
            summary,
            failures,
            stats: {
                duration_ms: Date.now() - start,
                score,
            },
        };
    }
}
