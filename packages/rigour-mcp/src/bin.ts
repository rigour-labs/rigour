#!/usr/bin/env node
// The `rigour-mcp` server: apply the profile for the repository it serves (RIGOUR_CWD, else where it
// started) before the rest of Rigour loads; each call is then checked against it (index.ts).
import { applyProfile } from '@rigour-labs/core/profile';

applyProfile(process.env.RIGOUR_CWD || process.cwd());
await import('./index.js');
