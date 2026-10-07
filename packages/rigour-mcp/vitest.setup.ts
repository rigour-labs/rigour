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
