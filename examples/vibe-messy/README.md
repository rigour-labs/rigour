# Vibe Messy — A Rigour Demo Project

This is an intentionally broken codebase designed to demonstrate Rigour's quality gates.

## What's Wrong With This Code?

1. **God File**: `src/monolith.js` is 500+ lines with everything mixed together
2. **TODO/FIXME Spam**: 50+ unresolved comments
3. **No Documentation**: Missing SPEC.md, ARCH.md, DECISIONS.md
4. **No Tests**: Zero test coverage
5. **Security Issues**: Hardcoded secrets, no validation

## Run the Demo

```bash
# Initialize Rigour
npx @rigour-labs/cli init

# Check quality gates (will FAIL)
npx @rigour-labs/cli check

# Let an agent fix it
npx @rigour-labs/cli run -- <your-agent-command>

# Check again (should PASS)
npx @rigour-labs/cli check
```

## Before/After

### Before
- 1 file with 500+ lines
- 50+ TODOs
- 0 docs
- 0 tests

### After (what Rigour enforces)
- Modular structure (`auth/`, `products/`, `orders/`)
- 0 TODOs (all implemented or removed)
- Complete documentation
- Passing quality gates
