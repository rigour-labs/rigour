/**
 * The model reviewer's stored verdict on this exact commit, for a readiness verdict (readiness.ts) on a run that did
 * not ask for the reviewer: the background review at push already judged it. Used only when the branch's last verdict
 * is a full review of HEAD, its file is the one its own fingerprint names, and its record is intact; otherwise there is
 * no stored verdict, and the model review reads "not run".
 */
import type { ReviewerResult } from '../reviewer.js';
import type { ReviewerName } from './adapters.js';
import { goalAnswers, lessonAnswers } from './answers.js';
import { dismissedAs, readReviewDismissals } from './context.js';
import { defaultExec, GH_TIMEOUT_MS, type Exec } from './exec.js';
import { recordIntact, type ReviewRecord } from './record.js';
import { VerdictStore } from './store.js';
import { checkoutVerifier, type OpenItem, type Verdict } from './verdict.js';

type StoredVerdict = Verdict & { inputs?: { fingerprint?: string; reviewers?: string[] } };

export async function storedReviewerResult(cwd: string, exec: Exec = defaultExec): Promise<ReviewerResult | undefined> {
    try {
        const store = await VerdictStore.open(cwd, exec);
        const git = async (args: string[]) => (await exec('git', args, { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout.trim();
        const [head, branch] = [await git(['rev-parse', 'HEAD']), await git(['rev-parse', '--abbrev-ref', 'HEAD'])];
        const state = store && branch && branch !== 'HEAD' ? store.branchState(branch) : undefined;
        if (!store || !state || state.head !== head || state.mode !== 'full') return undefined;
        const verdict = store.readJson<StoredVerdict>(state.verdict);
        const record = store.readJson<ReviewRecord>(store.recordPath(state.verdict));
        const fingerprint = verdict?.inputs?.fingerprint;
        if (!verdict || !record || !fingerprint || state.verdict !== store.verdictPath(head, fingerprint) || record.head !== head || !recordIntact(record)) return undefined;
        const dismissals = readReviewDismissals(cwd);
        const open = (store.readJson<OpenItem[]>(store.openPath(state.verdict)) ?? []).filter(item => !dismissedAs(item, dismissals));
        return {
            outcome: open.length ? 'findings' : 'passed', items: open, unverified: [], resolved: [], answerInReply: [], notes: [], advisory: [], disputed: [], dropped: [], dismissed: [],
            reviewers: (verdict.inputs?.reviewers ?? []) as ReviewerName[], cached: true, record,
            ...(verdict.goal?.length ? { goal: goalAnswers(verdict.goal, checkoutVerifier(cwd)) } : {}),
            lessonAnswers: lessonAnswers(verdict.lessons ?? []),
        };
    } catch {
        return undefined; // a stored verdict is a courtesy: without one, the model review reads "not run"
    }
}
