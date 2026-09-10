export type AgentEventOutcome = 'success' | 'error' | 'rejected' | 'unknown';

export interface AgentGuidance {
    kind: 'context-scope' | 'pattern' | 'memory';
    recommendation: string;
    patternRefs: Array<{ id: string; label: string; file?: string }>;
    lessonRefs: Array<{ id: string; label: string; visibility?: string }>;
    memoryRefs: Array<{ id: string; label: string }>;
    selectedFiles: string[];
    excludedFileCount: number;
    conflicts: number;
}

export interface AgentImpact {
    guidanceCount: number;
    knowledgeItems: number;
    candidateTokens: number;
    returnedTokens: number;
    avoidedTokens: number;
    candidateFiles: number;
    returnedFiles: number;
    excludedFiles: number;
    cacheHits: number;
    recommendations: string[];
}

export interface AgentHistoryEvent {
    id: string;
    timestamp: string;
    type: string;
    agentId: string;
    taskId?: string;
    sessionId?: string;
    requestId?: string;
    tool?: string;
    outcome: AgentEventOutcome;
    files: string[];
    summary: string;
    guidance?: AgentGuidance;
    telemetry?: {
        candidateTokens: number;
        returnedTokens: number;
        candidateFiles: number;
        returnedFiles: number;
        cacheStatus: string;
        classification: 'observed' | 'measured estimate' | 'modelled estimate';
    };
}

