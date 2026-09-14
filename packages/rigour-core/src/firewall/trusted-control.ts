import { createHash, randomUUID } from 'crypto';
import fs from 'fs-extra';
import type { FileHandle } from 'node:fs/promises';
import os from 'os';
import path from 'path';
import type { CapabilityAction, CapabilityGrant, EnforcementMode } from './types.js';
import { hashPolicy } from './policy-hash.js';

export interface GatewayServerConfig {
    command: string;
    args?: string[];
    allow: string[];
    env?: Record<string, string>;
}

export interface GatewayControlConfig {
    version: 1;
    mode: EnforcementMode;
    principalId: string;
    agentId: string;
    taskId: string;
    servers: Record<string, GatewayServerConfig>;
}

function canonicalRepository(cwd: string): string {
    try {
        return fs.realpathSync(cwd);
    } catch {
        return path.resolve(cwd);
    }
}

export function getRepositoryControlId(cwd: string): string {
    return createHash('sha256').update(canonicalRepository(cwd)).digest('hex').slice(0, 24);
}

export function getTrustedControlDir(cwd: string, controlRoot = path.join(os.homedir(), '.rigour', 'control')): string {
    return path.join(controlRoot, getRepositoryControlId(cwd));
}

export function getGatewayPolicyHash(cwd: string, config: GatewayControlConfig | null): string {
    return hashPolicy({ repositoryId: getRepositoryControlId(cwd), ...(config ?? {}) });
}

function requiredString(input: Record<string, unknown>, key: string): void {
    if (typeof input[key] !== 'string' || !String(input[key]).trim()) throw new Error(`${key} is required`);
}

function validateStringArray(value: unknown, label: string, required: boolean): void {
    if (value === undefined && !required) return;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
        throw new Error(`${label} must contain only non-empty strings`);
    }
}

