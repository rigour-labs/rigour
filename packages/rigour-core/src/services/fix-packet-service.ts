import { Report, Config } from '../types/index.js';
import { FixPacketV2, FixPacketV2Schema } from '../types/fix-packet.js';

export class FixPacketService {
    generate(report: Report, config: Config): FixPacketV2 {
        // Sort violations: critical first, then high, medium, low, info
        const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

        const violations = report.failures
            .map(f => ({
                id: f.id,
                gate: f.id,
                severity: (f.severity || 'medium') as 'info' | 'low' | 'medium' | 'high' | 'critical',
                category: f.provenance,
                title: f.title,
                details: f.details,
                files: f.files,
                hint: f.hint,
                instructions: f.hint ? [f.hint] : [],
                metrics: (f as any).metrics,
            }))
            .sort((a, b) => (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2));

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
}
