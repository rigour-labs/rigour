/**
 * `rigour uninstall`: take Rigour back out of a repository, and only Rigour.
 *
 * - Agent configs (`.claude/settings.json`, `.cursor/hooks.json`, `.windsurf/hooks.json`, the MCP
 *   files): Rigour's hook entries and its `rigour` MCP server are removed; every other setting and
 *   the person's own hooks stay. A config Rigour created and that is now empty is deleted.
 * - Files Rigour created (instructions such as CLAUDE.md when there was none, Cline hook scripts,
 *   empty required docs): deleted if nobody has edited them since (`.rigour/installed.json`
 *   holds the hash of what was written); an edited one is kept and named.
 * - Git's pre-push hook: Rigour's own hook is deleted; the lines it appended to another tool's
 *   hook are removed. A hooks directory outside the repository is named, never written.
 * - `rigour.yml` and `.rigour/` hold the team's settings, dismissals and backtest ledger: they are
 *   kept unless `--all`, which also removes Rigour's .gitignore lines.
 * `--dry-run` says what would happen and changes nothing.
 */
import chalk from 'chalk';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { APPENDED_COMMENT } from './hooks-git.js';
import { isEmptyConfig, isRigourScript, readInstallRecord, unchangedSinceInstall, withoutRigour } from './install-record.js';

const CONFIGS = ['.claude/settings.json', '.cursor/hooks.json', '.windsurf/hooks.json', '.cursor/mcp.json', '.mcp.json'];
/** Files Rigour may have written without a record (an install older than the record): known by their content. */
const KNOWN_SCRIPTS = ['.clinerules/hooks/PostToolUse', '.clinerules/hooks/PreToolUse'];
const GITIGNORE_LINES = new Set(['rigour-report.json', 'rigour-fix-packet.json', '.rigour/', '.rigour/*', '!.rigour/dismissed.json', '!.rigour/backtest.json']);

export interface UninstallOptions { all?: boolean; dryRun?: boolean }

export interface UninstallReport {
    /** Each change, as `<action> <path>`. */
    changes: string[];
    /** Files kept on purpose, with why. */
    kept: string[];
}

export function uninstall(cwd: string, options: UninstallOptions = {}): UninstallReport {
    const report: UninstallReport = { changes: [], kept: [] };
    const act = (change: string, run: () => void) => {
        if (!options.dryRun) run();
        report.changes.push(change);
    };
    const record = readInstallRecord(cwd);

    for (const rel of CONFIGS) {
        const file = path.join(cwd, rel);
        if (!fs.existsSync(file)) continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            report.kept.push(`${rel}: not valid JSON, left alone`);
            continue;
        }
        const stripped = withoutRigour(parsed);
        if (JSON.stringify(stripped) === JSON.stringify(parsed)) continue;
        if (isEmptyConfig(stripped) && rel in record.created) act(`delete ${rel}`, () => fs.unlinkSync(file));
        else act(`remove Rigour entries from ${rel}`, () => fs.writeFileSync(file, JSON.stringify(stripped, null, 4) + '\n'));
    }

    for (const [rel] of Object.entries(record.created)) {
        if (CONFIGS.includes(rel)) continue;
        const file = path.join(cwd, rel);
        if (!fs.existsSync(file)) continue;
        if (unchangedSinceInstall(record, rel, fs.readFileSync(file, 'utf8'))) act(`delete ${rel}`, () => fs.unlinkSync(file));
        else report.kept.push(`${rel}: edited since Rigour created it`);
    }
    for (const rel of KNOWN_SCRIPTS) {
        const file = path.join(cwd, rel);
        if (rel in record.created || !fs.existsSync(file)) continue;
        if (isRigourScript(fs.readFileSync(file, 'utf8'))) act(`delete ${rel}`, () => fs.unlinkSync(file));
    }

    gitHook(cwd, act, report);

    if (options.all) {
        if (fs.existsSync(path.join(cwd, 'rigour.yml'))) act('delete rigour.yml', () => fs.unlinkSync(path.join(cwd, 'rigour.yml')));
        if (fs.existsSync(path.join(cwd, '.rigour'))) act('delete .rigour/', () => fs.rmSync(path.join(cwd, '.rigour'), { recursive: true, force: true }));
        gitignore(cwd, act);
    } else {
        for (const rel of ['rigour.yml', '.rigour']) {
            if (fs.existsSync(path.join(cwd, rel))) report.kept.push(`${rel}: the team's settings, dismissals and ledger (--all removes it)`);
        }
    }

    if (!options.dryRun) removeEmptyDirs(cwd, report.changes);
    return report;
}

