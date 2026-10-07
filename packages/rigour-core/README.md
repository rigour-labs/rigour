# @rigour-labs/core

[![npm version](https://img.shields.io/npm/v/@rigour-labs/core?color=4f46e5)](https://www.npmjs.com/package/@rigour-labs/core)
[![License: MIT](https://img.shields.io/badge/license-MIT-facc15.svg)](https://opensource.org/licenses/MIT)

The engine behind [Rigour](https://github.com/rigour-labs/rigour): the checks, the review of a change, the
reviewer that runs coding agents' own CLIs as judges, model review, local learning and the team database.

Most people want the command, [@rigour-labs/cli](https://www.npmjs.com/package/@rigour-labs/cli), or the MCP
server, [@rigour-labs/mcp](https://www.npmjs.com/package/@rigour-labs/mcp). This package is for building on
the engine.

```bash
npm install @rigour-labs/core
```

```ts
import { ConfigSchema, reviewChange } from '@rigour-labs/core';

const config = ConfigSchema.parse({});   // or the parsed rigour.yml
const result = await reviewChange({ cwd: process.cwd(), config, source: { mode: 'working' } });
console.log(result.status, result.findings);
```

What each check finds and whether it blocks: [What Rigour checks](https://github.com/rigour-labs/rigour/blob/main/docs/CHECKS.md). Every setting:
[Configuration reference](https://github.com/rigour-labs/rigour/blob/main/docs/CONFIG_REFERENCE.md). Node 22.13 or later.

MIT © [Rigour Labs](https://github.com/rigour-labs)
