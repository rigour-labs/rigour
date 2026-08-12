/**
 * Firewall CLI — transact, adversarial replay, CI admit.
 */
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import yaml from 'yaml';
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
} from '@rigour-labs/core';

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

    const scope = (options.scope || '**/*').split(',').map(s => s.trim()).filter(Boolean);
    const tx = new TransactionRunner(cwd, { agentId: options.agent, scope });
    const started = await tx.start();
    console.log(chalk.cyan(`START transaction ${started.id}`));
    if (started.worktreePath) {
        console.log(chalk.dim(`Worktree: ${started.worktreePath}`));
    }

    const configPath = path.join(cwd, 'rigour.yml');
    let config = ConfigSchema.parse({ version: 1 });
    if (await fs.pathExists(configPath)) {
        config = ConfigSchema.parse(yaml.parse(await fs.readFile(configPath, 'utf-8')));
    }
    const runner = new GateRunner(config);
    const { ok, gateResults } = await tx.verify(async () => {
        const report = await runner.run(cwd);
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
    });
    console.log(chalk.green(`COMMIT ${committed.id}`));
    console.log(chalk.green(`Attestation ${attestation.signature.slice(0, 12)}… policy=${attestation.policyHash}`));
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
}