function gitHook(cwd: string, act: (change: string, run: () => void) => void, report: UninstallReport): void {
    const hooksDir = git(cwd, ['rev-parse', '--git-path', 'hooks']);
    const top = git(cwd, ['rev-parse', '--show-toplevel']);
    const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!hooksDir || !top || !common) return;
    const file = path.resolve(cwd, hooksDir, 'pre-push');
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    if (!/hooks push --git/.test(text)) return;
    const real = (p: string) => {
        try {
            return fs.realpathSync.native(p);
        } catch {
            return p;
        }
    };
    const home = real(path.dirname(file));
    if (![top, common].some(dir => home === real(dir) || home.startsWith(`${real(dir)}${path.sep}`))) {
        report.kept.push(`${file}: managed outside this repository; remove its Rigour line yourself`);
        return;
    }
    const lines = text.split('\n');
    const own = lines.filter(line => line.trim() && !line.startsWith('#!') && !line.startsWith('#')).every(line => /hooks push --git/.test(line));
    if (own) {
        act(`delete the git pre-push hook (${path.relative(cwd, file)})`, () => fs.unlinkSync(file));
        return;
    }
    const kept = lines.filter(line => line !== APPENDED_COMMENT && !(/hooks push --git/.test(line) && /rigour/i.test(line)));
    // The blank line Rigour put before its comment goes with it.
    const cleaned = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
    act(`remove Rigour's lines from the git pre-push hook (${path.relative(cwd, file)})`, () => fs.writeFileSync(file, cleaned));
}

function gitignore(cwd: string, act: (change: string, run: () => void) => void): void {
    const file = path.join(cwd, '.gitignore');
    if (!fs.existsSync(file)) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const kept = lines.filter(line => !GITIGNORE_LINES.has(line.trim()) && !/^# Rigour Artifacts/.test(line.trim()));
    if (kept.length === lines.length) return;
    // The blank line Rigour put before its block goes with it.
    act('remove Rigour\'s lines from .gitignore', () => fs.writeFileSync(file, kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n')));
}

/** Folders Rigour's files left empty (`.clinerules/hooks`, `.cursor/rules`, `.gemini`), innermost first. */
function removeEmptyDirs(cwd: string, changes: string[]): void {
    const dirs = new Set<string>();
    for (const change of changes) {
        const rel = change.replace(/^delete /, '');
        if (rel === change || rel.endsWith('/') || rel.startsWith('the git')) continue;
        for (let dir = path.dirname(rel); dir !== '.' && dir !== ''; dir = path.dirname(dir)) dirs.add(dir);
    }
    for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
        const full = path.join(cwd, dir);
        try {
            if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
        } catch {
            // already gone, or not ours
        }
    }
}

function git(cwd: string, args: string[]): string | undefined {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : undefined;
}

export function uninstallCommand(cwd: string, options: UninstallOptions): number {
    const report = uninstall(cwd, options);
    const verb = options.dryRun ? 'Would' : 'Did';
    if (report.changes.length === 0) console.log(chalk.dim('Nothing of Rigour\'s to remove here.'));
    for (const change of report.changes) console.log(`  ${chalk.green(options.dryRun ? '•' : '✔')} ${change}`);
    for (const kept of report.kept) console.log(chalk.dim(`  kept ${kept}`));
    if (report.changes.length) console.log(chalk.dim(`\n${verb} ${report.changes.length} change(s).${options.dryRun ? ' Run without --dry-run to apply.' : ''}`));
    return 0;
}
