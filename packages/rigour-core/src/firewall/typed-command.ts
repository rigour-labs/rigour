/**
 * Typed / argv-allowlisted command runner.
 * Replaces unrestricted shell:true for agent-facing execution.
 */

import { execa } from 'execa';
import type { PolicyEvaluation, TypedCommand } from './types.js';
import { hashPolicy } from './policy-hash.js';

/**
 * Conservative allowlist — no general interpreters (node/python/npx) that accept -e/-c.
 */
export const DEFAULT_ALLOWED_BINS = new Set([
    'npm',
    'pnpm',
    'yarn',
    'tsc',
    'vitest',
    'jest',
    'pytest',
    'go',
    'cargo',
    'git',
    'rigour',
    'echo',
    'cat',
    'ls',
    'pwd',
    'true',
    'false',
]);

const DENY_ARG_PATTERNS: RegExp[] = [
    /rm\s+-rf/i,
    /--force/i,
    /push\s+--force/i,
    /force-with-lease/i,
    /curl.*(-d|--data)/i,
    /wget\s/i,
    /(^|\s)-e(\s|=|$)/,
    /(^|\s)--eval(\s|=|$)/,
    /\bnpm\s+exec\b/i,
    /\bnpx\b/i,
    /\byarn\s+dlx\b/i,
    /\bpnpm\s+dlx\b/i,
];

const GIT_DENY_SUBCOMMANDS = new Set(['push', 'reset', 'clean', 'rebase', 'filter-branch']);

export function parseCommandLine(command: string): TypedCommand | null {
    const trimmed = command.trim();
    if (!trimmed) return null;
    if (/[;|&`$<>]/.test(trimmed) || trimmed.includes('\n')) {
        return null;
    }
    const parts = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
    if (!parts || parts.length === 0) return null;
    const unquote = (s: string) => {
        if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
            return s.slice(1, -1);
        }
        return s;
    };
    const [bin, ...args] = parts.map(unquote);
    return { bin, args };
}

export function evaluateTypedCommand(
    command: string,
    allowedBins: Set<string> = DEFAULT_ALLOWED_BINS,
): PolicyEvaluation {
    const policyHash = hashPolicy({ allowedBins: [...allowedBins].sort() });
    const parsed = parseCommandLine(command);
    if (!parsed) {
        return {
            decision: 'deny',
            reason: 'Command contains shell metacharacters or could not be parsed as argv',
            ruleId: 'shell.no-meta',
            policyHash,
            timestamp: new Date().toISOString(),
        };
    }

    const binBase = parsed.bin.split(/[/\\]/).pop() || parsed.bin;
    if (!allowedBins.has(binBase) && !allowedBins.has(parsed.bin)) {
        return {
            decision: 'deny',
            reason: `Binary "${binBase}" is not on the allowlist`,
            ruleId: 'shell.allowlist',
            policyHash,
            timestamp: new Date().toISOString(),
        };
    }

    const full = `${parsed.bin} ${parsed.args.join(' ')}`;
    for (const re of DENY_ARG_PATTERNS) {
        if (re.test(full)) {
            return {
                decision: 'deny',
                reason: `Command matched deny pattern: ${re}`,
                ruleId: 'shell.deny-pattern',
                policyHash,
                timestamp: new Date().toISOString(),
            };
        }
    }

    if (binBase === 'git') {
        const sub = parsed.args.find(a => !a.startsWith('-'));
        if (sub && GIT_DENY_SUBCOMMANDS.has(sub)) {
            return {
                decision: 'deny',
                reason: `git ${sub} requires explicit capability (destructive git mutation)`,
                ruleId: 'git.destructive',
                policyHash,
                timestamp: new Date().toISOString(),
            };
        }
    }

    return {
        decision: 'allow',
        reason: `Allowlisted binary ${binBase}`,
        ruleId: 'shell.allow',
        policyHash,
        timestamp: new Date().toISOString(),
    };
}

export async function runTypedCommand(
    command: string,
    cwd: string,
    allowedBins?: Set<string>,
): Promise<{ stdout: string; stderr: string; evaluation: PolicyEvaluation }> {
    const evaluation = evaluateTypedCommand(command, allowedBins);
    if (evaluation.decision !== 'allow') {
        throw Object.assign(new Error(evaluation.reason), { evaluation, code: 'FIREWALL_DENY' });
    }
    const parsed = parseCommandLine(command)!;
    const { stdout, stderr } = await execa(parsed.bin, parsed.args, {
        cwd,
        shell: false,
        reject: false,
    });
    return { stdout: stdout ?? '', stderr: stderr ?? '', evaluation };
}
