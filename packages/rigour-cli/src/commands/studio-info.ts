/**
 * What Studio's header names the repository by: the origin remote's repository name, else the checkout's folder name.
 * Never its absolute path (which carries the person's username into every screenshot), and never package.json's name
 * and version, which name a package, not the repository.
 */
import { execFileSync } from 'child_process';
import path from 'path';

export function repoName(cwd: string): string {
    try {
        const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const name = /([^/:]+?)(?:\.git)?\/?$/.exec(url)?.[1];
        if (name) return name;
    } catch {
        // No origin: the folder.
    }
    try {
        return path.basename(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    } catch {
        return path.basename(path.resolve(cwd));
    }
}
