/**
 * DLP feedback learning — reduces false positives over time from hook-driven user corrections.
 * Fingerprints are stored per-project in .rigour/dlp-feedback.json.
 */
import { createHash } from 'crypto';
import fs from 'fs-extra';
import path from 'path';

export interface DLPFeedbackEntry {
    fingerprint: string;
    type: string;
    shape: string;
    hits: number;
    lastSeenAt: string;
    source: 'hook' | 'cli' | 'mcp';
}

export interface DLPFeedbackStore {
    version: 1;
    entries: DLPFeedbackEntry[];
}

export interface DLPBlockManifest {
    timestamp: string;
    detections: Array<{ type: string; fingerprint: string; confidence: number }>;
}

const DLP_BLOCK_MANIFEST_TTL_MS = 10 * 60 * 1000;
const MAX_LEARNABLE_CONFIDENCE = 79;
const NON_LEARNABLE_TYPES = new Set([
    'private_key',
    'private_key_full',
    'gcp_service_account',
    'bearer_token',
    'jwt_token',
    'aws_secret_key',
    'azure_key',
    'anthropic_key',
    'slack_token',
    'sendgrid_key',
    'aws_access_key',
    'openai_key',
    'github_token',
    'stripe_key',
    'twilio_key',
    'high_entropy_secret',
]);

export function isLearnableDLPDetection(
    detection: { type: string; confidence?: number }
): boolean {
    const confidence = detection.confidence ?? 100;
    return !NON_LEARNABLE_TYPES.has(detection.type)
        && confidence <= MAX_LEARNABLE_CONFIDENCE;
}

/** Normalize a matched value to a shape for learning (preserves structure, not secret content). */
export function shapeValue(value: string): string {
    return value
        .replace(/[A-Za-z0-9]{8,}/g, '<TOKEN>')
        .replace(/\d{4,}/g, '<NUM>')
        .slice(0, 120);
}

