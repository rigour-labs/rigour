import type { FixPacketV2, Report } from '@rigour-labs/core';

export const DEFAULT_FIX_PACKET_PAGE_SIZE = 5;
export const MAX_FIX_PACKET_PAGE_SIZE = 10;

const MAX_ITEM_CHARS = 1_600;

function clip(value: unknown, max: number): string {
    const text = String(value ?? '');
    return text.length <= max ? text : `${text.slice(0, max - 16)}... [truncated]`;
}

function formatViolation(violation: FixPacketV2['violations'][number], index: number, total: number): string {
    const lines = [
        `━━━ FIX ${index + 1}/${total}: [${violation.severity.toUpperCase()}] ${clip(violation.title, 180)} ━━━`,
        `GATE: ${clip(violation.id, 100)}`,
        `PROBLEM: ${clip(violation.details, 600)}`,
    ];

    const locations = violation.locations ?? [];
    if (locations.length > 0) {
        const shown = locations.slice(0, 5).map(loc =>
            `${clip(loc.file, 160)}${loc.line ? `:${loc.line}` : ''}${loc.endLine && loc.endLine !== loc.line ? `-${loc.endLine}` : ''}`
        );
        lines.push(`WHERE: ${shown.join(', ')}${locations.length > 5 ? ` (+${locations.length - 5} more locations)` : ''}`);
    } else if (violation.files?.length) {
        lines.push(`FILES: ${violation.files.slice(0, 5).map(file => clip(file, 160)).join(', ')}`);
    }

    if (violation.instructions?.length) {
        lines.push('FIX:');
        for (const [step, instruction] of violation.instructions.slice(0, 3).entries()) {
            lines.push(`  ${step + 1}. ${clip(instruction, 260)}`);
        }
    } else if (violation.hint) {
        lines.push(`HINT: ${clip(violation.hint, 300)}`);
    }

    return clip(lines.join('\n'), MAX_ITEM_CHARS);
}

export function formatFixPacketPage(
    packet: FixPacketV2,
    report: Report,
    offset: number,
    limit: number,
): string {
    const total = packet.violations.length;
    const start = Math.min(offset, total);
    const end = Math.min(start + limit, total);
    const lines = [
        'ENGINEERING REFINEMENT REQUIRED',
        `Score: ${report.stats.score ?? 'unknown'}/100 | Violations: ${total}`,
        `Failed gates: ${clip(packet.failed_gates.join(', '), 900)}`,
        `Page: ${start}-${end} of ${total}`,
        `next_offset: ${end < total ? end : 'none'}`,
        '',
    ];

    for (let index = start; index < end; index++) {
        lines.push(formatViolation(packet.violations[index], index, total), '');
    }

    if (packet.verification?.commands?.length) {
        lines.push('VERIFICATION:');
        for (const command of packet.verification.commands.slice(0, 5)) {
            lines.push(`  $ ${clip(command.cmd, 180)} — ${clip(command.purpose, 120)}`);
        }
    }

    if (packet.constraints?.do_not_touch?.length) {
        lines.push(`DO NOT TOUCH: ${clip(packet.constraints.do_not_touch.join(', '), 600)}`);
    }
    if (packet.constraints?.allowed_scope?.length) {
        lines.push(`Allowed scope: ${packet.constraints.allowed_scope.length} file(s); see individual locations above.`);
    }

    lines.push(end < total
        ? `More violations remain. Call rigour_get_fix_packet with offset=${end} and limit=${limit}.`
        : 'End of Fix Packet. Re-run rigour_check after repairs; report PASS only after verification.');
    return lines.join('\n');
}
