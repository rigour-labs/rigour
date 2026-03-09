import { Gate } from './base.js';
import { Failure, Config, Report, Status, Severity, Provenance, SEVERITY_WEIGHTS, DeepOptions } from '../types/index.js';
import { DeepAnalysisGate } from './deep-analysis.js';
import { persistAndReinforce } from '../storage/local-memory.js';
import { recordGateRun, type ProvenanceRunData } from '../services/adaptive-thresholds.js';
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
import { FrontendSecretExposureGate } from './frontend-secret-exposure.js';
import { DuplicationDriftGate } from './duplication-drift/index.js';
import { HallucinatedImportsGate } from './hallucinated-imports/index.js';
import { InconsistentErrorHandlingGate } from './inconsistent-error-handling.js';
import { ContextWindowArtifactsGate } from './context-window-artifacts.js';
import { PromiseSafetyGate } from './promise-safety.js';
import { PhantomApisGate } from './phantom-apis.js';
import { DeprecatedApisGate } from './deprecated-apis.js';
import { TestQualityGate } from './test-quality.js';
import { SideEffectAnalysisGate } from './side-effect-analysis/index.js';
import { StyleDriftGate } from './style-drift.js';
import { LogicDriftGate } from './logic-drift.js';
import { execa } from 'execa';
import { Logger } from '../utils/logger.js';
import { FileSystemCache } from '../services/filesystem-cache.js';

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

        if (this.config.gates.frontend_secret_exposure?.enabled !== false) {
            this.gates.push(new FrontendSecretExposureGate(this.config.gates.frontend_secret_exposure));
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

        // v3.1+ Extended Hallucination Detection
        if (this.config.gates.phantom_apis?.enabled !== false) {
            this.gates.push(new PhantomApisGate(this.config.gates.phantom_apis));
        }

        if (this.config.gates.deprecated_apis?.enabled !== false) {
            this.gates.push(new DeprecatedApisGate(this.config.gates.deprecated_apis));
        }

        if (this.config.gates.test_quality?.enabled !== false) {
            this.gates.push(new TestQualityGate(this.config.gates.test_quality));
        }

        // v4.3+ Side-Effect Safety Analysis (enabled by default)
        if (this.config.gates.side_effect_analysis?.enabled !== false) {
            this.gates.push(new SideEffectAnalysisGate(this.config.gates.side_effect_analysis));
        }

        // v5.0+ Style Drift Detection (enabled by default)
        if (this.config.gates.style_drift?.enabled !== false) {
            this.gates.push(new StyleDriftGate(this.config.gates.style_drift));
        }

        // v5.0+ Logic Drift Foundation (enabled by default)
        if (this.config.gates.logic_drift?.enabled !== false) {
            this.gates.push(new LogicDriftGate(this.config.gates.logic_drift));
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

    async run(cwd: string, patterns?: string[], deepOptions?: DeepOptions & { onProgress?: (msg: string) => void }): Promise<Report> {
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

        // Create shared file cache for all gates (solves memory bloat on large repos)
        const fileCache = new FileSystemCache();

        // 1. Run internal gates
        for (const gate of this.gates) {
            try {
                const gateFailures = await gate.run({ cwd, record, ignore, patterns, fileCache });
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

        // 3. Run Deep Analysis (if enabled)
        let deepStats: Report['stats']['deep'] = undefined;
        if (deepOptions?.enabled) {
            const deepSetupStart = Date.now();
            const deepGate = new DeepAnalysisGate({
                options: deepOptions,
                checks: this.config.gates.deep?.checks,
                threads: this.config.gates.deep?.threads,
                maxTokens: this.config.gates.deep?.max_tokens,
                temperature: this.config.gates.deep?.temperature,
                timeoutMs: this.config.gates.deep?.timeout_ms,
                onProgress: deepOptions.onProgress,
            });

            try {
                const deepFailures = await deepGate.run({ cwd, ignore, patterns });
                if (deepFailures.length > 0) {
                    failures.push(...deepFailures);
                    summary['deep-analysis'] = 'FAIL';
                } else {
                    summary['deep-analysis'] = 'PASS';
                }

                const isLocalDeepExecution =
                    !deepOptions.apiKey || (deepOptions.provider || '').toLowerCase() === 'local';
                const deepTier: 'deep' | 'lite' | 'cloud' = isLocalDeepExecution
                    ? (deepOptions.pro ? 'deep' : 'lite')
                    : 'cloud';

                deepStats = {
                    enabled: true,
                    tier: deepTier,
                    model: isLocalDeepExecution
                        ? (deepOptions.pro ? 'Qwen2.5-Coder-1.5B' : 'Qwen3.5-0.8B')
                        : (deepOptions.modelName || deepOptions.provider || 'cloud'),
                    total_ms: Date.now() - deepSetupStart,
                    findings_count: deepFailures.length,
                    findings_verified: deepFailures.filter((f: any) => f.verified).length,
                };
            } catch (error: any) {
                Logger.error(`Deep analysis failed: ${error.message}`);
                summary['deep-analysis'] = 'ERROR';
                deepStats = { enabled: true };
            }
        }

        const status: Status = failures.length > 0 ? 'FAIL' : 'PASS';

        // Severity-weighted scoring with per-gate cap and deduplication
        // Step 1: Deduplicate — same file + line + gate should not stack
        const deduped: Failure[] = [];
        const seen = new Set<string>();
        for (const f of failures) {
            const key = `${f.id}:${(f.files || []).join(',')}:${f.line || 0}`;
            if (!seen.has(key)) {
                seen.add(key);
                deduped.push(f);
            }
        }
        // Replace failures array with deduplicated version
        failures.length = 0;
        failures.push(...deduped);

        // Step 2: Calculate per-gate deductions with cap
        const PER_GATE_CAP = 30; // No single gate can deduct more than 30 points
        const severityBreakdown: Record<string, number> = {};
        const gateDeductions = new Map<string, number>();
        for (const f of failures) {
            const sev = (f.severity || 'medium') as Severity;
            severityBreakdown[sev] = (severityBreakdown[sev] || 0) + 1;
            const weight = SEVERITY_WEIGHTS[sev] ?? 5;
            const gateId = f.id || 'unknown';
            gateDeductions.set(gateId, (gateDeductions.get(gateId) || 0) + weight);
        }

        // Step 3: Apply cap per gate and sum
        let totalDeduction = 0;
        for (const [_gateId, deduction] of gateDeductions) {
            totalDeduction += Math.min(deduction, PER_GATE_CAP);
        }
        const score = Math.max(0, 100 - totalDeduction);

        // Two-score system: separate AI health from structural quality
        // IMPORTANT: Only ai-drift affects ai_health_score, only traditional affects structural_score.
        // Security and governance affect the overall score but NOT the sub-scores,
        // preventing security criticals from incorrectly zeroing structural_score.
        // Per-gate caps applied to sub-scores too for fairness.
        const aiGateDeductions = new Map<string, number>();
        const structuralGateDeductions = new Map<string, number>();
        const deepGateDeductions = new Map<string, number>();
        const provenanceCounts = {
            'ai-drift': 0,
            'traditional': 0,
            'security': 0,
            'governance': 0,
            'deep-analysis': 0,
        };
        for (const f of failures) {
            const sev = (f.severity || 'medium') as Severity;
            const weight = SEVERITY_WEIGHTS[sev] ?? 5;
            const prov = f.provenance || 'traditional';
            const gateId = f.id || 'unknown';
            provenanceCounts[prov] = (provenanceCounts[prov] || 0) + 1;

            switch (prov) {
                case 'ai-drift':
                    aiGateDeductions.set(gateId, (aiGateDeductions.get(gateId) || 0) + weight);
                    break;
                case 'traditional':
                    structuralGateDeductions.set(gateId, (structuralGateDeductions.get(gateId) || 0) + weight);
                    break;
                case 'deep-analysis':
                    deepGateDeductions.set(gateId, (deepGateDeductions.get(gateId) || 0) + weight);
                    break;
                case 'security':
                case 'governance':
                    break;
            }
        }

        // Apply per-gate cap to sub-scores
        let aiDeduction = 0;
        for (const [, d] of aiGateDeductions) aiDeduction += Math.min(d, PER_GATE_CAP);
        let structuralDeduction = 0;
        for (const [, d] of structuralGateDeductions) structuralDeduction += Math.min(d, PER_GATE_CAP);
        let deepDeduction = 0;
        for (const [, d] of deepGateDeductions) deepDeduction += Math.min(d, PER_GATE_CAP);

        // Persist findings + reinforce patterns in local SQLite (fire-and-forget)
        const report: Report = {
            status,
            summary,
            failures,
            stats: {
                duration_ms: Date.now() - start,
                score,
                ai_health_score: Math.max(0, 100 - aiDeduction),
                structural_score: Math.max(0, 100 - structuralDeduction),
                ...(deepOptions?.enabled ? { code_quality_score: Math.max(0, 100 - deepDeduction) } : {}),
                severity_breakdown: severityBreakdown,
                provenance_breakdown: provenanceCounts,
                ...(deepStats ? { deep: deepStats } : {}),
            },
        };

        // Store findings + reinforce patterns in local SQLite (non-blocking)
        persistAndReinforce(cwd, report, deepStats ? {
            deepTier: deepStats.tier,
            deepModel: deepStats.model,
        } : undefined).catch(() => {
            // Silent — local memory is advisory, never blocks scans
        });

        // v5: Record per-provenance data for adaptive thresholds + temporal drift
        try {
            const passedCount = Object.values(summary).filter(s => s === 'PASS').length;
            const failedCount = Object.values(summary).filter(s => s === 'FAIL').length;
            const provenanceData: ProvenanceRunData = {
                aiDriftFailures: provenanceCounts['ai-drift'],
                structuralFailures: provenanceCounts['traditional'],
                securityFailures: provenanceCounts['security'],
            };
            recordGateRun(cwd, passedCount, failedCount, failures.length, provenanceData);
        } catch {
            // Silent — adaptive history is advisory
        }

        return report;
    }
}
