/**
 * credential-redirect: a custom credential header is sent with a fetch that
 * may follow redirects.
 *
 * On a cross-origin redirect fetch drops `Authorization` (WHATWG fetch, as
 * implemented by undici) but keeps every custom header, so a token sent as
 * `x-webhook-token` goes to whatever host the target redirects to. The rule
 * follows the header from the call that sets it, through any wrapper that
 * forwards its `init` argument, to the fetch call. A fetch whose init sets
 * `redirect` is treated as handled.
 */
import ts from 'typescript';
import { calledFunction, calleeName, forEachNode, lineOf, locationOf, propertyNameText, relativeFile, snippet, unwrap, type FunctionLike } from '../ast.js';
import { originsOf, propertyValues } from '../origins.js';
import type { Summaries } from '../summaries.js';
import type { RuleContext, SemanticFinding, SemanticRule } from '../types.js';

const CREDENTIAL_HEADER = /^(?:x-[\w-]*(?:token|secret|key|signature|password|auth[\w-]*)|[\w-]*(?:api[-_]?key|secret|access[-_]?token|private[-_]?token))$/i;
/** Removed by fetch (or not settable) on a cross-origin redirect. */
const STRIPPED_ON_REDIRECT = /^(?:authorization|proxy-authorization|cookie)$/i;
const SECRET_ENV = /SECRET|TOKEN|API_?KEY|PASSWORD|PRIVATE_KEY/i;

interface Credential { header: string; node: ts.Node }
/** Where a wrapper's init parameter ends up, and which of its parameters is the URL. */
interface InitSink { fetchCall: ts.CallExpression; urlParam?: number }
/** Parameter index → the fetch call its value reaches without a redirect guard. */
type InitParams = Map<number, InitSink>;

export const credentialRedirect: SemanticRule = {
    id: 'credential-redirect',
    check(ctx: RuleContext): SemanticFinding[] {
        const findings: SemanticFinding[] = [];
        forEachNode(ctx.sourceFile, (node) => {
            if (!ts.isCallExpression(node)) return;
            const finding = isFetchCall(node) ? checkDirect(ctx, node) : checkWrapperCall(ctx, node);
            if (finding) findings.push(finding);
        });
        return findings;
    },
};

function isFetchCall(call: ts.CallExpression): boolean {
    return calleeName(call) === 'fetch' && call.arguments.length >= 2;
}

function checkDirect(ctx: RuleContext, call: ts.CallExpression): SemanticFinding | null {
    const init = call.arguments[1];
    if (setsRedirect(ctx.checker, init)) return null;
    const credential = credentialIn(ctx.checker, init);
    return credential ? finding(ctx, call, credential, call, call.arguments[0]) : null;
}

function checkWrapperCall(ctx: RuleContext, call: ts.CallExpression): SemanticFinding | null {
    const fn = calledFunction(ctx.checker, call);
    if (!fn) return null;
    for (const [index, sink] of initParams(ctx.summaries, fn)) {
        const arg = call.arguments[index];
        if (!arg || setsRedirect(ctx.checker, arg)) continue;
        const credential = credentialIn(ctx.checker, arg);
        const url = sink.urlParam === undefined ? undefined : call.arguments[sink.urlParam];
        if (credential) return finding(ctx, call, credential, sink.fetchCall, url);
    }
    return null;
}

/** Parameters of `fn` that reach a fetch init with no redirect guard. */
function initParams(summaries: Summaries, fn: FunctionLike): InitParams {
    return summaries.memo<InitParams>('credential-redirect:init-params', fn, new Map(), () => {
        const params: InitParams = new Map();
        forEachNode(fn, (node) => {
            if (!ts.isCallExpression(node)) return;
            if (isFetchCall(node)) {
                const urlParam = directParam(summaries.checker, node.arguments[0], fn);
                for (const index of paramsFlowingInto(summaries.checker, node.arguments[1], fn)) params.set(index, { fetchCall: node, urlParam });
                return;
            }
            const inner = calledFunction(summaries.checker, node);
            if (!inner || inner === fn) return;
            for (const [innerIndex, sink] of initParams(summaries, inner)) {
                const arg = node.arguments[innerIndex];
                if (!arg) continue;
                const innerUrl = sink.urlParam === undefined ? undefined : node.arguments[sink.urlParam];
                const urlParam = innerUrl ? directParam(summaries.checker, innerUrl, fn) : undefined;
                for (const index of paramsFlowingInto(summaries.checker, arg, fn)) params.set(index, { fetchCall: sink.fetchCall, urlParam });
            }
        });
        return params;
    });
}

/** The index of `fn`'s parameter that `expr` is, if it is one. */
function directParam(checker: ts.TypeChecker, expr: ts.Expression | undefined, fn: FunctionLike): number | undefined {
    if (!expr) return undefined;
    const origin = originsOf(checker, expr).find(o => o.kind === 'param' && o.fn === fn);
    return origin?.kind === 'param' ? origin.index : undefined;
}

