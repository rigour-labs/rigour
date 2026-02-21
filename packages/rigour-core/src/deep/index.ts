/**
 * Deep Analysis Pipeline — AST → LLM → Verify
 *
 * Step 1: AST extracts structured facts from code
 * Step 2: LLM interprets facts and identifies quality issues
 * Step 3: AST verifies LLM isn't hallucinating
 *
 * Neither AST nor LLM works alone. Together they're accurate.
 */
export { extractFacts, factsToPromptString } from './fact-extractor.js';
export type { FileFacts, ClassFact, FunctionFact, ErrorHandlingFact, StructFact, InterfaceFact } from './fact-extractor.js';
export { buildAnalysisPrompt, buildCrossFilePrompt, chunkFacts, DEEP_SYSTEM_PROMPT } from './prompts.js';
export { verifyFindings } from './verifier.js';
export type { VerifiedFinding } from './verifier.js';
