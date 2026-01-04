import { Report, Failure, Config } from '../types/index.js';
import { FixPacketV2, FixPacketV2Schema } from '../types/fix-packet.js';

export class FixPacketService {
    generate(report: Report, config: Config): FixPacketV2 {
        const violations = report.failures.map(f => ({
            id: f.id,
            gate: f.id,
            severity: this.inferSeverity(f),
            title: f.title,
            details: f.details,
            files: f.files,
            hint: f.hint,
            instructions: f.hint ? [f.hint] : [], // Use hint as first instruction
            metrics: (f as any).metrics,
        }));

        const packet: FixPacketV2 = {
            version: 2,
            goal: "Achieve PASS state by resolving all listed engineering violations.",
            violations,
            constraints: {
                paradigm: config.paradigm,
                protected_paths: config.gates.safety?.protected_paths,
                do_not_touch: config.gates.safety?.protected_paths,
                max_files_changed: config.gates.safety?.max_files_changed_per_cycle,
                no_new_deps: true,
            },
        };

        return FixPacketV2Schema.parse(packet);
    }

    private inferSeverity(f: Failure): "low" | "medium" | "high" | "critical" {
        // High complexity or God objects are usually High severity
        if (f.id === 'ast-analysis') return 'high';
        // Unit test or Lint failures are Medium
        if (f.id === 'test' || f.id === 'lint') return 'medium';
        // Documentation or small file size issues are Low
        return 'medium';
    }
}
