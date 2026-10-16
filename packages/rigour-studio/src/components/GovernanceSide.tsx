import React from 'react';
import { Card, Chip, Empty, Row } from './ui';
import { plural } from './storyData';
import { tokens, usd, type JudgeUsage, type QualityGates, type ReviewerUsage, type TeamState } from './governanceData';

/** What rigour.yml enforces, whether the gates block, the score over time and the push gate's record. */
export const QualityGatesCard: React.FC<{ gates: QualityGates }> = ({ gates }) => (
    <Card title="Which rules hold" meta={gates.configFile ?? 'Rigour\'s defaults (no rigour.yml)'}>
        <Row label="The gates" value={gates.reportOnly.on
            ? <Chip tone="warn">only report{gates.reportOnly.setBy ? `, set by ${gates.reportOnly.setBy === 'team' ? 'the team' : 'this clone'}` : ''}</Chip>
            : <Chip tone="ok">block</Chip>} />
        <small className="gov-note">A finding blocks when Rigour can prove it or it is critical; the rest are notes. "Blocks" below means the team made every finding of that check block.</small>
        <div className="gov-rules">
            {gates.rules.map(r => (
                <div key={r.name} title={r.note}>
                    <span>{r.name}</span>
                    <span className="gov-dim">{r.setting}</span>
                    {r.blocks === null ? <Chip>if proven</Chip> : r.blocks ? <Chip tone="bad">blocks</Chip> : <Chip>note</Chip>}
                </div>
            ))}
        </div>
        {gates.commands.length > 0 && <Row label="Runs at push" value={gates.commands.map(c => c.name).join(', ')} />}
        <ScoreTrend score={gates.score} />
        <Row label="Push gate, 28 days" value={gates.pushes ? `${gates.pushes.passed} passed · ${gates.pushes.held} held` : '—'} />
        {!gates.pushes && <small className="gov-note">The push gate has not run here. <span className="ui-mono">rigour hooks init</span> adds it to git's pre-push hook.</small>}
    </Card>
);

/** The last 30 quality scores as small bars, oldest first. */
const ScoreTrend: React.FC<{ score: QualityGates['score'] }> = ({ score }) => {
    if (score.length === 0) return <small className="gov-note">No quality score recorded yet: <span className="ui-mono">rigour check</span> records one each run.</small>;
    return (
        <div>
            <Row label={`Quality score, last ${plural(score.length, 'check')}`} value={score[score.length - 1].score} />
            <div className="gov-spark" role="img" aria-label={`Scores: ${score.map(s => s.score).join(', ')}`}>
                {score.map((s, i) => <span key={`${s.at}:${i}`} title={`${s.score} · ${new Date(s.at).toLocaleDateString()}`} style={{ height: `${Math.max(4, Math.min(100, s.score))}%` }} />)}
            </div>
        </div>
    );
};

/** How a judge is paid for, as far as Rigour knows: it records the dollars a judge reports, never the bill. */
function billing(judge: JudgeUsage): string {
    if (judge.reviewer === 'api') return 'Runs on the API key the team named (review.reviewer.api.key_env): pay per use.';
    if (judge.reviewer === 'claude') return 'Runs on Claude Code\'s own login. Its dollar figure is what the same tokens would cost on the API, not a bill: a subscription may cover it.';
    if (judge.reviewer === 'codex') return 'Runs on Codex\'s own login; it reports tokens, not dollars.';
    return `Runs on ${judge.reviewer}'s own login; how it is billed is not recorded.`;
}

/** What the model reviewer ran in the last 28 days, with dollars only where a judge reported them. */
export const ReviewerUsageCard: React.FC<{ usage: ReviewerUsage }> = ({ usage }) => {
    const max = Math.max(1, ...usage.days.map(d => d.runs));
    return (
        <Card title="What review used" meta="last 28 days">
            {usage.runs === 0 && usage.judges.length === 0 && !usage.deep
                ? <Empty>No reviewer runs in the last 28 days. The reviewer runs on push once it is switched on (Reviewer settings), or with <span className="ui-mono">rigour review --base main</span>.</Empty>
                : (
                    <>
                        <Row label="Reviewer runs" value={usage.runs} />
                        {usage.days.length > 0 && (
                            <div className="gov-spark" role="img" aria-label={usage.days.map(d => `${d.day}: ${d.runs}`).join(', ')}>
                                {usage.days.map(d => <span key={d.day} title={`${d.day}: ${plural(d.runs, 'run')}`} style={{ height: `${(d.runs / max) * 100}%` }} />)}
                            </div>
                        )}
                        {usage.judges.map(j => <JudgeLine key={`${j.reviewer}:${j.model ?? ''}`} judge={j} />)}
                        {usage.deep && <DeepLine deep={usage.deep} />}
                    </>
                )}
            <small className="gov-note">rigour.yml's caps (Rigour's defaults where it sets none): {usage.caps.runsPerDay ?? '—'} runs and {dollars(usage.caps.usdPerDay)} a day; {dollars(usage.caps.usdPerReview)} per review. Your own reviewer.max_usd_per_day in ~/.rigour/settings.json can lower the daily cost cap on this machine.</small>
        </Card>
    );
};

