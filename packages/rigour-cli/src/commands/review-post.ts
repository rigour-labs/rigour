/**
 * `rigour review-post`: post a `rigour review --json` report on a pull request.
 *
 * The PR bot is the safety net behind the pre-PR review, so it stays quiet:
 * at most `--max-comments` inline comments (default 2), the most severe
 * first, each posted once across pushes, and one summary comment that is
 * edited in place on every push rather than re-posted.
 */
import crypto from 'crypto';
import fs from 'fs';

const SUMMARY_MARKER = '<!-- rigour:summary -->';
const FINDING_MARKER = (key: string) => `<!-- rigour:finding:${key} -->`;
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
const PROVENANCE_ORDER = ['security', 'deep-analysis', 'ai-drift', 'traditional', 'governance'];

export interface ReportFinding {
    id: string;
    gate: string;
    severity: string;
    provenance: string;
    message: string;
    file: string;
    line: number | null;
    anchor_line?: number;
    suggestion?: string;
}

export interface ReviewReport {
    status: string;
    failures: ReportFinding[];
    context_findings?: ReportFinding[];
    deep?: { model?: string; cost_usd?: number; router?: { routed: number; functions: number; already_reviewed?: number } };
}

export interface PostTarget {
    token: string;
    repo: string;
    pr: number;
    sha: string;
    apiUrl?: string;
}

type Fetch = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

export interface PostResult {
    inline: number;
    skippedAlreadyPosted: number;
    summaryUpdated: boolean;
    summary: string;
}

/** The most severe, most provable findings first; stable for equal ranks. */
export function rankFindings(findings: ReportFinding[]): ReportFinding[] {
    const rank = (f: ReportFinding) => [orderOf(SEVERITY_ORDER, f.severity), orderOf(PROVENANCE_ORDER, f.provenance)];
    return findings.map((f, i) => ({ f, i })).sort((a, b) => {
        const [sa, pa] = rank(a.f);
        const [sb, pb] = rank(b.f);
        return sa - sb || pa - pb || a.i - b.i;
    }).map(x => x.f);
}

/** Same finding across pushes: gate, file and message, not the line (lines move). */
export function findingKey(f: ReportFinding): string {
    return crypto.createHash('sha256').update(`${f.gate}\u0000${f.file}\u0000${f.message}`).digest('hex').slice(0, 16);
}

