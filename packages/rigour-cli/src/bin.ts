#!/usr/bin/env node
// The `rigour` command: apply the profile for this repository (home, team) before the rest of
// Rigour loads, since some of its paths are fixed when a module loads (utils/profile.ts).
import { applyProfile } from '@rigour-labs/core/profile';

applyProfile(process.cwd());
await import('./cli.js');
