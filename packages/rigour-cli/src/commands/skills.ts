import chalk from 'chalk';
import { Command } from 'commander';
import fs from 'fs-extra';
import path from 'path';

export const RIGOUR_SKILLS = ['context', 'verify', 'handoff'] as const;
export type RigourSkill = typeof RIGOUR_SKILLS[number];

type SkillTarget = 'codex' | 'cursor' | 'universal';
const SKILL_TARGETS: SkillTarget[] = ['codex', 'cursor', 'universal'];

export interface SkillsInstallOptions {
    target?: string;
    force?: boolean;
    dryRun?: boolean;
}

interface SkillDefinition {
    title: string;
    description: string;
    instructions: string;
}

const SKILL_DEFINITIONS: Record<RigourSkill, SkillDefinition> = {
    context: {
        title: 'Rigour context',
        description: 'Get the smallest evidence-backed codebase scope before implementing a task.',
        instructions: `Use this before exploring or changing a codebase for a bounded task.

1. State the task in one sentence, then call \`rigour_recall\` for relevant project memory.
2. Call \`rigour_context_scope\` with that task before reading source files. Work from the returned scope; do not replace it with a repository-wide scan.
3. If the response says the index is missing or stale, call \`rigour_index\`, then request the scope again.
4. Before creating a new component, function, class, or hook, call \`rigour_check_pattern\`.
5. Preserve the scope receipt: report what Rigour selected, excluded, reused from cache, or could not determine.

The scope is evidence-backed guidance, not permission to make unrelated edits. If the task needs a file outside the scope, explain why and request a refined scope first.`,
    },
    verify: {
        title: 'Rigour verify',
        description: 'Close an engineering task with deterministic proof and a repair loop when needed.',
        instructions: `Use this after an implementation, repair, or review that changes observable project behavior.

1. Run \`rigour_check\` before claiming the task is complete. Use the project’s normal test command as well when the change needs it.
2. If Rigour reports a failure, call \`rigour_get_fix_packet\`. Repair the actual finding; do not weaken \`rigour.yml\`, add ignores, or suppress a rule to obtain a pass.
3. Re-run the failed verification after every repair. Stop and surface the evidence if the fix would change a team policy, the task scope, or an external system.
4. Finish with the proof: checks run, result, relevant Fix Packet outcome, and any verification that remains unavailable.

Rigour advice and an agent’s self-report are not verification. A passing deterministic result or an explicit, visible limitation is required.`,
    },
    handoff: {
        title: 'Rigour handoff',
        description: 'Transfer agent work as a compact, evidence-backed checkpoint instead of a long recap.',
        instructions: `Use this when pausing work, switching agents, or handing a bounded task to a teammate.

1. Call \`rigour_checkpoint\` before the handoff. Include the task, files changed, decisions made, verification results, and unresolved risk.
2. Call \`rigour_handoff\` with the receiving scope. Keep the human summary short and link it to the checkpoint instead of replaying the full exploration history.
3. The receiving agent calls \`rigour_handoff_accept\`, then \`rigour_agent_register\` to claim its scope before editing.
4. Preserve failures, conflicts, and unverified assumptions in the packet. They are evidence for learning, not reusable rules.

Do not claim a successful handoff merely because a summary was written. It is complete only when the receiving agent has accepted the scoped packet or the handoff is visibly pending.`,
    },
};

function isRigourSkill(value: string): value is RigourSkill {
    return (RIGOUR_SKILLS as readonly string[]).includes(value);
}

function resolveSkills(requested: string[]): RigourSkill[] {
    if (requested.length === 0 || requested.includes('all')) return [...RIGOUR_SKILLS];

    const invalid = requested.filter((skill) => !isRigourSkill(skill));
    if (invalid.length > 0) {
        throw new Error(`Unknown skill: ${invalid.join(', ')}. Available: ${RIGOUR_SKILLS.join(', ')}, all`);
    }
    return requested as RigourSkill[];
}

function resolveTargets(value?: string): SkillTarget[] {
    if (!value || value === 'all') return [...SKILL_TARGETS];

    const targets = value.split(',').map((target) => target.trim().toLowerCase());
    const invalid = targets.filter((target) => !SKILL_TARGETS.includes(target as SkillTarget));
    if (invalid.length > 0) {
        throw new Error(`Unknown target: ${invalid.join(', ')}. Available: ${SKILL_TARGETS.join(', ')}, all`);
    }
    return targets as SkillTarget[];
}

function codexSkillContent(skill: RigourSkill): string {
    const definition = SKILL_DEFINITIONS[skill];
    return `---
name: rigour-${skill}
description: ${definition.description}
---

# ${definition.title}

${definition.instructions}
`;
}

function cursorCommandContent(skill: RigourSkill): string {
    const definition = SKILL_DEFINITIONS[skill];
    return `# ${definition.title}

${definition.description}

${definition.instructions}
`;
}

