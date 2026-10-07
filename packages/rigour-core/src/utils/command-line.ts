/**
 * A `commands:` entry from rigour.yml as a program and its arguments. Run without a shell, so pipes,
 * `&&` and variable assignments are not interpreted: a team that needs them points at a script.
 */
export function splitCommand(command: string): { bin: string; args: string[] } {
    const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [command];
    return { bin: parts[0], args: parts.slice(1).map(arg => arg.replace(/^["']|["']$/g, '')) };
}
