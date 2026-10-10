import chalk from 'chalk';
import { Command } from 'commander';
import {
    backfillTeamEmbeddings,
    doctorTeamConnection,
    explainTeamConnectionError,
    initializeTeamSchema,
    queueLocalLessonsForTeam,
    saveTeamConfiguration,
    searchTeamKnowledge,
    syncTeamOutbox,
} from '@rigour-labs/core';

export const teamCommand = new Command('team').description('Configure and diagnose PostgreSQL team learning');

teamCommand
    .command('init-schema')
    .description('Initialize the PostgreSQL team schema with an administrator connection')
    .requiredOption('--database-url <url>', 'Administrator PostgreSQL URL; remote databases must require TLS')
    .option('--pgvector', 'Enable the optional pgvector semantic knowledge index')
    .action(async (options) => {
        if (!await initializeSchemaOrReport(options.databaseUrl, Boolean(options.pgvector))) return;
        console.log(chalk.green(`Rigour team schema initialized${options.pgvector ? ' with pgvector' : ''}.`));
    });

teamCommand
    .command('configure')
    .description('Configure a provisioned PostgreSQL team database')
    .requiredOption('--database-url <url>', 'PostgreSQL URL; remote databases must require TLS')
    .requiredOption('--organization <id>', 'Organization identifier')
    .requiredOption('--team <id>', 'Team identifier')
    .requiredOption('--actor <id>', 'Actor identifier provisioned for the database role')
    .option('--initialize-schema', 'Create or update the Rigour schema (administrator only)')
    .option('--pgvector', 'Use pgvector to rank team knowledge semantically')
    .option('--repositories <patterns>', "The team's repositories, comma-separated (github.com/acme/*); lessons from any other repository stay on this machine")
    .option('--sync-personal', 'Also send lessons marked personal (default: they stay on this machine)')
    .action(async (options) => {
        if (options.initializeSchema && !await initializeSchemaOrReport(options.databaseUrl, Boolean(options.pgvector))) return;
        const config = {
            databaseUrl: options.databaseUrl,
            organizationId: options.organization,
            teamId: options.team,
            actorId: options.actor,
            semantic: options.pgvector ? {
                provider: 'pgvector' as const,
                model: 'Xenova/all-MiniLM-L6-v2' as const,
                dimensions: 384 as const,
            } : undefined,
            repositories: typeof options.repositories === 'string' ? options.repositories.split(',').map((r: string) => r.trim()).filter(Boolean) : undefined,
            syncPersonal: Boolean(options.syncPersonal),
        };
        if (!config.repositories?.length) console.log(chalk.yellow('No --repositories given: nothing will be sent to the team until you list them.'));
        const result = await doctorTeamConnection(config);
        if (result.connectivity !== 'online') {
            console.error(chalk.red(`Team database check failed; configuration not saved. ${result.message}`));
            process.exitCode = 1;
            return;
        }
        await saveTeamConfiguration(config);
        console.log(chalk.green(result.message));
    });

teamCommand
    .command('doctor')
    .description('Verify team database TLS, schema, role, and membership')
    .action(async () => {
        const result = await doctorTeamConnection();
        console.log(JSON.stringify(result, null, 2));
        if (result.connectivity === 'offline') process.exitCode = 1;
    });

teamCommand
    .command('semantic-backfill')
    .description('Embed existing validated knowledge owned by the configured actor')
    .option('--limit <count>', 'Maximum lessons to embed in this run', '200')
    .action(async (options) => {
        const limit = Number.parseInt(options.limit, 10);
        if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer.');
        console.log(JSON.stringify(await backfillTeamEmbeddings(limit), null, 2));
    });

teamCommand
    .command('semantic-search')
    .description('Diagnose advisory cross-repository knowledge recall')
    .argument('<query>', 'Natural-language engineering question')
    .option('--limit <count>', 'Maximum candidates to return', '8')
    .action(async (query, options) => {
        const limit = Number.parseInt(options.limit, 10);
        if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error('--limit must be between 1 and 25.');
        console.log(JSON.stringify(await searchTeamKnowledge(query, limit), null, 2));
    });

teamCommand
    .command('import-local')
    .description('Queue existing SQLite lessons for PostgreSQL team synchronization')
    .argument('[repositories...]', 'Repository paths to import; defaults to the current repository')
    .option('--dry-run', 'Report eligible lessons without changing the local cache or outbox')
    .action(async (repositories: string[], options) => {
        const paths = repositories.length > 0 ? repositories : [process.cwd()];
        const result = await queueLocalLessonsForTeam(paths, { dryRun: Boolean(options.dryRun) });
        console.log(JSON.stringify(result, null, 2));
        if (!options.dryRun && result.queued > 0) {
            console.log(chalk.dim('Run `rigour team sync` to send the queued lessons to PostgreSQL.'));
        }
    });

teamCommand
    .command('sync')
    .description("Send queued lessons from the team's repositories, and your decisions on this repository's review lessons; receive the team's")
    .option('--dry-run', 'Report pending records without sending them')
    .action(async (options) => {
        const result = await syncTeamOutbox({ dryRun: Boolean(options.dryRun), cwd: process.cwd() });
        console.log(JSON.stringify(result, null, 2));
    });

/** Initialize the schema, or print why it failed (with the fix) and set exit code 1. */
async function initializeSchemaOrReport(databaseUrl: string, pgvector: boolean): Promise<boolean> {
    try {
        await initializeTeamSchema(databaseUrl, { pgvector });
        return true;
    } catch (error) {
        console.error(chalk.red(`Schema initialization failed. ${explainTeamConnectionError(error)}`));
        process.exitCode = 1;
        return false;
    }
}
