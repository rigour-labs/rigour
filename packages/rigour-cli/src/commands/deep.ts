/**
 * Deep Command — prepare local deep analysis.
 *
 * `rigour deep pull` installs the llama.cpp engine and the analysis model
 * ahead of time, so a CI job can cache ~/.rigour/bin and ~/.rigour/models
 * and the first `rigour check --deep` does no downloading.
 */
import chalk from 'chalk';
import { Command } from 'commander';
import { EXIT_PASS, EXIT_INTERNAL_ERROR } from './exit-codes.js';

export const deepCommand = new Command('deep')
    .description('Prepare local deep analysis (engine and model)');

deepCommand
    .command('pull')
    .description('Download and verify the local inference engine and model')
    .option('--pro', 'Pull the full model (Qwen2.5-Coder-1.5B) instead of lite')
    .addHelpText('after', `
Examples:
  $ rigour deep pull            # engine + lite model (Qwen2.5-Coder-0.5B)
  $ rigour deep pull --pro      # engine + full model (Qwen2.5-Coder-1.5B)

CI: cache ~/.rigour/bin and ~/.rigour/models between runs.
    `)
    .action(async (options: { pro?: boolean }) => {
        process.exit(await deepPullCommand(!!options.pro));
    });

export async function deepPullCommand(pro: boolean): Promise<number> {
    const { SidecarProvider, getCachedModel } = await import('@rigour-labs/core');
    const provider = new SidecarProvider(pro ? 'deep' : 'lite');
    try {
        await provider.prepare((msg: string) => process.stderr.write(msg + '\n'));
        const engine = await provider.findEngine();
        const model = await getCachedModel(pro ? 'deep' : 'lite');
        console.log(chalk.green(`✓ Engine: ${engine?.path ?? 'unknown'}${engine?.version ? ` (llama.cpp ${engine.version})` : ''}`));
        console.log(chalk.green(`✓ Model:  ${model?.info.name ?? 'unknown'}`));
        return EXIT_PASS;
    } catch (error: any) {
        console.error(chalk.red(`Deep pull failed: ${error?.message ?? String(error)}`));
        return EXIT_INTERNAL_ERROR;
    }
}
