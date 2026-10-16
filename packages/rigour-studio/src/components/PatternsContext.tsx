/** "What agents were given": what Rigour put in front of agents before they wrote, this week and over eight weeks. */
import React from 'react';
import { plural } from './storyData';
import { Card, Empty, Table } from './ui';
import './patterns.css';

interface ContextWeek { from: string; scopes: number; filesReturned: number; filesConsidered: number; recalls: number; lessonsTold: number; reuse: number }
export interface ContextData {
    week: {
        scopes: number;
        filesConsidered: number;
        filesReturned: number;
        tokensConsidered: number;
        tokensReturned: number;
        recalls: number;
        lessonsTold: number;
        reuse: Array<{ at: string; planned: string; existing: string; action: string }>;
    };
    weeks: ContextWeek[];
}

const thousands = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

const Fact: React.FC<{ title: string; value: string; detail: string }> = ({ title, value, detail }) => (
    <div className="ui-item">
        <span className="ui-label">{title}</span>
        <span className="pat-fact-value">{value}</span>
        <span className="pat-note">{detail}</span>
    </div>
);

/** This week's focused file lists, token estimate, recalls and lessons told. */
export const AgentsGiven: React.FC<{ data: ContextData }> = ({ data }) => {
    const w = data.week;
    const nothing = w.scopes + w.recalls + w.lessonsTold + w.reuse.length === 0;
    return (
        <Card title="What agents were given" meta="this week">
            {nothing
                ? <Empty>No agent asked Rigour for context this week. Agents use it through the Rigour tools (<code>rigour_context_scope</code>, <code>rigour_recall</code>, <code>rigour_check_pattern</code>); Setup shows whether they are connected.</Empty>
                : (
                    <div className="pat-facts">
                        <Fact
                            title="Where to look"
                            value={w.scopes === 0 ? 'Not asked this week' : `${plural(w.filesReturned, 'file')} instead of ${w.filesConsidered}`}
                            detail={w.scopes === 0 ? 'Agents can ask for the files a task needs instead of reading broadly.' : `${plural(w.scopes, 'request')}. About ${thousands(w.tokensReturned)} tokens returned out of ${thousands(w.tokensConsidered)} considered (Rigour's estimate).`}
                        />
                        <Fact title="What this team knows" value={`${plural(w.lessonsTold, 'lesson')} told`} detail={`${plural(w.recalls, 'recall')} of saved facts and lessons. Memory shows what each lesson stopped.`} />
                    </div>
                )}
        </Card>
    );
};

/** One row per week that had any context activity; quiet weeks are left out rather than shown as rows of zeros. */
export const WeeklyTable: React.FC<{ weeks: ContextWeek[] }> = ({ weeks }) => {
    const active = weeks.filter(w => w.scopes + w.recalls + w.lessonsTold + w.reuse > 0).reverse();
    return (
        <Card title="Last 8 weeks" flush>
            {active.length === 0
                ? <div className="ui-card-body"><Empty>No context requests in the last 8 weeks.</Empty></div>
                : <Table rows={active} rowKey={w => w.from} columns={[
                    { label: 'Week of', cell: w => new Date(w.from).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) },
                    { label: 'Focused file lists', cell: w => w.scopes },
                    { label: 'Files given', cell: w => (w.scopes ? `${w.filesReturned} of ${w.filesConsidered}` : '—') },
                    { label: 'Recalls', cell: w => w.recalls },
                    { label: 'Lessons told', cell: w => w.lessonsTold },
                    { label: 'Duplicates avoided', cell: w => w.reuse },
                ]} />}
        </Card>
    );
};
