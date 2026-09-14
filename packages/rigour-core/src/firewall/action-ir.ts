import type { AgentAction } from './types.js';

const DESTRUCTIVE_WORDS = /(?:^|[_./-])(delete|destroy|drop|purge|remove|terminate|merge)(?:$|[_./-])/i;
const WRITE_WORDS = /(?:^|[_./-])(create|update|write|post|put|patch|send|deploy|restart|apply)(?:$|[_./-])/i;
const READ_WORDS = /(?:^|[_./-])(get|list|read|search|find|fetch|view|status)(?:$|[_./-])/i;

function classifyEnvironment(resource: string, args: Record<string, unknown>): AgentAction['environment'] {
    const text = `${resource} ${JSON.stringify(args)}`.toLowerCase();
    if (/\b(prod|production)\b/.test(text)) return 'production';
    if (/\b(stage|staging|preprod)\b/.test(text)) return 'staging';
    if (/\b(dev|development)\b/.test(text)) return 'development';
    if (/\b(local|localhost|127\.0\.0\.1)\b/.test(text)) return 'local';
    return 'unknown';
}

function classifySideEffect(tool: string): AgentAction['sideEffect'] {
    if (DESTRUCTIVE_WORDS.test(tool)) return 'destructive';
    if (WRITE_WORDS.test(tool)) return 'external-write';
    if (READ_WORDS.test(tool)) return 'read';
    return 'external-write';
}

export function normalizeMcpAction(input: {
    actorId: string;
    taskId: string;
    server: string;
    tool: string;
    args?: Record<string, unknown>;
}): AgentAction {
    const args = input.args ?? {};
    const resource = `mcp://${input.server}/${input.tool}`;
    const sideEffect = classifySideEffect(input.tool);
    return {
        version: 1,
        actorId: input.actorId,
        taskId: input.taskId,
        channel: 'mcp',
        operation: input.tool,
        resource,
        environment: classifyEnvironment(resource, args),
        sideEffect,
        reversibility: sideEffect === 'read' ? 'high' : sideEffect === 'destructive' ? 'low' : 'unknown',
        sensitivity: /secret|credential|token|password|private/i.test(`${input.tool} ${JSON.stringify(args)}`)
            ? 'restricted'
            : 'normal',
        blastRadius: sideEffect === 'read' ? 'single-resource' : sideEffect === 'destructive' ? 'broad' : 'unknown',
    };
}
