/**
 * The Memory page's Lessons tab as a triage list: what waits for a person first, then what is in force, then what was
 * taken back or dropped, with a search over keys and text and pages of 25.
 */
import React from 'react';
import { Card, Empty, FilterBar, Pager, matchesQuery, usePaged, type FilterChip } from './ui';
import type { Journey } from './LearningParts';
import { groupProposals, itemKey, LessonItemView, type LessonItem, type ReviewProps } from './MemoryProposals';
import { lessonBucket, lessonSearchText, type LessonBucket } from './lessonWords';

type Filter = LessonBucket | 'all';
type Decide = (id: string, state: 'validated' | 'promoted' | 'rejected') => void;

/** A grouped key always holds a proposal: it waits for a person. */
const itemBucket = (item: LessonItem): LessonBucket => ('lesson' in item ? lessonBucket(item.lesson) : 'waiting');

function itemText(item: LessonItem): string {
    if ('lesson' in item) return lessonSearchText(item.lesson);
    return [item.key, ...[...item.shared, ...item.proposals].map(lessonSearchText)].join(' ');
}

const FILTER_WORDS: Record<Filter, string> = { waiting: 'Waiting for a person', force: 'In force', gone: 'Taken back or dropped', all: 'All' };
const EMPTY_WORDS: Record<Filter, string> = {
    waiting: 'Nothing waits for a person. New candidates arrive when an agent fixes something Rigour reported, a review point is learned, or an agent is told to remember something.',
    force: 'No lesson is in force yet. Keep or share a candidate and agents are told it.',
    gone: 'Nothing was taken back or dropped.',
    all: 'No lessons yet.',
};

/** Why sharing waits, when three or more candidates say the same: said once above the list instead of on every row. */
function commonNoShare(lessons: Journey[]): string | undefined {
    const reasons = new Map<string, number>();
    for (const l of lessons) if (l.noShare && l.canDecide) reasons.set(l.noShare, (reasons.get(l.noShare) ?? 0) + 1);
    const [top] = [...reasons].sort((a, b) => b[1] - a[1]);
    return top && top[1] >= 3 ? top[0] : undefined;
}

/** The filter a person lands on: waiting for a person when anything does, else in force. */
function defaultFilter(items: LessonItem[]): Filter {
    return items.some(i => itemBucket(i) === 'waiting') ? 'waiting' : 'force';
}

/** Items in one filter that match the search, in the loader's order. */
function filterItems(items: LessonItem[], filter: Filter, query: string): LessonItem[] {
    return items.filter(i => (filter === 'all' || itemBucket(i) === filter) && matchesQuery(itemText(i), query));
}

export const LessonsTriage: React.FC<{ lessons: Journey[]; onDecide: Decide; initialQuery?: string } & ReviewProps> = ({ lessons, onDecide, initialQuery = '', ...review }) => {
    const items = React.useMemo(() => groupProposals(lessons), [lessons]);
    // Not remembered between visits: a remembered pile could hide candidates that arrived since. Each visit opens on
    // what waits for a person when anything does.
    const [filter, setFilter] = React.useState<Filter>(() => defaultFilter(items));
    const [query, setQuery] = React.useState(initialQuery);
    const shown = React.useMemo(() => filterItems(items, filter, query), [items, filter, query]);
    const paged = usePaged(shown, { resetKey: `${filter}\u0000${query}`, storageKey: 'memory:lessons' });
    const quietNoShare = commonNoShare(lessons);
    const count = (f: Filter) => (f === 'all' ? items.length : items.filter(i => itemBucket(i) === f).length);
    const chips: FilterChip[] = (['waiting', 'force', 'gone', 'all'] as Filter[]).map(f => ({ id: f, label: FILTER_WORDS[f], count: count(f) }));
    return (
        <Card flush>
            <div className="ui-card-body">
                <FilterBar query={query} onQuery={setQuery} placeholder="Search lessons by key or text" chips={chips} active={filter} onChip={id => setFilter(id as Filter)} matching={shown.length} noun={['lesson', 'lessons']} />
                {quietNoShare && filter !== 'force' && filter !== 'gone' && <div className="mem-note">Share with team waits: {quietNoShare}</div>}
            </div>
            {shown.length === 0
                ? <div className="ui-card-body"><Empty>{query ? `No lesson here matches “${query}”.` : EMPTY_WORDS[filter]}</Empty></div>
                : <div className="ui-list">{paged.items.map(item => <LessonItemView key={itemKey(item)} item={item} onDecide={onDecide} quietNoShare={quietNoShare} {...review} />)}</div>}
            <Pager paged={paged} label="lessons" />
        </Card>
    );
};
