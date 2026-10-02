/**
 * What `rigour --help` lists. Four commands cover everyday use; every other command still works and
 * is listed by `rigour help --all`.
 */
import { Help, type Command } from 'commander';

export const EVERYDAY_COMMANDS = new Set(['setup', 'review', 'studio', 'doctor']);

/**
 * `rigour help --all` and `rigour --help --all` list every command. Returns argv without the
 * `--all` flag, which only means something to help.
 */
export function configureHelp(program: Command, argv: string[]): string[] {
    const asksForHelp = argv.slice(2).some(arg => arg === 'help' || arg === '--help' || arg === '-h');
    const all = asksForHelp && argv.includes('--all');
    const help = new Help();
    program.configureHelp({
        visibleCommands: (cmd) => {
            const listed = help.visibleCommands(cmd);
            return all || cmd !== program ? listed : listed.filter(c => EVERYDAY_COMMANDS.has(c.name()) || c.name() === 'help');
        },
    });
    if (!all) program.addHelpText('after', '\nEvery command: rigour help --all');
    return all ? argv.filter(arg => arg !== '--all') : argv;
}
