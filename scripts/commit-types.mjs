#!/usr/bin/env node
/**
 * A pull request's title is its release intent (fix: a patch, feat: a minor). semantic-release reads every commit a
 * merge commit brings onto the branch, not only the title, so one branch commit of a higher type changes the version
 * the release gets (a `feat:` commit under a `perf:` title turned a planned 6.9.1 into 6.10.0). This fails a pull
 * request whose commits would release more than its title says.
 *
 *   node scripts/commit-types.mjs "<title>" <base sha> <head sha>
 */
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';

/** What a conventional-commit message releases: 3 major, 2 minor, 1 patch, 0 nothing. */
export function releaseLevel(message) {
    const [subject, ...body] = message.split('\n');
    const m = /^(\w+)(?:\([^)]*\))?(!)?:/.exec(subject.trim());
    if ((m && m[2]) || /^BREAKING[ -]CHANGE:/m.test(body.join('\n'))) return 3;
    if (!m) return 0;
    if (m[1] === 'feat') return 2;
    return m[1] === 'fix' || m[1] === 'perf' ? 1 : 0;
}

const NAMES = ['no release', 'a patch', 'a minor', 'a major'];

/** The commits that would release more than the title: [] when the title is the highest. */
export function overTitle(title, messages) {
    const allowed = releaseLevel(title);
    return messages.filter(message => releaseLevel(message) > allowed).map(message => ({ subject: message.split('\n')[0], releases: NAMES[releaseLevel(message)], title: NAMES[allowed] }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const [title, base, head] = process.argv.slice(2);
    if (!title || !base || !head) {
        console.error('usage: commit-types.mjs "<title>" <base sha> <head sha>');
        process.exit(2);
    }
    const messages = execFileSync('git', ['log', '--format=%B%x1e', `${base}..${head}`], { encoding: 'utf8' }).split('\x1e').map(m => m.trim()).filter(Boolean);
    const over = overTitle(title, messages);
    for (const o of over) console.error(`::error::"${o.subject}" releases ${o.releases}; the title "${title}" releases ${o.title}. Give the commit the title's type (git rebase, then reword), or change the title if the release really is ${o.releases}.`);
    if (over.length) process.exit(1);
    console.log(`${messages.length} commit(s), none releases more than the title "${title}".`);
}
