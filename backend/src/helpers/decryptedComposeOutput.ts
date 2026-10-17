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