export interface AgentRun {
    id: string;
    agentId: string;
    taskId?: string;
    sessionId?: string;
    startedAt: string;
    endedAt: string;
    status: AgentEventOutcome | 'active';
    eventCount: number;
    files: string[];
    tools: string[];
    impact?: AgentImpact;
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function validDate(value: unknown): string {
    const candidate = text(value);
    return candidate && !Number.isNaN(Date.parse(candidate)) ? candidate : new Date(0).toISOString();
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function number(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function refs(value: unknown): Array<{ id: string; label: string; file?: string; visibility?: string }> {
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const record = item as Record<string, unknown>;
        const id = text(record.id);
        const label = text(record.label);
        return id && label ? [{ id, label, file: text(record.file), visibility: text(record.visibility) }] : [];
    });
}

function eventGuidance(event: Record<string, unknown>): AgentGuidance | undefined {
    const value = event.guidance ?? event._guidance;
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    const recommendation = text(record.recommendation);
    const kind = text(record.kind);
    if (!recommendation || !['context-scope', 'pattern', 'memory'].includes(kind ?? '')) return undefined;
    return {
        kind: kind as AgentGuidance['kind'],
        recommendation,
        patternRefs: refs(record.patternRefs),
        lessonRefs: refs(record.lessonRefs),
        memoryRefs: refs(record.memoryRefs),
        selectedFiles: strings(record.selectedFiles),
        excludedFileCount: number(record.excludedFileCount),
        conflicts: number(record.conflicts),
    };
}

function eventTelemetry(event: Record<string, unknown>): AgentHistoryEvent['telemetry'] {
    const value = event.telemetry ?? event._telemetry;
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    const classification = text(record.classification);
    return {
        candidateTokens: number(record.candidateTokens),
        returnedTokens: number(record.returnedTokens),
        candidateFiles: number(record.candidateFiles),
        returnedFiles: number(record.returnedFiles),
        cacheStatus: text(record.cacheStatus) ?? 'none',
        classification: classification === 'observed' || classification === 'modelled estimate'
            ? classification
            : 'measured estimate',
    };
}

function emptyImpact(): AgentImpact {
    return {
        guidanceCount: 0,
        knowledgeItems: 0,
        candidateTokens: 0,
        returnedTokens: 0,
        avoidedTokens: 0,
        candidateFiles: 0,
        returnedFiles: 0,
        excludedFiles: 0,
        cacheHits: 0,
        recommendations: [],
    };
}

function eventFiles(event: Record<string, unknown>): string[] {
    const args = event.arguments && typeof event.arguments === 'object' ? event.arguments as Record<string, unknown> : {};
    const report = event._rigour_report && typeof event._rigour_report === 'object'
        ? event._rigour_report as Record<string, unknown>
        : {};
    const failures = Array.isArray(report.failures) ? report.failures : [];
    const reported = failures.flatMap((failure) => failure && typeof failure === 'object'
        ? strings((failure as Record<string, unknown>).files)
        : []);
    return [...new Set([
        ...strings(event.files),
        ...strings(args.files),
        ...reported,
        text(event.file),
        text(event.path),
    ].filter((file): file is string => Boolean(file)))];
}

function eventOutcome(event: Record<string, unknown>): AgentEventOutcome {
    const value = String(event.outcome ?? event.status ?? '').toLowerCase();
    const type = String(event.type ?? '').toLowerCase();
    if (value.includes('reject') || type.includes('reject') || type.includes('deny')) return 'rejected';
    if (value.includes('error') || value.includes('fail') || type.includes('error') || type.includes('fail')) return 'error';
    if (value.includes('success') || value === 'pass' || type.includes('success') || type.includes('completed')) return 'success';
    return 'unknown';
}

export function normalizeAgentEvent(input: unknown, index = 0): AgentHistoryEvent {
    const event = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const type = text(event.type) ?? 'unknown';
    const tool = text(event.tool ?? event.toolName);
    const outcome = eventOutcome(event);
    const summary = text(event.summary ?? event.message ?? event.description)
        ?? `${tool ?? type}${outcome === 'unknown' ? '' : ` · ${outcome}`}`;
    return {
        id: text(event.id) ?? text(event.requestId) ?? `legacy-event-${index + 1}`,
        timestamp: validDate(event.timestamp ?? event.createdAt),
        type,
        agentId: text(event.agentId ?? event.agent_id) ?? 'unknown-agent',
        taskId: text(event.taskId ?? event.task_id),
        sessionId: text(event.sessionId ?? event.session_id),
        requestId: text(event.requestId ?? event.request_id),
        tool,
        outcome,
        files: eventFiles(event),
        summary,
        guidance: eventGuidance(event),
        telemetry: eventTelemetry(event),
    };
}

/**
 * Normalizes a page as a unit so a response inherits identity and scope from its
 * matching request. Older event logs often stored those fields only on tool_call.
 */
export function normalizeAgentEvents(inputs: unknown[]): AgentHistoryEvent[] {
    const requestContext = new Map<string, Record<string, unknown>>();
    for (const input of inputs) {
        const event = input && typeof input === 'object' ? input as Record<string, unknown> : {};
        const requestId = text(event.requestId ?? event.request_id);
        if (!requestId || String(event.type) !== 'tool_call') continue;
        const args = event.arguments && typeof event.arguments === 'object'
            ? event.arguments as Record<string, unknown>
            : {};
        requestContext.set(requestId, {
            agentId: event.agentId ?? event.agent_id ?? args.agentId ?? args.agent_id ?? args.agent
                ?? args.fromAgentId ?? args.toAgentId,
            taskId: event.taskId ?? event.task_id ?? args.taskId ?? args.task_id,
            sessionId: event.sessionId ?? event.session_id ?? args.sessionId ?? args.session_id,
            files: event.files ?? args.files ?? args.filesChanged ?? args.filesInScope,
        });
    }
    return inputs.map((input, index) => {
        const event = input && typeof input === 'object' ? input as Record<string, unknown> : {};
        const requestId = text(event.requestId ?? event.request_id);
        return normalizeAgentEvent(requestId ? { ...requestContext.get(requestId), ...event } : event, index);
    });
}

export function buildAgentRuns(events: AgentHistoryEvent[]): AgentRun[] {
    const runs = new Map<string, AgentRun>();
    for (const event of [...events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))) {
        const day = event.timestamp.slice(0, 10);
        const id = event.sessionId ?? event.taskId ?? event.requestId ?? `${event.agentId}:${day}`;
        const current = runs.get(id) ?? {
            id,
            agentId: event.agentId,
            taskId: event.taskId,
            sessionId: event.sessionId,
            startedAt: event.timestamp,
            endedAt: event.timestamp,
            status: 'active' as const,
            eventCount: 0,
            files: [],
            tools: [],
            impact: emptyImpact(),
        };
        current.endedAt = event.timestamp;
        current.eventCount++;
        current.files = [...new Set([...current.files, ...event.files])];
        if (event.tool) current.tools = [...new Set([...current.tools, event.tool])];
        if (event.guidance) {
            current.impact ??= emptyImpact();
            const telemetry = event.telemetry;
            current.impact.guidanceCount++;
            current.impact.knowledgeItems += event.guidance.patternRefs.length
                + event.guidance.lessonRefs.length
                + event.guidance.memoryRefs.length;
            current.impact.candidateTokens += telemetry?.candidateTokens ?? 0;
            current.impact.returnedTokens += telemetry?.returnedTokens ?? 0;
            current.impact.avoidedTokens += Math.max(0, (telemetry?.candidateTokens ?? 0) - (telemetry?.returnedTokens ?? 0));
            current.impact.candidateFiles += telemetry?.candidateFiles ?? 0;
            current.impact.returnedFiles += telemetry?.returnedFiles ?? 0;
            current.impact.excludedFiles += event.guidance.excludedFileCount;
            if (telemetry?.cacheStatus && !['none', 'miss'].includes(telemetry.cacheStatus)) current.impact.cacheHits++;
            current.impact.recommendations = [...new Set([...current.impact.recommendations, event.guidance.recommendation])];
        }
        if (event.outcome !== 'unknown') current.status = event.outcome;
        runs.set(id, current);
    }
    return [...runs.values()].sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt));
}
