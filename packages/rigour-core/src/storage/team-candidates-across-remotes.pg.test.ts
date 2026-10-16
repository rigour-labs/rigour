/**
 * Against a real PostgreSQL, when RIGOUR_TEST_DATABASE_URL names a database an administrator owns (skipped otherwise):
 * team candidates an agent saves in one clone of a repository are listed, ready for a decision, in another checkout of
 * the same repository whose origin is written another way (an https clone and an SSH-alias checkout), and a decision
 * made there reaches the team database. Each "machine"
 * runs in its own process with its own local store, as two machines do.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.RIGOUR_TEST_DATABASE_URL;
const DATABASE = `rigour_remotes_${process.pid}`;
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'storage');

describe.skipIf(!URL || !fs.existsSync(dist))('team candidates across remote forms, on a real PostgreSQL', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remotes-'));
    const sshConfig = path.join(root, 'ssh_config');
    const teamUrl = () => { const url = new globalThis.URL(URL!); url.pathname = `/${DATABASE}`; return url.toString(); };
    const pg = async (connectionString: string) => new (await import('pg')).Pool({ connectionString });
    const machine = (name: string, origin: string) => {
        const repo = path.join(root, `${name}-repo`);
        fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
        fs.writeFileSync(path.join(repo, '.git', 'config'), `[remote "origin"]\n\turl = ${origin}\n`);
        return { repo, home: path.join(root, `${name}-home`) };
    };
    const cloud = machine('cloud', 'https://forge.example.com/example-org/widgets.git');
    const laptop = machine('laptop', 'git@work-forge:example-org/widgets.git');
    /** Runs `body` (an async function of the dist modules `lessons` and `teamStore`) in a process of its own. */
    const run = (on: { repo: string; home: string }, body: string) => new Promise<string>((resolve, reject) => {
        const script = `const lessons = await import(${JSON.stringify(pathToFileURL(path.join(dist, 'lessons.js')).href)});
const teamStore = await import(${JSON.stringify(pathToFileURL(path.join(dist, 'team-store.js')).href)});
const repo = ${JSON.stringify(on.repo)};
console.log(JSON.stringify(await (${body})()));`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
            env: {
                ...process.env, RIGOUR_HOME: on.home, RIGOUR_SSH_CONFIG: sshConfig, RIGOUR_TELEMETRY: '0',
                RIGOUR_TEAM_DATABASE_URL: teamUrl(), RIGOUR_ORGANIZATION_ID: 'example-org', RIGOUR_TEAM_ID: 'web',
                RIGOUR_ACTOR_ID: 'reviewer-sme', RIGOUR_TEAM_REPOSITORIES: 'forge.example.com/example-org/widgets',
            },
        });
        let out = '';
        let err = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });
        child.on('close', code => (code === 0 ? resolve(out.trim().split('\n').pop() ?? '') : reject(new Error(err || out))));
    });

    beforeAll(async () => {
        fs.writeFileSync(sshConfig, 'Host work-forge\n    HostName forge.example.com\n');
        const admin = await pg(URL!);
        await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
        await admin.query(`CREATE DATABASE ${DATABASE}`);
        await admin.end();
        const { initializeTeamSchema } = await import('./team-store.js');
        await initializeTeamSchema(teamUrl());
        const team = await pg(teamUrl());
        await team.query(`INSERT INTO rigour.memberships (db_role, organization_id, team_id, actor_id, role) VALUES (current_user, 'example-org', 'web', 'reviewer-sme', 'sme')`);
        await team.end();
    });

    afterAll(async () => {
        const admin = await pg(URL!);
        await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
        await admin.end();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('lists the cloud clone\'s pending candidates on the laptop, ready for a decision', async () => {
        await run(cloud, `async () => {
            await lessons.shareMemoryLesson(repo, 'retries', 'Use withRetry from lib/net.');
            await lessons.shareMemoryLesson(repo, 'paging', 'Use keyset pagination.');
            return teamStore.syncTeamOutbox({ cwd: repo });
        }`);
        const listed = JSON.parse(await run(laptop, `async () => {
            await teamStore.syncTeamOutbox({ cwd: repo });
            return (await lessons.listKnowledgeLessons(repo)).filter(l => l.kind === 'memory').map(l => [l.subject, l.state]).sort();
        }`));
        expect(listed).toEqual([
            ['paging: Use keyset pagination.', 'candidate'],
            ['retries: Use withRetry from lib/net.', 'candidate'],
        ]);
    }, 120_000);

    it('shares one and supersedes another from the laptop, and the team database has both decisions', async () => {
        await run(laptop, `async () => {
            await teamStore.syncTeamOutbox({ cwd: repo });
            const listed = (await lessons.listKnowledgeLessons(repo)).filter(l => l.kind === 'memory');
            await lessons.transitionLesson(listed.find(l => l.subject.startsWith('retries:')).id, 'promoted', { visibility: 'team', queueSync: true });
            await lessons.shareMemoryLesson(repo, 'paging', 'Use keyset pagination with a stable sort key.');
            return teamStore.syncTeamOutbox({ cwd: repo });
        }`);
        const team = await pg(teamUrl());
        const { rows } = await team.query(`SELECT subject, state FROM rigour.lessons WHERE kind = 'memory' ORDER BY subject`);
        await team.end();
        // Sharing publishes a promoted copy beside the candidate (transitionLesson), so both rows are there.
        expect(rows.map(r => [r.subject, r.state])).toEqual([
            ['paging: Use keyset pagination with a stable sort key.', 'candidate'],
            ['paging: Use keyset pagination.', 'superseded'],
            ['retries: Use withRetry from lib/net.', 'candidate'],
            ['retries: Use withRetry from lib/net.', 'promoted'],
        ]);
    }, 120_000);
});
