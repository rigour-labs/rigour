import chalk from 'chalk';
import { Command } from 'commander';
import {
    backfillTeamEmbeddings,
    doctorTeamConnection,
    initializeTeamSchema,
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
        await initializeTeamSchema(options.databaseUrl, { pgvector: Boolean(options.pgvector) });
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
    .action(async (options) => {
        if (options.initializeSchema) await initializeTeamSchema(options.databaseUrl, { pgvector: Boolean(options.pgvector) });
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
        };
        const result = await doctorTeamConnection(config);
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
    .command('sync')
    .description('Synchronize approved team lessons from the offline outbox')
    .option('--dry-run', 'Report pending records without sending them')
    .action(async (options) => {
        const result = await syncTeamOutbox({ dryRun: Boolean(options.dryRun) });
        console.log(JSON.stringify(result, null, 2));
    });
