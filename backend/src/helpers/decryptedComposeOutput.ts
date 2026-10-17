import { AsyncLocalStorage } from 'async_hooks';

/**
 * The Compose run behind a GitOps decrypt overlay reads plaintext secrets: an
 * interpolated image reference, a rendered environment block, a mounted
 * credential file. Compose quotes whatever it resolved back in its own
 * diagnostics, and that text is unrecognisable as a secret (a bare value, not a
 * `TOKEN=` line), so pattern redaction cannot be trusted with it. The same
 * holds for the live progress stream. Candidate validation already withholds
 * its diagnostic for this reason; this carries the same boundary to the
 * operation that actually runs Compose.
 *
 * Scope, not filter: nothing derived from a Compose subprocess's own output
 * reaches a rejection or a stream while the scope is live. Compose runs that
 * read no decrypt overlay are unaffected, and neither is any diagnostic Sencho
 * authored itself.
 */
export interface DecryptedComposeOperation {
  stackName: string;
  nodeId: number;
}

const storage = new AsyncLocalStorage<DecryptedComposeOperation>();

/**
 * Run `fn` as an operation whose Compose output is confidential. Set by the
 * Compose entry point that received a decrypt overlay, so every subprocess the
 * operation spawns inherits the boundary, including compensation and rollback
 * compose runs nested inside a failed deploy.
 */
export function runWithDecryptedComposeOutput<T>(
  operation: DecryptedComposeOperation,
  fn: () => T,
): T {
  return storage.run(operation, fn);
}

/** True while the caller is inside a `runWithDecryptedComposeOutput` scope. */
export function decryptedComposeOutputWithheld(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * Stands in for the withheld diagnostic. Fixed text, like the validation-path
 * counterpart: the operation's own framing still reaches the operator (the exit
 * code on the stream, the applied-but-not-deployed result), and no Compose
 * output does. Sencho-authored failures of the launch itself (a missing Docker
 * CLI, an out-of-memory spawn) are not Compose output and stay intact.
 */
export const WITHHELD_DECRYPTED_COMPOSE_OUTPUT =
  'The Compose command failed while this operation ran with decrypted secret files. Its output was withheld, so no Compose diagnostic can be shown here.';

/** Sent once in place of the first withheld chunk on the progress stream. */
export const WITHHELD_DECRYPTED_COMPOSE_STREAM =
  '=== Compose output is withheld for this operation because it runs with decrypted secret files ===\n';

/**
 * Stands in for the withheld diagnostic of a preflight render that resolved
 * its model from decrypted secret files (the mandatory external-network gate
 * on a Git deploy). The gate still fails closed on a render it could not read,
 * it just cannot quote Compose's own words, which would carry interpolated
 * plaintext into the refusal the operator sees.
 */
export const WITHHELD_DECRYPTED_RENDER_OUTPUT =
  'Sencho could not render the effective Compose model for this deploy. The render read decrypted secret files, so its output was withheld and no Compose diagnostic can be shown here.';

/**
 * Reason clause for the required-variable guard's refusal when it checked a
 * render that resolved from decrypted secret files.
 *
 * A `:?` message is itself interpolated, so `${MISSING:?required variable
 * ${SECRET} is missing}` makes Compose print the resolved value of SECRET inside
 * its own diagnostic. A name-only parse of that text publishes the value as
 * though it were a variable name, so the guard cannot read the diagnostic at
 * all for this input: it refuses on the render's exit code and says nothing
 * Compose said. Splice this between the guard's own `blocked` prefix and its
 * remedy, so an operation that is not a deploy keeps its own remedy.
 */
export const WITHHELD_DECRYPTED_REQUIRED_ENV_OUTPUT =
  'this project failed its Compose check, which read decrypted secret files, so Compose\'s diagnostic was withheld and no variable can be named. '
  + 'A required environment variable with no value is the usual cause: define it in a .env or env_file, ';
