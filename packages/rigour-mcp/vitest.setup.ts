import fs from 'fs';
import os from 'os';
import path from 'path';

// The same isolation as core's and the CLI's: a throwaway Rigour home and agent home, no profiles, no reviewer choice
// from the shell, and never the person's real Claude Code CLI.
delete process.env.RIGOUR_REVIEWER_MODE;
delete process.env.RIGOUR_REVIEWER_PANEL;
process.env.RIGOUR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-home-'));
process.env.RIGOUR_PROFILES = path.join(process.env.RIGOUR_HOME, 'no-profiles.json');
process.env.RIGOUR_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-agent-home-'));
process.env.RIGOUR_CLAUDE_CLI = path.join(process.env.RIGOUR_AGENT_HOME, 'no-claude-cli');
// git run by a test, or by the code under test, never starts its own garbage collection or maintenance: a git still
// writing pack files after a test races the test's cleanup of its temporary repository (ENOTEMPTY on .git/objects/pack).
process.env.GIT_CONFIG_COUNT = '2';
process.env.GIT_CONFIG_KEY_0 = 'gc.auto';
process.env.GIT_CONFIG_VALUE_0 = '0';
process.env.GIT_CONFIG_KEY_1 = 'maintenance.auto';
process.env.GIT_CONFIG_VALUE_1 = 'false';
