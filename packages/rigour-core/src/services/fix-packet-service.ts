import { Report, Config, Failure } from '../types/index.js';
import { FixPacketV2, FixPacketV2Schema, ViolationLocation } from '../types/fix-packet.js';

export class FixPacketService {
    generate(report: Report, config: Config): FixPacketV2 {
        const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

        // Deduplicate failed gate IDs
        const failedGates = [...new Set(report.failures.map(f => f.id))];

        const violations = report.failures
            .map(f => ({
                id: f.id,
                gate: f.id,
                severity: (f.severity || 'medium') as 'info' | 'low' | 'medium' | 'high' | 'critical',
                category: f.provenance,
                title: f.title,
                details: f.details,
                files: f.files,
                locations: buildLocations(f),
                hint: f.hint,
                instructions: buildInstructions(f),
                metrics: (f as any).metrics,
            }))
            .sort((a, b) => (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2));

        // Build verification commands from config.commands
        const verification = buildVerification(config);

        // Build allowed scope from violation files (what the agent should touch)
        const violationFiles = violations.flatMap(v => v.files || []);
        const uniqueFiles = [...new Set(violationFiles.map(f => {
            // Strip metadata like "(600 lines)" from file paths
            const clean = f.replace(/\s*\(.*?\)\s*$/, '').trim();
            return clean;
        }))];

        const packet: FixPacketV2 = {
            version: 3,
            goal: "Achieve PASS state by resolving all listed engineering violations.",
            failed_gates: failedGates,
            violations,
            verification,
            constraints: {
                paradigm: config.paradigm,
                protected_paths: config.gates.safety?.protected_paths,
                do_not_touch: config.gates.safety?.protected_paths,
                allowed_scope: uniqueFiles.length > 0 ? uniqueFiles : undefined,
                max_files_changed: config.gates.safety?.max_files_changed_per_cycle,
                no_new_deps: true,
            },
        };

        return FixPacketV2Schema.parse(packet);
    }
}

/**
 * Build precise locations from failure's files + line numbers.
 * If failure has both files[] and line/endLine, create a location per file.
 * If only files[], locations are file-level (no line numbers).
 */
function buildLocations(f: Failure): ViolationLocation[] | undefined {
    if (!f.files || f.files.length === 0) return undefined;

    return f.files.map(file => {
        const loc: ViolationLocation = {
            file: file.replace(/\s*\(.*?\)\s*$/, '').trim(),
        };
        // If the failure has line numbers and there's only one file, attach them
        if (f.files!.length === 1) {
            if (f.line) loc.line = f.line;
            if (f.endLine) loc.endLine = f.endLine;
        }
        return loc;
    });
}

/**
 * Build step-by-step instructions from the hint and failure context.
 */
function buildInstructions(f: Failure): string[] {
    const steps: string[] = [];
    if (f.hint) steps.push(f.hint);

    // Add gate-specific guidance
    switch (f.id) {
        case 'file-size':
            steps.push('Break the file into smaller modules following Single Responsibility Principle');
            break;
        case 'hallucinated-imports':
            steps.push('Remove or replace the non-existent import with a real package');
            break;
        case 'phantom-apis':
            steps.push('Check the actual API surface of the module and use a real method');
            break;
        case 'forbid-todos':
            steps.push('Resolve the TODO/FIXME comment or remove it if no longer relevant');
            break;
        case 'security-patterns':
            steps.push('Apply the security fix described above. Do NOT suppress the warning.');
            break;
        case 'promise-safety':
            steps.push('Add proper error handling (try/catch or .catch()) to async operations');
            break;
        case 'deprecated-apis':
            steps.push('Replace deprecated API usage with the recommended modern alternative');
            break;
        case 'duplication-drift':
            steps.push('Extract the duplicated logic into a shared utility or module');
            break;
        case 'inconsistent-error-handling':
            steps.push('Align error handling strategy across the module');
            break;
    }

    return steps.length > 0 ? steps : [];
}

/**
 * Build verification block from config.commands.
 * These are the commands the agent MUST run after fixing to prove the fix works.
 */
function buildVerification(config: Config): { commands: { cmd: string; purpose: string }[]; gate_command: string } {
    const commands: { cmd: string; purpose: string }[] = [];

    if (config.commands?.typecheck) {
        commands.push({ cmd: config.commands.typecheck, purpose: 'Ensure no type errors after changes' });
    }
    if (config.commands?.lint) {
        commands.push({ cmd: config.commands.lint, purpose: 'Ensure no lint violations' });
    }
    if (config.commands?.test) {
        commands.push({ cmd: config.commands.test, purpose: 'Ensure all tests pass' });
    }
    if (config.commands?.format) {
        commands.push({ cmd: config.commands.format, purpose: 'Ensure code formatting is correct' });
    }

    // Always end with rigour check
    commands.push({ cmd: 'rigour_check', purpose: 'Re-run all quality gates to confirm PASS' });

    return { commands, gate_command: 'rigour_check' };
}
