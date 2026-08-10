import { readJsonSync } from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

function readVersion(packagePath: string): string | null {
    try {
        const pkg = readJsonSync(packagePath) as { version?: string };
        const version = pkg.version?.trim();
        return version && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
            ? version
            : null;
    } catch {
        return null;
    }
}

export function getPinnedCheckerCommand(): string {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const packageCandidates = [
        path.resolve(thisDir, '../../../cli/package.json'),
        path.resolve(thisDir, '../../../rigour-cli/package.json'),
        path.resolve(thisDir, '../../package.json'),
    ];
    const version = packageCandidates
        .map(readVersion)
        .find((candidate): candidate is string => candidate !== null);
    if (!version) {
        throw new Error('Unable to resolve a compatible Rigour CLI version');
    }
    return `npx --yes @rigour-labs/cli@${version} hooks check`;
}