/** `https://host/...` written as a literal (or a template whose host is literal): a fixed endpoint. */
function fixedHttpsHost(checker: ts.TypeChecker, url: ts.Expression | undefined): string | undefined {
    if (!url) return undefined;
    const origins = originsOf(checker, url);
    if (origins.length !== 1 || origins[0].kind !== 'literal') return undefined;
    const node = origins[0].node;
    const text = ts.isStringLiteralLike(node) ? node.text : ts.isTemplateExpression(node) ? templatePrefix(checker, node) : '';
    return text.match(/^https:\/\/([^/${}\s]+)(?:\/|$)/)?.[1];
}

/** Literal start of a template, resolving a leading constant: `${BASE_URL}/task` → "https://host/task". */
function templatePrefix(checker: ts.TypeChecker, node: ts.TemplateExpression): string {
    if (node.head.text || node.templateSpans.length === 0) return node.head.text;
    const [first] = node.templateSpans;
    const origins = originsOf(checker, first.expression);
    const base = origins.length === 1 && origins[0].kind === 'literal' && ts.isStringLiteralLike(origins[0].node) ? origins[0].node.text : '';
    return base ? base + first.literal.text : '';
}

/** Indices of `fn`'s parameters that `expr` passes through (directly or spread) without adding `redirect`. */
function paramsFlowingInto(checker: ts.TypeChecker, expr: ts.Expression, fn: FunctionLike): number[] {
    const indices: number[] = [];
    for (const origin of originsOf(checker, expr)) {
        if (origin.kind === 'param' && origin.fn === fn) indices.push(origin.index);
        if (origin.kind !== 'object' || propertyValues(checker, origin.node, 'redirect').values.length > 0) continue;
        for (const spread of propertyValues(checker, origin.node, 'redirect').spreads) {
            for (const inner of originsOf(checker, spread)) {
                if (inner.kind === 'param' && inner.fn === fn) indices.push(inner.index);
            }
        }
    }
    return indices;
}

/** The init (or an object spread into it) sets `redirect` explicitly. */
function setsRedirect(checker: ts.TypeChecker, init: ts.Expression): boolean {
    return originsOf(checker, init).some(origin =>
        origin.kind === 'object' && propertyValues(checker, origin.node, 'redirect').values.length > 0);
}

/** First custom credential header in an init's `headers`. */
function credentialIn(checker: ts.TypeChecker, init: ts.Expression): Credential | null {
    for (const origin of originsOf(checker, init)) {
        if (origin.kind !== 'object') continue;
        for (const headers of propertyValues(checker, origin.node, 'headers').values) {
            const found = credentialHeader(checker, headers);
            if (found) return found;
        }
    }
    return null;
}

function credentialHeader(checker: ts.TypeChecker, headers: ts.Expression): Credential | null {
    for (const origin of originsOf(checker, headersObject(headers))) {
        if (origin.kind !== 'object') continue;
        for (const prop of origin.node.properties) {
            if (!ts.isPropertyAssignment(prop)) continue;
            const header = propertyNameText(prop.name);
            if (!header || STRIPPED_ON_REDIRECT.test(header)) continue;
            if (CREDENTIAL_HEADER.test(header) || readsSecretEnv(prop.initializer)) return { header, node: prop };
        }
    }
    return null;
}

/** `new Headers({...})` → the object literal inside. */
function headersObject(expr: ts.Expression): ts.Expression {
    const node = unwrap(expr);
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Headers' && node.arguments?.[0]) {
        return node.arguments[0];
    }
    return node;
}

/** `process.env.WEBHOOK_SECRET` (possibly inside a template or `??`). */
function readsSecretEnv(value: ts.Expression): boolean {
    let found = false;
    const walk = (node: ts.Node): void => {
        if (found) return;
        if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)
            && node.expression.name.text === 'env' && ts.isIdentifier(node.expression.expression)
            && node.expression.expression.text === 'process' && SECRET_ENV.test(node.name.text)) {
            found = true;
        } else {
            ts.forEachChild(node, walk);
        }
    };
    walk(value);
    return found;
}

function finding(ctx: RuleContext, call: ts.CallExpression, credential: Credential, fetchCall: ts.CallExpression, url?: ts.Expression): SemanticFinding {
    const fixedHost = fixedHttpsHost(ctx.checker, url);
    const via = fetchCall === call
        ? `\`${snippet(call, 50)}\``
        : `\`${calleeName(call) ?? 'the call'}(...)\`, which forwards it to \`${snippet(fetchCall, 40)}\` (${locationOf(ctx.cwd, fetchCall)})`;
    return {
        rule: 'credential-redirect',
        // A fixed https vendor endpoint only leaks if that vendor redirects across hosts;
        // a configurable or computed target is the risk this rule exists for.
        severity: fixedHost ? 'low' : 'high',
        provenance: 'security',
        file: relativeFile(ctx.cwd, ctx.sourceFile),
        line: lineOf(call),
        message: `The \`${credential.header}\` header is sent through ${via} without \`redirect: "manual"\`. `
            + `fetch drops Authorization on a cross-origin redirect but keeps custom headers, so this credential goes to any host the target redirects to.`
            + (fixedHost ? ` The target is the fixed endpoint ${fixedHost}, so this only matters if that host redirects.` : ''),
        hint: 'Set `redirect: "manual"` (or "error") on the request and treat a 3xx as a failure, or send the credential in the Authorization header.',
        evidence: [locationOf(ctx.cwd, credential.node), `${locationOf(ctx.cwd, fetchCall)} ${snippet(fetchCall, 50)}`],
    };
}