export function fingerprintDetection(type: string, match: string, line?: string): string {
    const value = extractValueShape(match);
    const raw = line
        ? `${type}|${value}|${shapeValue(line)}`
        : `${type}|${value}`;
    return createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

/** Stable fingerprint for hook-learned false positives (type + value shape only). */
export function feedbackFingerprint(type: string, match: string): string {
    const value = extractValueShape(match);
    return createHash('sha256').update(`${type}|${value}`).digest('hex').slice(0, 24);
}

function extractValueShape(match: string): string {
    const assignment = match.match(/[:=]\s*['"]?(.+?)['"]?\s*$/);
    const value = assignment?.[1] ?? match;
    return shapeValue(value.replace(/^['"`]+|['"`;]+$/g, ''));
}

function feedbackPath(cwd: string): string {
    return path.join(cwd, '.rigour', 'dlp-feedback.json');
}

export function lastBlockPath(cwd: string): string {
    return path.join(cwd, '.rigour', 'dlp-last-block.json');
}

async function loadStore(cwd: string): Promise<DLPFeedbackStore> {
    const filePath = feedbackPath(cwd);
    if (!await fs.pathExists(filePath)) {
        return { version: 1, entries: [] };
    }
    try {
        const data = await fs.readJson(filePath) as DLPFeedbackStore;
        if (data?.version === 1 && Array.isArray(data.entries)) return data;
    } catch {
        // corrupt — reset
    }
    return { version: 1, entries: [] };
}

async function saveStore(cwd: string, store: DLPFeedbackStore): Promise<void> {
    await fs.ensureDir(path.dirname(feedbackPath(cwd)));
    await fs.writeJson(feedbackPath(cwd), store, { spaces: 2 });
}

export async function recordDLPFeedback(
    cwd: string,
    entry: {
        type: string;
        match: string;
        confidence?: number;
        line?: string;
        source?: DLPFeedbackEntry['source'];
    }
): Promise<string | null> {
    if (!isLearnableDLPDetection(entry)) return null;
    const fingerprint = feedbackFingerprint(entry.type, entry.match);
    const store = await loadStore(cwd);
    const existing = store.entries.find(e => e.fingerprint === fingerprint);
    const now = new Date().toISOString();

    if (existing) {
        existing.hits += 1;
        existing.lastSeenAt = now;
    } else {
        store.entries.push({
            fingerprint,
            type: entry.type,
            shape: '[redacted]',
            hits: 1,
            lastSeenAt: now,
            source: entry.source ?? 'hook',
        });
    }

    if (store.entries.length > 500) {
        store.entries.sort((a, b) => b.hits - a.hits || b.lastSeenAt.localeCompare(a.lastSeenAt));
        store.entries = store.entries.slice(0, 500);
    }

    await saveStore(cwd, store);
    return fingerprint;
}

export async function isLearnedAllow(
    cwd: string | undefined,
    type: string,
    match: string,
    _line?: string
): Promise<boolean> {
    if (!cwd) return false;
    const store = await loadStore(cwd);
    return isLearnedAllowSync(store, type, match);
}

export function isLearnedAllowSync(
    store: DLPFeedbackStore,
    type: string,
    match: string,
    _line?: string
): boolean {
    const fingerprint = feedbackFingerprint(type, match);
    return store.entries.some(e => e.fingerprint === fingerprint);
}

export async function loadDLPFeedbackStore(cwd: string): Promise<DLPFeedbackStore> {
    return loadStore(cwd);
}

export async function getLearnedAllowCount(cwd: string): Promise<number> {
    const store = await loadStore(cwd);
    return store.entries.length;
}

/** Synchronous load for hot-path DLP scanning (<50ms budget). */
export function loadDLPFeedbackStoreSync(cwd: string): DLPFeedbackStore {
    const filePath = feedbackPath(cwd);
    try {
        if (!fs.existsSync(filePath)) {
            return { version: 1, entries: [] };
        }
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DLPFeedbackStore;
        if (data?.version === 1 && Array.isArray(data.entries)) return data;
    } catch {
        // corrupt
    }
    return { version: 1, entries: [] };
}

function getLineAt(input: string, start: number): string {
    const lineStart = input.lastIndexOf('\n', start) + 1;
    const lineEnd = input.indexOf('\n', start);
    return input.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
}

export async function writeDLPBlockManifest(
    cwd: string,
    detections: Array<{
        type: string;
        match?: string;
        feedback_fingerprint?: string;
        confidence?: number;
        position?: { start: number; end: number };
    }>,
    _input: string
): Promise<void> {
    const seen = new Set<string>();
    const manifestDetections: DLPBlockManifest['detections'] = [];
    for (const d of detections) {
        if (!isLearnableDLPDetection(d)) continue;
        const fp = d.feedback_fingerprint
            ?? (d.match ? feedbackFingerprint(d.type, d.match) : null);
        if (!fp) continue;
        if (seen.has(fp)) continue;
        seen.add(fp);
        manifestDetections.push({
            type: d.type,
            fingerprint: fp,
            confidence: d.confidence ?? 100,
        });
    }
    const manifestPath = lastBlockPath(cwd);
    if (manifestDetections.length === 0) {
        await fs.remove(manifestPath);
        return;
    }
    const manifest: DLPBlockManifest = {
        timestamp: new Date().toISOString(),
        detections: manifestDetections,
    };
    await fs.ensureDir(path.dirname(manifestPath));
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
}

export async function allowLastDLPBlock(cwd: string, source: DLPFeedbackEntry['source'] = 'hook'): Promise<number> {
    const manifestPath = lastBlockPath(cwd);
    if (!await fs.pathExists(manifestPath)) return 0;
    let manifest: DLPBlockManifest;
    try {
        manifest = await fs.readJson(manifestPath) as DLPBlockManifest;
    } catch {
        await fs.remove(manifestPath);
        return 0;
    }
    await fs.remove(manifestPath);
    const manifestAge = Date.now() - Date.parse(manifest.timestamp);
    if (!Number.isFinite(manifestAge)
        || manifestAge < 0
        || manifestAge > DLP_BLOCK_MANIFEST_TTL_MS
        || !Array.isArray(manifest.detections)) return 0;
    const store = await loadStore(cwd);
    const now = new Date().toISOString();
    let count = 0;
    for (const d of manifest.detections ?? []) {
        if (!isLearnableDLPDetection(d)) continue;
        const existing = store.entries.find(e => e.fingerprint === d.fingerprint);
        if (existing) {
            existing.hits += 1;
            existing.lastSeenAt = now;
        } else {
            store.entries.push({
                fingerprint: d.fingerprint,
                type: d.type,
                shape: '[redacted]',
                hits: 1,
                lastSeenAt: now,
                source,
            });
        }
        count++;
    }
    if (count > 0) {
        await saveStore(cwd, store);
    }
    return count;
}
