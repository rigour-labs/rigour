/**
 * Firewall CLI — transact, adversarial replay, CI admit.
 */
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import yaml from 'yaml';
import { Command } from 'commander';
import {
    TransactionRunner,
    runAdversarialCorpus,
    persistAdversarialReport,
    createAttestation,
    admitForCi,
    loadLatestAttestation,
    verifyAttestation,
    loadCurrentTransaction,
    listTransactions,
    GateRunner,
    ConfigSchema,
    loadAgentScopesFromDisk,
    getRepositoryControlId,
    getTrustedControlDir,
    issueTrustedGrant,
    listExecutionReceipts,
    loadGatewayConfig,
    saveGatewayConfig,
    validateGatewayConfig,
    verifyExecutionReceiptChain,
} from '@rigour-labs/core';

async function loadFirewallConfig(cwd: string) {
    const configPath = path.join(cwd, 'rigour.yml');
    if (!await fs.pathExists(configPath)) return ConfigSchema.parse({ version: 1 });
    return ConfigSchema.parse(yaml.parse(await fs.readFile(configPath, 'utf-8')));
}

export async function firewallTransactCommand(
    cwd: string,
    options: { agent?: string; scope?: string; discard?: boolean; commit?: boolean },
) {
    if (options.discard) {
        const current = await loadCurrentTransaction(cwd);
        if (!current) {
            console.error(chalk.red('No current transaction to discard'));
            process.exit(1);
        }
        const discarded = await TransactionRunner.fromRecord(cwd, current).discard();
        console.log(chalk.yellow(`DISCARD ${discarded.id}`));
        return;
    }

    const registered = await loadAgentScopesFromDisk(cwd);
    if (registered.length > 0 && !options.agent) {
        console.error(chalk.red('Agent scopes are registered — pass --agent <id> to bind the writer (fail-closed)'));
        process.exit(1);
    }

    const scope = (options.scope || '**/*').split(',').map(s => s.trim()).filter(Boolean);
    const tx = new TransactionRunner(cwd, { agentId: options.agent, scope });
    const started = await tx.start();
    console.log(chalk.cyan(`START transaction ${started.id}`));
    const gateCwd = started.worktreePath || cwd;
    if (started.worktreePath) {
        console.log(chalk.dim(`Worktree: ${started.worktreePath}`));
    }

    try {
        await tx.syncWorktreeChanges();
    } catch (e: any) {
        await tx.discard();
        console.error(chalk.red(`DISCARD — scope/budget: ${e.message}`));
        process.exit(1);
    }

    const config = await loadFirewallConfig(cwd);
    const runner = new GateRunner(config);
    const { ok, gateResults } = await tx.verify(async () => {
        const report = await runner.run(gateCwd);
        const failedGates = [...new Set(report.failures.map(f => f.id))];
        return { status: report.status, failedGates, score: report.stats.score };
    });

    if (!ok) {
        const discarded = await tx.discard();
        console.log(chalk.red(`DISCARD ${discarded.id} — gates ${gateResults.status}`));
        process.exit(1);
    }

    const committed = await tx.commit();
    const attestation = await createAttestation(cwd, {
        transaction: committed,
        gateResults: {
            status: gateResults.status,
            score: gateResults.score,
            failedGates: gateResults.failedGates,
        },
        verifyRoot: gateCwd,
    });
    console.log(chalk.green(`COMMIT ${committed.id}`));
    console.log(chalk.green(
        `Attestation ${attestation.signature.slice(0, 12)}… tree=${(attestation.treeDigest || '').slice(0, 12)} policy=${attestation.policyHash}`,
    ));
}

export async function firewallAdversarialCommand(cwd: string) {
    const report = runAdversarialCorpus();
    const out = await persistAdversarialReport(cwd, report);
    console.log(chalk.bold(`Adversarial replay: ${report.passed} passed, ${report.failed} failed`));
    for (const r of report.results) {
        const mark = r.passed ? chalk.green('PASS') : chalk.red('FAIL');
        console.log(`  ${mark} ${r.caseId}: expected=${r.expected} actual=${r.actual} — ${r.reason}`);
        if (r.suggestedRule) {
            console.log(chalk.yellow('    suggested regression:\n') + chalk.dim(r.suggestedRule));
        }
    }
    console.log(chalk.dim(`Report: ${out}`));
    if (report.failed > 0) process.exit(1);
}

export async function firewallAdmitCommand(cwd: string) {
    const result = await admitForCi(cwd);
    if (!result.admit) {
        console.error(chalk.red(`ADMIT DENIED: ${result.reason}`));
        process.exit(1);
    }
    const bundle = await loadLatestAttestation(cwd);
    const valid = bundle ? await verifyAttestation(cwd, bundle) : false;
    console.log(chalk.green(`ADMIT OK: ${result.reason} (signature ${valid ? 'valid' : 'n/a'})`));
}

export async function firewallStatusCommand(cwd: string) {
    const current = await loadCurrentTransaction(cwd);
    const txs = await listTransactions(cwd);
    const attestation = await loadLatestAttestation(cwd);
    const advPath = path.join(cwd, '.rigour', 'adversarial-report.json');
    const adv = await fs.pathExists(advPath) ? await fs.readJson(advPath) : null;

    console.log(chalk.bold('Firewall status'));
    console.log(`  Current TX: ${current ? `${current.id} (${current.status})` : 'none'}`);
    console.log(`  Transactions: ${txs.length}`);
    console.log(`  Attestation: ${attestation ? `${attestation.transactionId} gates=${attestation.gateResults.status}` : 'none'}`);
    console.log(`  Adversarial: ${adv ? `${adv.passed} pass / ${adv.failed} fail` : 'not run'}`);
    let gatewayStatus = 'not configured';
    try {
        const gateway = await loadGatewayConfig(cwd);
        if (gateway) gatewayStatus = `${gateway.mode} (${Object.keys(gateway.servers).length} downstream)`;
    } catch (error: any) {
        gatewayStatus = `invalid — ${error?.message ?? String(error)}`;
    }
    const chain = await verifyExecutionReceiptChain(cwd);
    console.log(`  Gateway: ${gatewayStatus}`);
    console.log(`  Trusted state: ${getTrustedControlDir(cwd)}`);
    console.log(`  Receipt chain: ${chain.valid ? `${chain.count} valid` : `INVALID — ${chain.reason}`}`);
}