const dollars = (n: number | null) => (n === null ? '—' : usd(n));

/** Deep reviews run with this person's own key: Rigour records the provider's figure, or tokens × list price. */
const DeepLine: React.FC<{ deep: NonNullable<ReviewerUsage['deep']> }> = ({ deep }) => (
    <div className="gov-judge">
        <strong>Deep review with your own key</strong>
        <small>{plural(deep.runs, 'run')} · {tokens(deep.inputTokens)} in / {tokens(deep.outputTokens)} out{deep.models.length ? ` · ${deep.models.join(', ')}` : ''}</small>
        <small className="gov-dim">{deep.costUsd !== null ? `${usd(deep.costUsd)} as Rigour recorded it (the provider's figure, or tokens × list price)` : 'No cost recorded'}{deep.unpricedRuns ? `; ${deep.unpricedRuns} without a price` : ''}</small>
    </div>
);

const JudgeLine: React.FC<{ judge: JudgeUsage }> = ({ judge: j }) => (
    <div className="gov-judge">
        <strong>{j.reviewer}{j.model ? ` · ${j.model}` : ''}</strong>
        <small>{plural(j.reviews, 'review')}{j.tokens ? ` · ${tokens(j.tokens.input)} in / ${tokens(j.tokens.output)} out` : ' · tokens not recorded'}{j.version ? ` · ${j.version}` : ''}</small>
        <small className="gov-dim">{j.costUsd !== null ? `${usd(j.costUsd)} as reported by ${j.reviewer}${j.pricedReviews < j.reviews ? ` (${j.pricedReviews} of ${j.reviews} reported one)` : ''}. ` : 'No dollars reported. '}{billing(j)}</small>
    </div>
);

/** Whether this clone shares with a team, and what a teammate can and cannot see. */
export const TeamCard: React.FC<{ team: TeamState }> = ({ team }) => (
    <Card title="Team" meta={<Chip tone={team.sync ? 'ok' : 'plain'}>{team.sync ? 'sync on' : 'sync off'}</Chip>}>
        {team.sync
            ? (
                <>
                    <Row label="Organization" value={team.organization} />
                    <Row label="Team" value={team.team} />
                    <Row label="You, as" value={team.actor} />
                    <Row label="Your decisions" value={team.sharing ? (team.sharing.shares ? 'shared with the team' : 'kept on this machine') : 'not synced yet'} />
                    {team.sharing && !team.sharing.shares && team.sharing.reason && <small className="gov-note">{team.sharing.reason}</small>}
                    <Row label="Decisions received" value={team.received} />
                    {team.refused && <Row label="Refused by the team database, 28 days" value={team.refused.count} />}
                    {team.refused?.latest && <small className="gov-note">The latest: {team.refused.latest}</small>}
                </>
            )
            : <Empty>Team sync is off: lessons and decisions stay on this machine. <span className="ui-mono">rigour team configure</span> connects a team database.</Empty>}
        <small className="gov-note">{team.candidates ?? 'Teammates\' candidates are visible only to them until shared.'}</small>
    </Card>
);