function universalPlaybookContent(skill: RigourSkill): string {
    const definition = SKILL_DEFINITIONS[skill];
    return `# ${definition.title}

${definition.description}

This is a portable Rigour playbook. Add it to an agent's project instructions or invoke it as a workflow in any MCP-capable coding agent.

${definition.instructions}
`;
}

function targetPath(cwd: string, target: SkillTarget, skill: RigourSkill): string {
    switch (target) {
        case 'codex':
            return path.join(cwd, '.agents', 'skills', `rigour-${skill}`, 'SKILL.md');
        case 'cursor':
            return path.join(cwd, '.cursor', 'commands', `rigour-${skill}.md`);
        case 'universal':
            return path.join(cwd, 'docs', 'rigour-skills', `rigour-${skill}.md`);
    }
}

function targetContent(target: SkillTarget, skill: RigourSkill): string {
    if (target === 'codex') return codexSkillContent(skill);
    if (target === 'cursor') return cursorCommandContent(skill);
    return universalPlaybookContent(skill);
}

async function writeSkillFile(filePath: string, content: string, options: SkillsInstallOptions): Promise<'created' | 'skipped' | 'preview'> {
    if (await fs.pathExists(filePath) && !options.force) return 'skipped';
    if (options.dryRun) return 'preview';

    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content);
    return 'created';
}

export async function installSkills(cwd: string, requested: string[], options: SkillsInstallOptions = {}): Promise<void> {
    const skills = resolveSkills(requested);
    const targets = resolveTargets(options.target);

    console.log(chalk.bold.cyan('\nRigour Skills\n'));
    for (const target of targets) {
        for (const skill of skills) {
            const filePath = targetPath(cwd, target, skill);
            const result = await writeSkillFile(filePath, targetContent(target, skill), options);
            const relativePath = path.relative(cwd, filePath);
            if (result === 'created') console.log(chalk.green(`  ✓ ${target}: ${relativePath}`));
            if (result === 'preview') console.log(chalk.cyan(`  ○ would create ${target}: ${relativePath}`));
            if (result === 'skipped') console.log(chalk.yellow(`  ↷ kept existing ${target}: ${relativePath} (use --force to replace)`));
        }
    }

    if (!options.dryRun) {
        console.log(chalk.dim('\nCodex discovers .agents/skills automatically. In Cursor, type /rigour- to run a playbook.'));
        console.log(chalk.dim('Portable copies are in docs/rigour-skills for MCP-capable agents without a native skill format.\n'));
    }
}

export function listSkills(): void {
    console.log(chalk.bold.cyan('\nRigour Skills\n'));
    for (const skill of RIGOUR_SKILLS) {
        console.log(`  ${chalk.bold(`rigour-${skill}`)} — ${SKILL_DEFINITIONS[skill].description}`);
    }
    console.log(chalk.dim('\nInstall: rigour skills install --target codex,cursor\n'));
}

export async function skillsDoctor(cwd: string): Promise<void> {
    console.log(chalk.bold.cyan('\nRigour Skills Doctor\n'));
    let missing = 0;
    for (const target of SKILL_TARGETS) {
        const states = await Promise.all(RIGOUR_SKILLS.map(async (skill) => {
            const exists = await fs.pathExists(targetPath(cwd, target, skill));
            return exists ? chalk.green('ready') : chalk.yellow('missing');
        }));
        missing += states.filter((state) => state.includes('missing')).length;
        console.log(`  ${chalk.bold(target)}: ${states.join(', ')}`);
    }

    if (missing > 0) {
        console.log(chalk.dim('\nInstall missing playbooks: rigour skills install --target all\n'));
    } else {
        console.log(chalk.green('\n  ✓ All Rigour playbooks are installed.\n'));
    }
}

export function createSkillsCommand(): Command {
    const command = new Command('skills')
        .description('Install portable Rigour playbooks for coding agents');

    command
        .command('list', { isDefault: true })
        .description('List the available evidence-backed playbooks')
        .action(() => {
            listSkills();
        });

    command
        .command('install [skills...]')
        .description('Install playbooks for Codex, Cursor, or portable project instructions')
        .option('-t, --target <targets>', 'codex, cursor, universal, or all', 'all')
        .option('-f, --force', 'Replace existing Rigour playbooks')
        .option('--dry-run', 'Show files without writing them')
        .addHelpText('after', `
Examples:
  $ rigour skills install                         # Context, verify, and handoff everywhere
  $ rigour skills install context verify -t codex # Native Codex skills only
  $ rigour skills install handoff -t cursor       # Cursor slash command only
  $ rigour skills install --dry-run               # Preview without writing files
    `)
        .action(async (skills: string[], options: SkillsInstallOptions) => {
            await installSkills(process.cwd(), skills, options);
        });

    command
        .command('doctor')
        .description('Show which agent-specific playbooks are installed')
        .action(async () => {
            await skillsDoctor(process.cwd());
        });

    return command;
}
