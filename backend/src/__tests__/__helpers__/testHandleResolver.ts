/**
 * Resolves a (file, exact test title) proof handle against real vitest
 * source, using the TypeScript compiler API rather than a string search.
 *
 * A string search accepts a commented-out test, a `.skip`-ed test, or a
 * duplicate title landing on the wrong declaration. This walks the actual
 * AST: it finds every `it`/`test` declaration with that literal title,
 * rejects any declaration carrying a skip-shaped modifier (`.skip`, `.todo`,
 * `.failing`, `.only`, `.each`, `.skipIf`, `.runIf`) directly, and rejects
 * any declaration nested under an enclosing `describe` that is unconditionally
 * skipped or conditionally skipped by anything other than
 * `describe.skipIf(...)` whose predicate calls one of the approved hardened
 * dependency probes (`requireGitBinary`, `requireSshd` from
 * `./externalDeps`). `describe.skip` and `describe.runIf` are never
 * approved, at any nesting depth.
 */
import ts from 'typescript';

export const APPROVED_GUARD_HELPERS = ['requireGitBinary', 'requireSshd'];

const SKIP_SHAPED_MODIFIERS = new Set(['skip', 'todo', 'failing', 'only', 'each', 'skipIf', 'runIf']);

export type HandleResolution =
    | { ok: true }
    | { ok: false; reason: 'not-found' | 'duplicate' | 'skipped-directly' | 'unapproved-ancestor-skip' };

interface CallShape {
    kind: string;
    modifier: string | null;
    /** For a curried modifier (`X.skipIf(pred)(title, fn)`), the inner call's first argument. */
    predicateArg?: ts.Node;
}

const CURRIED_MODIFIERS = new Set(['skipIf', 'runIf', 'each']);

function classifyCall(node: ts.CallExpression): CallShape | null {
    const expr = node.expression;

    // Direct form: describe('x', fn) / describe.skip('x', fn) / it.todo('x').
    if (ts.isIdentifier(expr)) {
        return { kind: expr.text, modifier: null };
    }
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
        return { kind: expr.expression.text, modifier: expr.name.text };
    }

    // Curried form: X.skipIf(pred)(title, fn) / X.runIf(pred)(title, fn) /
    // X.each(cases)(title, fn): the outer call's expression is itself a
    // CallExpression whose own expression is the X.modifier access.
    if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && ts.isIdentifier(expr.expression.expression)) {
        const modifier = expr.expression.name.text;
        if (CURRIED_MODIFIERS.has(modifier)) {
            return { kind: expr.expression.expression.text, modifier, predicateArg: expr.arguments[0] };
        }
    }
    return null;
}

function predicateCallsApprovedHelper(argNode: ts.Node): boolean {
    let found = false;
    const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && APPROVED_GUARD_HELPERS.includes(n.expression.text)) {
            found = true;
        }
        ts.forEachChild(n, visit);
    };
    visit(argNode);
    return found;
}

function stringLiteralText(node: ts.Node | undefined): string | null {
    if (node && ts.isStringLiteralLike(node)) return node.text;
    return null;
}

function functionBodyArgument(node: ts.CallExpression): ts.ArrowFunction | ts.FunctionExpression | undefined {
    return node.arguments.find((a): a is ts.ArrowFunction | ts.FunctionExpression =>
        ts.isArrowFunction(a) || ts.isFunctionExpression(a));
}

type AncestorState = 'none' | 'approved' | 'unapproved';

interface FoundDeclaration {
    title: string;
    ownModifier: string | null;
    ancestorState: AncestorState;
}

function collectDeclarations(sourceFile: ts.SourceFile): FoundDeclaration[] {
    const found: FoundDeclaration[] = [];

    function walk(node: ts.Node, ancestorState: AncestorState): void {
        if (ts.isCallExpression(node)) {
            const classified = classifyCall(node);
            if (classified?.kind === 'describe') {
                let nextState: AncestorState = ancestorState;
                if (ancestorState !== 'unapproved') {
                    if (classified.modifier === 'skip' || classified.modifier === 'runIf') {
                        nextState = 'unapproved';
                    } else if (classified.modifier === 'skipIf') {
                        const predicate = classified.predicateArg;
                        nextState = predicate && predicateCallsApprovedHelper(predicate) ? 'approved' : 'unapproved';
                    } else if (classified.modifier === 'only' || classified.modifier === 'each' || classified.modifier === 'todo') {
                        // Scoping/parameterization modifiers on describe don't skip
                        // this suite's tests; leave ancestorState unchanged.
                        nextState = ancestorState;
                    }
                }
                const callback = functionBodyArgument(node);
                if (callback?.body) {
                    ts.forEachChild(callback.body, (child) => walk(child, nextState));
                }
                return;
            }
            if (classified?.kind === 'it' || classified?.kind === 'test') {
                const title = stringLiteralText(node.arguments[0]);
                if (title !== null) {
                    found.push({ title, ownModifier: classified.modifier, ancestorState });
                }
                // Do not descend further into an it/test call's own arguments;
                // its callback body is the test implementation, not more
                // declarations.
                return;
            }
        }
        ts.forEachChild(node, (child) => walk(child, ancestorState));
    }

    walk(sourceFile, 'none');
    return found;
}

export function resolveTestHandle(filePath: string, sourceText: string, title: string): HandleResolution {
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
    const declarations = collectDeclarations(sourceFile).filter((d) => d.title === title);

    if (declarations.length === 0) return { ok: false, reason: 'not-found' };

    const runnable = declarations.filter((d) => d.ownModifier === null && d.ancestorState !== 'unapproved');
    if (runnable.length > 1) return { ok: false, reason: 'duplicate' };
    if (runnable.length === 1) return { ok: true };

    // Every matching declaration is skipped some way; report the most
    // specific reason from the first match.
    const first = declarations[0];
    if (first.ownModifier !== null && SKIP_SHAPED_MODIFIERS.has(first.ownModifier)) {
        return { ok: false, reason: 'skipped-directly' };
    }
    return { ok: false, reason: 'unapproved-ancestor-skip' };
}