function validateEnvironment(value: unknown, serverName: string): void {
    if (value === undefined) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Server ${serverName} env must be a string map`);
    }
    if (Object.values(value).some((item) => typeof item !== 'string')) {
        throw new Error(`Server ${serverName} env must be a string map`);
    }
}

function validateServer(name: string, server: GatewayServerConfig): void {
    if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error(`Invalid server name: ${name}`);
    if (!server || typeof server.command !== 'string' || !server.command.trim()) {
        throw new Error(`Server ${name} command is required`);
    }
    validateStringArray(server.args, `Server ${name} args`, false);
    validateStringArray(server.allow, `Server ${name} allow`, true);
    validateEnvironment(server.env, name);
}

function validateConfigHeader(input: Record<string, unknown>): void {
    if (input.version !== 1) throw new Error('Gateway config version must be 1');
    if (input.mode !== 'observe' && input.mode !== 'enforce') throw new Error('Gateway mode must be observe or enforce');
}

function validateConfigIdentities(input: Record<string, unknown>): void {
    for (const key of ['principalId', 'agentId', 'taskId']) requiredString(input, key);
}

function validateServers(input: Record<string, unknown>): void {
    if (!input.servers || typeof input.servers !== 'object') throw new Error('At least one downstream server is required');
    const servers = input.servers as Record<string, GatewayServerConfig>;
    if (Object.keys(servers).length === 0) throw new Error('At least one downstream server is required');
    for (const [name, server] of Object.entries(servers)) validateServer(name, server);
}

async function ensureTrustedDir(cwd: string, controlRoot?: string): Promise<string> {
    const dir = getTrustedControlDir(cwd, controlRoot);
    await fs.ensureDir(dir, 0o700);
    await fs.chmod(dir, 0o700).catch(() => undefined);
    return dir;
}

export function validateGatewayConfig(value: unknown): GatewayControlConfig {
    if (!value || typeof value !== 'object') throw new Error('Gateway config must be an object');
    const input = value as Record<string, unknown>;
    validateConfigHeader(input);
    validateConfigIdentities(input);
    validateServers(input);
    return input as unknown as GatewayControlConfig;
}

export async function saveGatewayConfig(cwd: string, config: GatewayControlConfig, controlRoot?: string): Promise<string> {
    const trusted = validateGatewayConfig(config);
    const dir = await ensureTrustedDir(cwd, controlRoot);
    const destination = path.join(dir, 'gateway.json');
    await fs.writeJson(destination, trusted, { spaces: 2, mode: 0o600 });
    await fs.chmod(destination, 0o600).catch(() => undefined);
    return destination;
}

export async function loadGatewayConfig(cwd: string, controlRoot?: string): Promise<GatewayControlConfig | null> {
    const source = path.join(getTrustedControlDir(cwd, controlRoot), 'gateway.json');
    if (!await fs.pathExists(source)) return null;
    return validateGatewayConfig(await fs.readJson(source));
}

interface GrantInput {
    issuerId: string;
    subjectId: string;
    taskId: string;
    action: CapabilityAction;
    resource: string;
    ttlMs: number;
    parentCapabilityId?: string;
}

function grantPath(cwd: string, id: string, controlRoot?: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        throw new Error('Invalid capability id');
    }
    return path.join(getTrustedControlDir(cwd, controlRoot), 'capabilities', `${id}.json`);
}

export async function loadTrustedGrant(cwd: string, id: string, controlRoot?: string): Promise<CapabilityGrant | null> {
    let source: string;
    try {
        source = grantPath(cwd, id, controlRoot);
    } catch {
        return null;
    }
    if (!await fs.pathExists(source)) return null;
    return fs.readJson(source) as Promise<CapabilityGrant>;
}

function assertDelegationSubset(parent: CapabilityGrant, input: GrantInput): void {
    if (parent.used) throw new Error('Parent capability is already consumed');
    if (Date.now() > parent.expiresAt) throw new Error('Parent capability is expired');
    if (parent.subjectId !== input.issuerId) throw new Error('Delegating issuer is not the parent subject');
    if (parent.taskId !== input.taskId) throw new Error('Child capability must preserve parent task');
    if (parent.action !== input.action || parent.resource !== input.resource) {
        throw new Error('Child capability must preserve parent action and resource');
    }
    if (Date.now() + input.ttlMs > parent.expiresAt) throw new Error('Child capability cannot outlive parent capability');
}

function validateGrantInput(input: GrantInput): void {
    if (!input.issuerId || !input.subjectId || !input.taskId || !input.resource) {
        throw new Error('Grant identity, task, and resource are required');
    }
    if (!Number.isFinite(input.ttlMs) || input.ttlMs < 1_000 || input.ttlMs > 3_600_000) {
        throw new Error('Grant TTL must be between 1 second and 1 hour');
    }
}

async function consumeParentGrant(cwd: string, input: GrantInput, controlRoot?: string): Promise<void> {
    if (!input.parentCapabilityId) return;
    const parent = await loadTrustedGrant(cwd, input.parentCapabilityId, controlRoot);
    if (!parent) throw new Error('Parent capability not found');
    assertDelegationSubset(parent, input);
    const consumed = await consumeTrustedGrant(cwd, {
        id: parent.id,
        subjectId: input.issuerId,
        taskId: input.taskId,
        action: input.action,
        resource: input.resource,
    }, controlRoot);
    if (!consumed.ok) throw new Error(`Parent capability could not be consumed: ${consumed.reason}`);
}

function validateGrantAgainstConfig(input: GrantInput, config: GatewayControlConfig | null): void {
    if (!config) return;
    if (input.subjectId !== config.agentId || input.taskId !== config.taskId) {
        throw new Error('Grant subject and task must match the trusted gateway configuration');
    }
    if (!input.parentCapabilityId && input.issuerId !== config.principalId) {
        throw new Error('Root capability issuer must match the trusted gateway principal');
    }
}

export async function issueTrustedGrant(cwd: string, input: GrantInput, controlRoot?: string): Promise<CapabilityGrant> {
    validateGrantInput(input);
    const config = await loadGatewayConfig(cwd, controlRoot);
    validateGrantAgainstConfig(input, config);
    await consumeParentGrant(cwd, input, controlRoot);
    const policyHash = getGatewayPolicyHash(cwd, config);
    const grant: CapabilityGrant = {
        id: randomUUID(),
        action: input.action,
        resource: input.resource,
        expiresAt: Date.now() + input.ttlMs,
        taskId: input.taskId,
        agentId: input.subjectId,
        issuerId: input.issuerId,
        subjectId: input.subjectId,
        parentCapabilityId: input.parentCapabilityId,
        policyHash,
        used: false,
    };
    const dir = path.dirname(grantPath(cwd, grant.id, controlRoot));
    await fs.ensureDir(dir, 0o700);
    await fs.writeJson(grantPath(cwd, grant.id, controlRoot), grant, { spaces: 2, mode: 0o600 });
    return grant;
}

export async function consumeTrustedGrant(cwd: string, input: {
    id: string;
    subjectId: string;
    taskId: string;
    action: CapabilityAction;
    resource: string;
}, controlRoot?: string): Promise<{ ok: boolean; reason: string; grant?: CapabilityGrant }> {
    let source: string;
    try {
        source = grantPath(cwd, input.id, controlRoot);
    } catch {
        return { ok: false, reason: 'Invalid capability id' };
    }
    const lock = `${source}.consume-lock`;
    let handle: FileHandle | undefined;
    try {
        await fs.ensureDir(path.dirname(source), 0o700);
        handle = await fs.promises.open(lock, 'wx', 0o600);
    } catch (error: any) {
        if (error?.code === 'EEXIST') return { ok: false, reason: 'Capability consumption already in progress' };
        throw error;
    }
    try {
        const grant = await loadTrustedGrant(cwd, input.id, controlRoot);
        if (!grant) return { ok: false, reason: 'Unknown capability id' };
        if (grant.used) return { ok: false, reason: 'Capability already consumed' };
        if (Date.now() > grant.expiresAt) return { ok: false, reason: 'Capability expired' };
        if (grant.subjectId !== input.subjectId || grant.taskId !== input.taskId) return { ok: false, reason: 'Capability identity or task mismatch' };
        if (grant.action !== input.action || grant.resource !== input.resource) return { ok: false, reason: 'Capability action or resource mismatch' };
        const config = await loadGatewayConfig(cwd, controlRoot);
        if (grant.policyHash !== getGatewayPolicyHash(cwd, config)) return { ok: false, reason: 'Capability policy is stale' };
        grant.used = true;
        await fs.writeJson(source, grant, { spaces: 2, mode: 0o600 });
        return { ok: true, reason: 'Capability consumed', grant };
    } finally {
        await handle.close();
        await fs.remove(lock);
    }
}
