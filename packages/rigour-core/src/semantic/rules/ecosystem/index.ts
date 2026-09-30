/**
 * Ecosystem rules: framework, library and packaging knowledge, each gated on the
 * file's own dependencies or shape. A rule stays in this list only if it passes
 * validation on repositories it was not designed from (driftbench rlaif/rules):
 * it catches real fixes, is quiet on code as it stands, and its hits are right.
 */
import type { SemanticRule } from '../../types.js';
import { depsCodegenUndeclaredImport } from './deps-codegen-undeclared-import.js';
import { depsInternalSymbol } from './deps-internal-symbol.js';
import { domSelfQueryInComponent } from './dom-self-query-in-component.js';
import { envBareBrowserGlobal } from './env-bare-browser-global.js';
import { exportsConditionParity } from './exports-condition-parity.js';
import { exportsForgottenType } from './exports-forgotten-type.js';
import { importsBarrelCycle } from './imports-barrel-cycle.js';
import { pathsUnnormalizedModuleKey } from './paths-unnormalized-module-key.js';
import { reactInlineHtmlObject } from './react-inline-html-object.js';
import { solidJsxAndConditional } from './solid-jsx-and-conditional.js';
import { tsInternalInPublicSignature } from './ts-internal-in-public-signature.js';
import { viteRollupOnlyHookField } from './vite-rollup-only-hook-field.js';
import { vueStaticComputed } from './vue-static-computed.js';

export const ECOSYSTEM_RULES: SemanticRule[] = [
    solidJsxAndConditional, vueStaticComputed, reactInlineHtmlObject, tsInternalInPublicSignature,
    depsInternalSymbol, depsCodegenUndeclaredImport, viteRollupOnlyHookField, pathsUnnormalizedModuleKey,
    domSelfQueryInComponent, envBareBrowserGlobal, exportsConditionParity, exportsForgottenType, importsBarrelCycle,
];