async function gatewayConfigureCommand(cwd: string, source: string) {
    const configPath = path.resolve(cwd, source);
    const config = validateGatewayConfig(await fs.readJson(configPath));
    const destination = await saveGatewayConfig(cwd, config);
    console.log(chalk.green(`Gateway configured in ${config.mode} mode`));
    console.log(`  Repository id: ${getRepositoryControlId(cwd)}`);
    console.log(`  Trusted config: ${destination}`);
    console.log(chalk.dim('Configure the agent host to use `rigour-mcp --gateway --repo <absolute-repo-path>`.'));
}

async function gatewayGrantCommand(cwd: string, options: {
    agent: string;
    task: string;
    tool: string;
    issuer?: string;
    ttl?: string;
    parent?: string;
}) {
    const config = await loadGatewayConfig(cwd);
    if (!config) throw new Error('Gateway is not configured');
    if (options.agent !== config.agentId || options.task !== config.taskId) {
        throw new Error('Grant agent and task must match the trusted gateway configuration');
    }
    const separator = options.tool.indexOf('__');
    if (separator < 1 || separator === options.tool.length - 2) {
        throw new Error('--tool must use the gateway name server__tool');
    }
    const server = options.tool.slice(0, separator);
    const tool = options.tool.slice(separator + 2);
    const downstream = config.servers[server];
    if (!downstream || (!downstream.allow.includes('*') && !downstream.allow.includes(tool))) {
        throw new Error(`Tool ${options.tool} is not allowed by the trusted gateway configuration`);
    }
    const ttlSeconds = Number(options.ttl ?? '300');
    const grant = await issueTrustedGrant(cwd, {
        issuerId: options.issuer ?? config.principalId,
        subjectId: options.agent,
        taskId: options.task,
        action: 'mcp.call',
        resource: `mcp://${server}/${tool}`,
        ttlMs: ttlSeconds * 1_000,
        parentCapabilityId: options.parent,
    });
    console.log(chalk.green(`Capability ${grant.id}`));
    console.log(`  Subject: ${grant.subjectId}`);
    console.log(`  Resource: ${grant.resource}`);
    console.log(`  Expires: ${new Date(grant.expiresAt).toISOString()}`);
}

async function gatewayReceiptsCommand(cwd: string, options: { limit?: string }) {
    const receipts = await listExecutionReceipts(cwd, Number(options.limit ?? '20'));
    if (receipts.length === 0) {
        console.log('No gateway receipts recorded.');
        return;
    }
    for (const receipt of receipts) {
        const simulated = receipt.simulatedDecision ? ` would=${receipt.simulatedDecision}` : '';
        console.log(`${receipt.createdAt} ${receipt.decision}${simulated} ${receipt.action.resource} ${receipt.outcome} ${receipt.id}`);
    }
}

export function createFirewallCommand(): Command {
    const command = new Command('firewall')
        .description('Agent Transaction Firewall — mediate, attest, and prove damage bounds');

    command.command('status')
        .description('Show transaction, gateway, receipt, and attestation status')
        .action(async () => firewallStatusCommand(process.cwd()));
    command.command('transact')
        .description('Start a mediated transaction, verify gates, COMMIT or DISCARD')
        .option('--agent <id>', 'Agent id for scope binding')
        .option('--scope <globs>', 'Comma-separated allowed path globs', '**/*')
        .option('--discard', 'Discard the current transaction worktree')
        .action(async (options: any) => firewallTransactCommand(process.cwd(), options));
    command.command('adversarial')
        .description('Replay deterministic adversarial corpus against the firewall kernel')
        .action(async () => firewallAdversarialCommand(process.cwd()));
    command.command('admit')
        .description('CI admission: require valid signed attestation with PASS gates')
        .action(async () => firewallAdmitCommand(process.cwd()));
    command.command('gateway-configure')
        .description('Install a trusted MCP gateway configuration outside the repository')
        .requiredOption('--config <path>', 'JSON gateway configuration')
        .action(async (options: { config: string }) => gatewayConfigureCommand(process.cwd(), options.config));
    command.command('grant')
        .description('Issue an explicit one-use MCP capability')
        .requiredOption('--agent <id>', 'Capability subject agent id')
        .requiredOption('--task <id>', 'Bound task id')
        .requiredOption('--tool <server__tool>', 'Namespaced gateway tool')
        .option('--issuer <id>', 'Human or delegating agent id (defaults to configured principal)')
        .option('--ttl <seconds>', 'Validity in seconds', '300')
        .option('--parent <capability-id>', 'Parent capability for delegated authority')
        .action(async (options: any) => gatewayGrantCommand(process.cwd(), options));
    command.command('receipts')
        .description('Show recent signed gateway execution receipts')
        .option('--limit <count>', 'Maximum receipts', '20')
        .action(async (options: any) => gatewayReceiptsCommand(process.cwd(), options));
    return command;
}
