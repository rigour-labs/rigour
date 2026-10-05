/**
 * `rigour profile list|which|add`: one machine, many organizations (core utils/profile.ts).
 */
import chalk from 'chalk';
import { profileFor, profilesPath, readProfiles, writeProfiles, type RigourProfile } from '@rigour-labs/core/profile';
import { rigourUserDir } from '@rigour-labs/core';

export function profileListCommand(): void {
    const profiles = readProfiles();
    if (profiles.length === 0) return void console.log(chalk.dim(`No profiles (${profilesPath()}). Add one with rigour profile add.`));
    for (const p of profiles) {
        console.log(`${chalk.bold(p.name)}  ${chalk.dim(p.match.join(', '))}`);
        console.log(chalk.dim(`  home: ${p.home ?? '(default)'}${p.team ? `  team: ${p.team.organization}/${p.team.team} as ${p.team.actor}` : '  no team'}${p.githubAccount ? `  github: ${p.githubAccount}` : ''}`));
    }
}

/** Which profile applies here, and the home Rigour uses (this process applied it at start). */
export function profileWhichCommand(cwd: string): void {
    const profile = profileFor(cwd);
    console.log(profile ? `${chalk.bold(profile.name)} (matched ${cwd})` : chalk.dim('No profile matches here: Rigour uses its default home.'));
    console.log(chalk.dim(`  home: ${rigourUserDir()}`));
}

export interface ProfileAddOptions {
    match: string;
    home?: string;
    organization?: string;
    team?: string;
    actor?: string;
    repositories?: string;
    databaseUrlCommand?: string;
    githubAccount?: string;
}

export function profileAddCommand(name: string, options: ProfileAddOptions): void {
    const list = (value?: string) => (value ?? '').split(',').map(v => v.trim()).filter(Boolean);
    const teamParts = [options.organization, options.team, options.actor];
    if (teamParts.some(Boolean) && !teamParts.every(Boolean)) throw new Error('--organization, --team and --actor go together.');
    const profile: RigourProfile = {
        name,
        match: list(options.match),
        ...(options.home ? { home: options.home } : {}),
        ...(options.organization ? {
            team: {
                organization: options.organization, team: options.team!, actor: options.actor!,
                ...(options.repositories ? { repositories: list(options.repositories) } : {}),
                ...(options.databaseUrlCommand ? { databaseUrlCommand: options.databaseUrlCommand } : {}),
            },
        } : {}),
        ...(options.githubAccount ? { githubAccount: options.githubAccount } : {}),
    };
    if (profile.match.length === 0) throw new Error('--match needs at least one path or remote (github.com/acme/*).');
    writeProfiles([...readProfiles().filter(p => p.name !== name), profile]);
    console.log(chalk.green(`Profile ${name} saved to ${profilesPath()}.`));
}
