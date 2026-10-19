/**
 * The model reviewer's stored verdict, for a readiness verdict (readiness.ts) on a run that did not ask for the
 * reviewer: the background review at push already judged this commit. It is used only when this run reviews exactly
 * what the verdict reviewed: the branch against the same merge base (`--base`), with no uncommitted change to a
 * tracked file, the branch's last verdict a full review of HEAD, its file the one its own fingerprint names, and its
 * record intact. Otherwise there is no stored verdict, and the model review reads "not run".
 */
import type { ReviewerResult } from '../reviewer.js';
import type { ReviewerName } from './adapters.js';
import { goalAnswers, lessonAnswers } from './answers.js';
import { dismissedAs, readReviewDismissals } from './context.js';
import { defaultExec, GH_TIMEOUT_MS, type Exec } from './exec.js';
import { recordIntact, type ReviewRecord } from './record.js';
import { VerdictStore, type BranchState } from './store.js';
import { checkoutVerifier, type OpenItem, type Verdict } from './verdict.js';

type StoredVerdict = Verdict & { inputs?: { fingerprint?: string; base?: string; reviewers?: string[]; body_sha256?: string | null } };
type Git = (args: string[]) => Promise<string>;

/** `base`: the ref this run reviews the branch against; undefined when it reviews anything else (uncommitted work, a diff, files). */
export async function storedReviewerResult(cwd: string, base: string | undefined, exec: Exec = defaultExec): Promise<ReviewerResult | undefined> {
    if (!base) return undefined;
    try {
        const git: Git = async args => (await exec('git', args, { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout.trim();
        if (await git(['status', '--porcelain', '--untracked-files=no'])) return undefined;
        const store = await VerdictStore.open(cwd, exec);
        const found = store ? await verdictOnHead(store, git, base) : undefined;
        return found ? resultOf(cwd, store!, found) : undefined;
    } catch {
        return undefined; // a stored verdict is a courtesy: without one, the model review reads "not run"
    }
}

interface Found { state: BranchState; verdict: StoredVerdict; record: ReviewRecord }

/** The branch's last verdict, when it is a full review of HEAD against this run's merge base, unchanged since it was written. */
async function verdictOnHead(store: VerdictStore, git: Git, base: string): Promise<Found | undefined> {
    const [head, branch, mergeBase] = [await git(['rev-parse', 'HEAD']), await git(['rev-parse', '--abbrev-ref', 'HEAD']), await git(['merge-base', base, 'HEAD'])];
    const state = branch && branch !== 'HEAD' ? store.branchState(branch) : undefined;
    if (!state || state.head !== head || state.mode !== 'full') return undefined;
    const verdict = store.readJson<StoredVerdict>(state.verdict);
    const record = store.readJson<ReviewRecord>(store.recordPath(state.verdict));
    const fingerprint = verdict?.inputs?.fingerprint;
    if (!verdict || !record || !fingerprint || state.verdict !== store.verdictPath(head, fingerprint)) return undefined;
    if (!mergeBase || verdict.inputs?.base !== mergeBase || record.head !== head || !recordIntact(record)) return undefined;
    return { state, verdict, record };
}

function resultOf(cwd: string, store: VerdictStore, { state, verdict, record }: Found): ReviewerResult {
    const dismissals = readReviewDismissals(cwd);
    const open = (store.readJson<OpenItem[]>(store.openPath(state.verdict)) ?? []).filter(item => !dismissedAs(item, dismissals));
    return {
        outcome: open.length ? 'findings' : 'passed', items: open, unverified: [], resolved: [], answerInReply: [], notes: [], advisory: [], disputed: [], dropped: [], dismissed: [],
        reviewers: (verdict.inputs?.reviewers ?? []) as ReviewerName[], cached: true, record,
        ...(verdict.goal?.length ? { goal: goalAnswers(verdict.goal, checkoutVerifier(cwd)) } : {}),
        lessonAnswers: lessonAnswers(verdict.lessons ?? []),
        stored: verdict.inputs?.body_sha256 ? { bodySha256: verdict.inputs.body_sha256 } : {},
    };
}