export async function postReview(report: ReviewReport, target: PostTarget, maxComments = 2, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<PostResult> {
    const api = new GitHub(target, fetchImpl);
    const posted = new Set((await api.list(`/pulls/${target.pr}/comments`)).flatMap(c => markerKeys(c.body)));
    const ranked = rankFindings(report.failures.filter(f => f.file && (f.anchor_line ?? f.line)));
    const fresh = ranked.filter(f => !posted.has(findingKey(f)));
    const inline = fresh.slice(0, Math.max(0, maxComments));
    let inlinePosted = 0;
    if (inline.length) {
        const ok = await api.send('POST', `/pulls/${target.pr}/reviews`, {
            commit_id: target.sha, event: 'COMMENT',
            comments: inline.map(f => ({ path: f.file, line: f.anchor_line ?? f.line, side: 'RIGHT', body: commentBody(f) })),
        });
        inlinePosted = ok ? inline.length : 0;
    }
    const summary = summaryBody(report, ranked.length, inlinePosted, ranked.length - fresh.length);
    const existing = (await api.list(`/issues/${target.pr}/comments`)).find(c => typeof c.body === 'string' && c.body.includes(SUMMARY_MARKER));
    const summaryUpdated = existing
        ? await api.send('PATCH', `/issues/comments/${existing.id}`, { body: summary })
        : await api.send('POST', `/issues/${target.pr}/comments`, { body: summary });
    return { inline: inlinePosted, skippedAlreadyPosted: ranked.length - fresh.length, summaryUpdated, summary };
}

export function commentBody(f: ReportFinding): string {
    const anchored = f.anchor_line !== undefined && f.line !== null && f.anchor_line !== f.line ? ` (root cause at line ${f.line})` : '';
    return [
        `**${f.severity.toUpperCase()}** · ${f.gate}${anchored}`,
        '',
        f.message,
        ...(f.suggestion ? ['', `**Fix:** ${f.suggestion}`] : []),
        '',
        FINDING_MARKER(findingKey(f)),
    ].join('\n');
}

export function summaryBody(report: ReviewReport, total: number, inline: number, alreadyPosted: number): string {
    const deep = report.deep;
    const lines = [
        SUMMARY_MARKER,
        `### Rigour review: ${report.status}`,
        '',
        total === 0
            ? 'No findings on the lines this PR changes.'
            : `${total} finding(s) on changed lines; ${inline} posted inline now${alreadyPosted ? `, ${alreadyPosted} posted on an earlier push` : ''}. The rest are in the job summary.`,
    ];
    if (report.context_findings?.length) lines.push('', `${report.context_findings.length} note(s) elsewhere in changed files (not blocking).`);
    if (deep?.router) {
        lines.push('', `Model review: ${deep.router.routed} of ${deep.router.functions} changed function(s) by risk`
            + `${deep.router.already_reviewed ? `; ${deep.router.already_reviewed} already reviewed before the PR` : ''}.`);
    }
    if (deep?.model) lines.push(`Model: \`${deep.model}\`${typeof deep.cost_usd === 'number' ? ` · cost $${deep.cost_usd.toFixed(3)}` : ''}.`);
    return lines.join('\n');
}

function markerKeys(body: unknown): string[] {
    return typeof body === 'string' ? [...body.matchAll(/<!-- rigour:finding:([0-9a-f]+) -->/g)].map(m => m[1]) : [];
}

function orderOf(order: string[], value: string): number {
    const index = order.indexOf(value);
    return index === -1 ? order.length : index;
}

class GitHub {
    private readonly base: string;

    constructor(private readonly target: PostTarget, private readonly fetchImpl: Fetch) {
        this.base = `${(target.apiUrl || 'https://api.github.com').replace(/\/$/, '')}/repos/${target.repo}`;
    }

    async list(path: string): Promise<any[]> {
        const response = await this.fetchImpl(`${this.base}${path}?per_page=100`, { headers: this.headers() });
        if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
        const body = await response.json();
        return Array.isArray(body) ? body : [];
    }

    /** false when GitHub refuses (e.g. a line outside the diff); the summary still goes out. */
    async send(method: string, path: string, body: unknown): Promise<boolean> {
        const response = await this.fetchImpl(`${this.base}${path}`, { method, headers: this.headers(), body: JSON.stringify(body) });
        return response.ok;
    }

    private headers(): Record<string, string> {
        return { Authorization: `Bearer ${this.target.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' };
    }
}

/** The pull request number and head commit from a GitHub Actions pull_request event. */
export function targetFromEnv(env: NodeJS.ProcessEnv = process.env): PostTarget {
    const token = env.GITHUB_TOKEN?.trim();
    const repo = env.GITHUB_REPOSITORY?.trim();
    if (!token || !repo || !env.GITHUB_EVENT_PATH) throw new Error('review-post runs in GitHub Actions: GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_EVENT_PATH are required.');
    const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    const pr = Number(event.pull_request?.number);
    const sha = String(event.pull_request?.head?.sha ?? '');
    if (!pr || !sha) throw new Error('review-post needs a pull_request event.');
    return { token, repo, pr, sha, apiUrl: env.GITHUB_API_URL };
}

export async function reviewPostCommand(options: { report: string; maxComments?: string }): Promise<void> {
    const report = JSON.parse(fs.readFileSync(options.report, 'utf8')) as ReviewReport;
    const result = await postReview(report, targetFromEnv(), Number(options.maxComments ?? 2));
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.summary.replace(SUMMARY_MARKER, '') + '\n');
    console.log(`Posted ${result.inline} inline comment(s); summary ${result.summaryUpdated ? 'updated' : 'not updated'}.`);
}
