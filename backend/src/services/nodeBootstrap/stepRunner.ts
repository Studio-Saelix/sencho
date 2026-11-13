import crypto from 'crypto';
import path from 'path';
import { isDockerReleaseKeyFile } from './openpgpKey';
import { APT_POLICY_COMMAND, OFFICIAL_DOCKER_URI, parseAptPolicy } from './probes';
import {
  BOOTSTRAP_MARKER_FILENAME,
  PILOT_PROJECT_NAME,
} from './pathPolicy';
import {
  DIRECTORY_IDENTITY_PREFIX,
  READ_EXIT,
  START_EXIT,
  SYSTEM_DIRECTORY,
  WRITE_EXIT,
  agentContainerCommand,
  composeVersionCommand,
  dockerServiceStateCommand,
  dockerServerVersionCommand,
  readFileCommand,
  startInput,
  statCommand,
  writeFileCommand,
} from './executionCommands';
import { scrubSecrets } from './sshProbeClient';
import { EXEC_READ_MAX_BYTES, type ExecOptions, type ExecResult, type ExecSession } from './sshExecClient';
import type { BootstrapPlan, BootstrapPlanStep, BootstrapStageId } from './types';

/**
 * Runs one approved plan step over an execution session and establishes what
 * it actually did.
 *
 * A command step runs the plan's exact command. A file step writes the plan's
 * exact content through the fixed write script; the only substitution is the
 * enrollment token, which replaces its placeholder in the Pilot compose file.
 * Steps with a checkable effect (a key, a directory, a file) are followed by a
 * read-only check, the package install is preceded by a check of where each
 * package would come from, and the outcome is one of: done, skipped (already
 * in place), or a `StepFailure` that says whether the host state is known.
 */

export const COMPOSE_STEP_ID = 'agent-compose-file';
export const KEY_STEP_ID = 'docker-key';
export const TOKEN_PLACEHOLDER = '{{SENCHO_ENROLL_TOKEN}}';
const VERIFY_TIMEOUT_MS = 30_000;
const DETAIL_MAX_CHARS = 4_000;

/**
 * - `failed`: the step refused or exited non-zero; the host is as the step left it.
 * - `unknown`: the connection dropped or the step outlived its deadline, so
 *   whether it took effect is not known.
 * - `recovery`: the host contradicts the plan or a step's result did not hold,
 *   so a person has to look before anything else runs.
 */
export type StepFailureKind = 'failed' | 'unknown' | 'recovery';

export class StepFailure extends Error {
  public readonly kind: StepFailureKind;
  public readonly code: string;
  public readonly detail: string | null;
  /** The step refused before its command or write ran, so it changed nothing on the host. */
  public readonly changedNothing: boolean;

  public constructor(
    kind: StepFailureKind,
    code: string,
    message: string,
    detail: string | null = null,
    options: { changedNothing?: boolean } = {},
  ) {
    super(message);
    this.name = 'StepFailure';
    this.kind = kind;
    this.code = code;
    this.detail = detail;
    this.changedNothing = options.changedNothing ?? false;
  }
}

export interface StepOutcome {
  status: 'done' | 'skipped';
  message: string;
}

/** How long a package metadata refresh is retried while another apt job holds its lock. */
export const APT_LOCK_RETRY = { intervalMs: 10_000, totalMs: 300_000 };

export interface StepContext {
  session: ExecSession;
  /** Aborted when the operator cancels; a step that waits between attempts stops waiting. */
  signal: AbortSignal;
  /** Records a progress note on the current step, such as a wait. */
  note: (message: string) => void;
  /** Overrides APT_LOCK_RETRY (tests shorten it). */
  aptLockRetry?: { intervalMs: number; totalMs: number };
  /** Every secret the run holds, scrubbed from anything recorded. */
  secrets: string[];
  /** The Pilot compose file with the real token; called only for the compose step. */
  composeWithToken: () => string;
  /**
   * The identity (`<device>:<inode>`) of each directory this run made, by the
   * physical path the plan approved for it. A directory that did not exist when
   * the plan was approved has no identity in the plan; the step that makes it
   * records it here, and every later step that enters it is bound to that one.
   */
  directories: Map<string, string>;
}

/**
 * The last whole lines of `text` within the limit. A cut tail starts at a
 * line boundary, so it never begins with a fragment of a one-line secret (the
 * enrollment token, the passphrase) that the scrub could not recognize. The
 * private key spans lines but is never sent to the host.
 */
function lastLines(text: string, cut: boolean): string {
  let tail = text.trim();
  if (tail.length > DETAIL_MAX_CHARS) {
    tail = tail.slice(tail.length - DETAIL_MAX_CHARS);
    cut = true;
  }
  if (cut) {
    const newline = tail.indexOf('\n');
    tail = newline === -1 ? '' : tail.slice(newline + 1);
  }
  return tail;
}

/**
 * The recorded detail for a command: its output tail, with every secret removed
 * before anything is cut. A command whose standard output is file content (a
 * file read, a key download) passes `stdout: false`: content can carry a
 * credential in a form the scrub cannot recognize (base64, or one an earlier
 * attempt minted), so only its standard error is ever recorded.
 */
export function commandDetail(result: ExecResult, secrets: string[], options: { stdout?: boolean } = {}): string | null {
  const parts = [result.stderr, options.stdout === false ? '' : result.stdout]
    .map((text) => lastLines(scrubSecrets(text, secrets), result.truncated))
    .filter(Boolean);
  if (parts.length === 0) return null;
  return lastLines(parts.join('\n'), false);
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} seconds`;
}

/** Map a transport outcome that is not a normal exit to the failure it means. */
function transportFailure(result: ExecResult, what: string, timeoutMs: number, secrets: string[], options: { stdout?: boolean } = {}): StepFailure | null {
  if (result.error === 'CONNECTION_LOST') {
    return new StepFailure('unknown', 'SSH_CONNECTION_LOST', `The SSH connection dropped during "${what}". Whether it took effect is not known.`, commandDetail(result, secrets, options));
  }
  if (result.timedOut) {
    return new StepFailure('unknown', 'STEP_TIMEOUT', `"${what}" did not finish within ${seconds(timeoutMs)}. It may still be running on the host.`, commandDetail(result, secrets, options));
  }
  if (result.error === 'COMMAND_ERROR') {
    return new StepFailure('unknown', 'COMMAND_ERROR', `The SSH channel for "${what}" failed before it reported an exit status.`, commandDetail(result, secrets, options));
  }
  return null;
}

async function runChecked(
  ctx: StepContext,
  command: string,
  what: string,
  options: { timeoutMs?: number; keep?: ExecOptions['keep']; stdout?: boolean } = {},
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? VERIFY_TIMEOUT_MS;
  const result = await ctx.session.run(command, { timeoutMs, keep: options.keep });
  const failure = transportFailure(result, what, timeoutMs, ctx.secrets, { stdout: options.stdout });
  if (failure) throw failure;
  return result;
}

interface RemoteFile {
  exists: boolean;
  bytes: Buffer | null;
}

async function readRemoteFile(ctx: StepContext, filePath: string, sudo: boolean): Promise<RemoteFile> {
  // The output is the file's content: no failure detail may carry it.
  const result = await runChecked(ctx, readFileCommand(filePath, sudo), `read ${filePath}`, {
    keep: { mode: 'head', maxBytes: EXEC_READ_MAX_BYTES },
    stdout: false,
  });
  if (result.exitCode === READ_EXIT.missing) return { exists: false, bytes: null };
  if (result.exitCode === READ_EXIT.notRegular) {
    throw new StepFailure('recovery', 'UNEXPECTED_ENTRY', `${filePath} exists but is not a regular file. Nothing was written to it.`);
  }
  if (result.exitCode !== 0) {
    throw new StepFailure('failed', 'READ_FAILED', `${filePath} could not be read back.`, commandDetail(result, ctx.secrets, { stdout: false }));
  }
  if (result.truncated) {
    throw new StepFailure('recovery', 'UNEXPECTED_ENTRY', `${filePath} is larger than any file this plan writes. Nothing was written to it.`);
  }
  return { exists: true, bytes: Buffer.from(result.stdout.trim(), 'base64') };
}

interface StatFacts {
  mode: number;
  owner: string;
  group: string;
  type: string;
}

async function statRemote(ctx: StepContext, target: string, sudo: boolean): Promise<StatFacts> {
  const result = await runChecked(ctx, statCommand(target, sudo), `inspect ${target}`);
  const match = /^([0-7]{3,4}) (\S+) (\S+) (.+)$/.exec(result.stdout.trim());
  if (result.exitCode !== 0 || !match) {
    throw new StepFailure('recovery', 'VERIFY_FAILED', `${target} could not be inspected after the step.`, commandDetail(result, ctx.secrets));
  }
  return { mode: Number.parseInt(match[1], 8), owner: match[2], group: match[3], type: match[4] };
}

function expectStat(target: string, actual: StatFacts, expected: { mode: string | null; owner: string | null; group: string | null; type: string }): void {
  const problems: string[] = [];
  if (actual.type !== expected.type) problems.push(`type ${actual.type}, expected ${expected.type}`);
  if (expected.mode !== null && actual.mode !== Number.parseInt(expected.mode, 8)) {
    problems.push(`mode ${actual.mode.toString(8).padStart(4, '0')}, expected ${expected.mode}`);
  }
  if (expected.owner !== null && actual.owner !== expected.owner) problems.push(`owner ${actual.owner}, expected ${expected.owner}`);
  if (expected.group !== null && actual.group !== expected.group) problems.push(`group ${actual.group}, expected ${expected.group}`);
  if (problems.length > 0) {
    throw new StepFailure('recovery', 'VERIFY_FAILED', `${target} does not match the plan after the step: ${problems.join('; ')}.`);
  }
}

/** The compose file with its token value replaced by the placeholder the plan shows. */
export function maskComposeToken(content: string): string {
  return content.replace(/^(\s*SENCHO_ENROLL_TOKEN:\s*)"[^"\n]*"$/m, `$1"${TOKEN_PLACEHOLDER}"`);
}

interface MarkerShape {
  project?: unknown;
  composeDir?: unknown;
  agentDir?: unknown;
}

function markerMatches(bytes: Buffer, plan: BootstrapPlan): boolean {
  try {
    const marker = JSON.parse(bytes.toString('utf8')) as MarkerShape;
    return marker.project === PILOT_PROJECT_NAME
      && marker.composeDir === plan.paths.composeDir.input
      && marker.agentDir === plan.paths.agentDir.input;
  } catch {
    return false;
  }
}

/**
 * Decide what to do with a file the plan writes that already exists. Only an
 * equal file, this workflow's own marker, or this workflow's own compose file
 * (equal once its token is masked) may be kept or replaced; anything else stops
 * the run, because it was not put there by this plan.
 */
function reconcileExisting(step: BootstrapPlanStep, existing: Buffer, desired: string, plan: BootstrapPlan): 'keep' | 'replace' {
  const text = existing.toString('utf8');
  // This workflow's own compose file is always rewritten, never kept: the
  // token it carries is spent or expired. Any other compose file is a conflict.
  if (step.id === COMPOSE_STEP_ID) {
    if (maskComposeToken(text) === step.file?.content) return 'replace';
  } else {
    if (text === desired) return 'keep';
    const name = path.posix.basename(step.file?.path ?? '');
    if (name === BOOTSTRAP_MARKER_FILENAME && markerMatches(existing, plan)) return 'keep';
  }
  throw new StepFailure(
    'recovery',
    'FILE_CONFLICT',
    `${step.file?.path ?? 'The file'} already exists with content this plan did not write. It was left as it is.`,
  );
}

function sha256Of(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function withoutTrailingSlashes(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

/**
 * The physical path the plan approved for a directory a step writes into: the
 * resolved path the preflight recorded for the Compose or Agent directory, and
 * the literal path for a system directory (the apt keyring and source
 * directories), which must not be reached through a link. The write script
 * refuses any other directory, so what was approved is what is changed.
 */
export function approvedDirectory(plan: BootstrapPlan, directory: string): string {
  for (const known of [plan.paths.agentDir, plan.paths.composeDir]) {
    if (withoutTrailingSlashes(known.input) === withoutTrailingSlashes(directory)) return known.realPath ?? known.input;
  }
  return directory;
}

/**
 * The identity a directory must have when a step enters it: the one the run
 * recorded when it made the directory, else the one the preflight saw, and for
 * a system directory (not a Compose or Agent directory) the system rule. A
 * Compose or Agent directory without either identity cannot be told from a
 * substitute, so the step refuses rather than write into it.
 */
export function approvedBinding(plan: BootstrapPlan, ctx: Pick<StepContext, 'directories'>, directory: string): string {
  for (const known of [plan.paths.agentDir, plan.paths.composeDir]) {
    if (withoutTrailingSlashes(known.input) !== withoutTrailingSlashes(directory)) continue;
    const identity = ctx.directories.get(known.realPath ?? known.input) ?? known.identity;
    if (!identity) {
      throw new StepFailure('failed', 'PLAN_INVALID', `The plan has no recorded identity for ${directory}, so it cannot be told from a directory that replaced it. Nothing was changed.`, null, { changedNothing: true });
    }
    return identity;
  }
  return SYSTEM_DIRECTORY;
}

/**
 * Put `desired` at `filePath` through the write script and check the result.
 * `replaces` is the sha256 of the file the run inspected and means to replace;
 * without it the name must be free when the file is published. A refusal means
 * the host changed after the plan was approved or after this run looked.
 */
async function publishFile(
  ctx: StepContext,
  plan: BootstrapPlan,
  step: BootstrapPlanStep,
  file: { path: string; mode: string },
  facts: { owner: string; group: string },
  desired: string,
  replaces: string | null,
): Promise<StepOutcome> {
  const sudo = step.privilege === 'sudo';
  const directory = approvedDirectory(plan, path.posix.dirname(file.path));
  const binding = approvedBinding(plan, ctx, path.posix.dirname(file.path));
  const command = writeFileCommand(file.path, { mode: file.mode, owner: facts.owner, group: facts.group, sha256: sha256Of(desired) }, { sudo, replaces, directory, binding });
  const result = await ctx.session.run(command, { timeoutMs: step.timeoutMs, stdin: desired });
  const failure = transportFailure(result, step.title, step.timeoutMs, ctx.secrets);
  if (failure) throw failure;
  if (result.exitCode === WRITE_EXIT.incomplete) {
    throw new StepFailure('failed', 'WRITE_INCOMPLETE', `${file.path} did not arrive in full, so it was not put in place. The connection may have dropped.`, commandDetail(result, ctx.secrets), { changedNothing: true });
  }
  if (result.exitCode === WRITE_EXIT.notDirectory) {
    throw new StepFailure('failed', 'DIRECTORY_CHANGED', `The directory for ${file.path} is not the directory the plan approved (it is not a directory any more, or it, or one of its parents, was replaced or redirected; an apt directory that is itself reached through a link on this host ends here too). Nothing was written.`, commandDetail(result, ctx.secrets), { changedNothing: true });
  }
  if (result.exitCode === WRITE_EXIT.exists || result.exitCode === WRITE_EXIT.notRegular) {
    // A replacement moves the inspected file aside first, so only a plain write is known to have changed nothing.
    throw new StepFailure('recovery', 'FILE_CONFLICT', `${file.path} appeared or changed on the host after the plan was approved. It was left as it is.`, commandDetail(result, ctx.secrets), { changedNothing: replaces === null });
  }
  if (result.exitCode !== 0) {
    throw new StepFailure('failed', 'STEP_FAILED', `"${step.title}" failed (exit ${result.exitCode}).`, commandDetail(result, ctx.secrets));
  }
  expectStat(file.path, await statRemote(ctx, file.path, sudo), {
    mode: file.mode, owner: facts.owner, group: facts.group, type: 'regular file',
  });
  return { status: 'done', message: replaces === null ? `Wrote ${file.path}.` : `Replaced ${file.path} with a new enrollment.` };
}

async function runFileStep(step: BootstrapPlanStep, ctx: StepContext, plan: BootstrapPlan): Promise<StepOutcome> {
  const file = step.file;
  const target = step.target;
  if (!file || !target?.owner || !target.group) {
    throw new StepFailure('failed', 'PLAN_INVALID', `The plan step "${step.title}" has no file owner. Nothing was written.`);
  }
  const sudo = step.privilege === 'sudo';
  const desired = step.id === COMPOSE_STEP_ID ? ctx.composeWithToken() : file.content;
  let replaces: string | null = null;
  if (target.preserveExisting) {
    const existing = await readRemoteFile(ctx, file.path, sudo);
    if (existing.exists && existing.bytes) {
      const decision = reconcileExisting(step, existing.bytes, desired, plan);
      if (decision === 'keep') {
        expectStat(file.path, await statRemote(ctx, file.path, sudo), {
          mode: file.mode, owner: target.owner, group: target.group, type: 'regular file',
        });
        return { status: 'skipped', message: `${file.path} is already in place and was kept.` };
      }
      // The write replaces exactly the file that was read, and refuses anything else.
      replaces = sha256Of(existing.bytes);
    }
  }
  return publishFile(ctx, plan, step, file, { owner: target.owner, group: target.group }, desired, replaces);
}

/**
 * Download Docker's release key to standard output and put it in place with the
 * file writer, once it is known to be that key. Nothing is written through a
 * path before then, so a symlink at the destination is never followed, and an
 * existing key is replaced only when it is itself Docker's key and still the
 * file that was read.
 */
async function runKeyStep(step: BootstrapPlanStep, ctx: StepContext, plan: BootstrapPlan): Promise<StepOutcome> {
  const target = step.target;
  if (!step.command || !target?.owner || !target.group || !target.mode) {
    throw new StepFailure('failed', 'PLAN_INVALID', `The plan step "${step.title}" has no key destination. Nothing was run.`);
  }
  const keyPath = target.path;
  const sudo = step.privilege === 'sudo';
  const fetched = await runChecked(ctx, step.command, step.title, {
    timeoutMs: step.timeoutMs,
    keep: { mode: 'head', maxBytes: EXEC_READ_MAX_BYTES },
    stdout: false,
  });
  if (fetched.exitCode !== 0) {
    throw new StepFailure('failed', 'STEP_FAILED', `"${step.title}" failed (exit ${fetched.exitCode}).`, commandDetail(fetched, ctx.secrets, { stdout: false }), { changedNothing: true });
  }
  const downloaded = Buffer.from(fetched.stdout, 'utf8');
  if (fetched.truncated || !isDockerReleaseKeyFile(keyPath, downloaded)) {
    throw new StepFailure(
      'failed',
      'KEY_NOT_VERIFIED',
      `The key downloaded for ${keyPath} is not Docker's release key, so the Docker repository was not added.`,
      null,
      { changedNothing: true },
    );
  }
  let replaces: string | null = null;
  const existing = await readRemoteFile(ctx, keyPath, sudo);
  if (existing.exists && existing.bytes) {
    if (!isDockerReleaseKeyFile(keyPath, existing.bytes)) {
      throw new StepFailure('recovery', 'FILE_CONFLICT', `${keyPath} already exists and is not Docker's release key. It was left as it is.`, null, { changedNothing: true });
    }
    replaces = sha256Of(existing.bytes);
  }
  return publishFile(ctx, plan, step, { path: keyPath, mode: target.mode }, { owner: target.owner, group: target.group }, downloaded.toString('utf8'), replaces);
}

/** The package names, and pinned versions, an `apt-get install` command names. */
function installSpecs(command: string): Array<{ name: string; version: string | null }> {
  const words = command.split(/\s+/);
  const start = words.indexOf('--no-install-recommends');
  return words.slice(start + 1).filter(Boolean).map((word) => {
    const [name, version] = word.split('=');
    return { name, version: version ?? null };
  });
}

/** The host release's codename, read fresh, so the check holds archives to this release. */
const OS_CODENAME_COMMAND = `sh -c '. /etc/os-release && printf "%s\\n" "$VERSION_CODENAME"'`;

async function hostCodename(ctx: StepContext): Promise<string> {
  const result = await runChecked(ctx, OS_CODENAME_COMMAND, 'read the host release');
  const codename = result.stdout.trim();
  if (result.exitCode !== 0 || !/^[a-z]+$/.test(codename)) {
    throw new StepFailure('failed', 'CANDIDATE_NOT_VERIFIED', 'The host release could not be read, so nothing was installed.', commandDetail(result, ctx.secrets), { changedNothing: true });
  }
  return codename;
}

/**
 * Before installing, ask apt where each package would come from: every one
 * must have a candidate served only by the official Docker repository from the
 * host release's stable channel, and a pinned version must be the candidate.
 * Nothing is installed when one is not.
 */
async function verifyDockerCandidates(ctx: StepContext, step: BootstrapPlanStep): Promise<void> {
  const codename = await hostCodename(ctx);
  // apt lists every version the repository serves, well past the tail kept for
  // command output, so the policy is read from the start like a file.
  const result = await runChecked(ctx, APT_POLICY_COMMAND, 'check the Docker package sources', {
    keep: { mode: 'head', maxBytes: EXEC_READ_MAX_BYTES },
  });
  if (result.exitCode !== 0 || result.truncated) {
    throw new StepFailure('failed', 'CANDIDATE_NOT_VERIFIED', 'apt could not report where the Docker packages come from, so nothing was installed.', commandDetail(result, ctx.secrets), { changedNothing: true });
  }
  const packages = parseAptPolicy(result.stdout, codename);
  const problems: string[] = [];
  for (const spec of installSpecs(step.command ?? '')) {
    const pkg = packages.find((entry) => entry.name === spec.name);
    // apt may fetch the candidate from any archive that serves it, so every one must be the official repository.
    const sources = pkg?.candidateSources ?? [];
    const official = sources.length > 0 && sources.every((source) => source.uri === OFFICIAL_DOCKER_URI && source.official === true);
    if (!pkg?.candidateVersion || !official) problems.push(`${spec.name} has no candidate from the official Docker repository`);
    else if (spec.version !== null && pkg.candidateVersion !== spec.version) problems.push(`${spec.name} would install ${pkg.candidateVersion}, not ${spec.version}`);
  }
  if (problems.length > 0) {
    throw new StepFailure('failed', 'CANDIDATE_NOT_VERIFIED', `Nothing was installed: ${problems.join('; ')}.`, null, { changedNothing: true });
  }
}

const APT_LISTS_LOCK = /Could not get lock \/var\/lib\/apt\/lists\/lock/;

/** A cancel ended the run, noticed between phases or while a step waited between attempts. */
export class RunCancelled extends Error {}

function waitOrCancel(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new RunCancelled());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RunCancelled());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run a package metadata refresh, retrying while another apt job (a freshly
 * booted host's daily refresh) holds the lists lock. apt has no wait option for
 * that lock, so the same command is run again, within a fixed total.
 */
async function runMetadataRefresh(step: BootstrapPlanStep, ctx: StepContext): Promise<ExecResult> {
  const retry = ctx.aptLockRetry ?? APT_LOCK_RETRY;
  const deadline = Date.now() + retry.totalMs;
  let waiting = false;
  for (;;) {
    const result = await ctx.session.run(step.command ?? '', { timeoutMs: step.timeoutMs });
    const locked = result.exitCode !== 0 && result.exitCode !== null && APT_LISTS_LOCK.test(result.stderr);
    if (!locked || Date.now() + retry.intervalMs > deadline) return result;
    if (!waiting && !ctx.signal.aborted) {
      waiting = true;
      ctx.note(`Another apt job holds the package lists. Retrying every ${Math.round(retry.intervalMs / 1000)}s for up to ${Math.round(retry.totalMs / 60_000)} minutes; a cancel stops the wait.`);
    }
    await waitOrCancel(retry.intervalMs, ctx.signal);
  }
}

async function runCommandStep(step: BootstrapPlanStep, ctx: StepContext, plan: BootstrapPlan): Promise<StepOutcome> {
  if (!step.command) {
    throw new StepFailure('failed', 'PLAN_INVALID', `The plan step "${step.title}" has no command. Nothing was run.`);
  }
  if (step.effect === 'package-install') await verifyDockerCandidates(ctx, step);
  const result = step.effect === 'package-metadata'
    ? await runMetadataRefresh(step, ctx)
    : await ctx.session.run(step.command, { timeoutMs: step.timeoutMs });
  const failure = transportFailure(result, step.title, step.timeoutMs, ctx.secrets);
  if (failure) throw failure;
  if (step.effect === 'directory-create' && step.target) {
    // The directory script says whether it created anything before it refused.
    const detail = commandDetail(result, ctx.secrets);
    if (result.exitCode === WRITE_EXIT.exists) {
      throw new StepFailure('recovery', 'FILE_CONFLICT', `${step.target.path} appeared on the host after the plan was approved. It was left as it is.`, detail, { changedNothing: true });
    }
    if (result.exitCode === WRITE_EXIT.notDirectory) {
      throw new StepFailure('failed', 'DIRECTORY_CHANGED', `${step.target.path} is not where the plan approved it: a parent (the nearest one that exists, or one that appeared while the directory was made) is not a directory, or it, or one above it, was replaced or redirected. Nothing was created.`, detail, { changedNothing: true });
    }
    if (result.exitCode === WRITE_EXIT.notCreated) {
      throw new StepFailure('failed', 'STEP_FAILED', `"${step.title}" failed (exit ${result.exitCode}); nothing was created.`, detail, { changedNothing: true });
    }
    if (result.exitCode === WRITE_EXIT.unfinished) {
      throw new StepFailure('recovery', 'DIRECTORY_NOT_FINISHED', `Setting up ${step.target.path} could not be finished: a directory on the way to it was created or adjusted and its owner or mode could not be set, what was found where it was made was not the directory just made, or a directory on the way is not owned by this user. Look at it on the host before retrying.`, detail);
    }
  }
  if (result.exitCode !== 0) {
    throw new StepFailure('failed', 'STEP_FAILED', `"${step.title}" failed (exit ${result.exitCode}).`, commandDetail(result, ctx.secrets));
  }
  if (step.effect === 'directory-create' && step.target) {
    recordMadeDirectory(ctx, plan, step.target.path, result.stdout);
    expectStat(step.target.path, await statRemote(ctx, step.target.path, step.privilege === 'sudo'), {
      mode: step.target.mode, owner: step.target.owner, group: step.target.group, type: 'directory',
    });
  }
  return { status: 'done', message: `${step.title}: done.` };
}

/**
 * Remember which directory a directory step made, so the steps that write into
 * it are bound to that one. Only the Compose and Agent directories are tracked
 * (a system directory is bound by ownership). A made directory whose identity
 * the script did not report cannot be bound, which is a state to look at.
 */
function recordMadeDirectory(ctx: StepContext, plan: BootstrapPlan, directory: string, stdout: string): void {
  const tracked = [plan.paths.agentDir, plan.paths.composeDir].find((known) => withoutTrailingSlashes(known.input) === withoutTrailingSlashes(directory));
  if (!tracked) return;
  const line = stdout.split('\n').map((text) => text.trim()).find((text) => text.startsWith(DIRECTORY_IDENTITY_PREFIX));
  const identity = line?.slice(DIRECTORY_IDENTITY_PREFIX.length) ?? '';
  if (!/^\d+:\d+$/.test(identity)) {
    throw new StepFailure('recovery', 'DIRECTORY_NOT_FINISHED', `${directory} was made, but the host did not say which directory it is, so nothing can be written into it safely. Look at it on the host before retrying.`);
  }
  ctx.directories.set(tracked.realPath ?? tracked.input, identity);
}

/**
 * Start the Pilot project through the start script, which holds the approved
 * directory by identity and refuses when the directory, the Compose directory
 * the compose file mounts, or the files it reads are not the ones the run wrote
 * or approved. What the script has to compare against is not in the plan (the
 * token is in the compose file; a directory may have been made by this run), so
 * it goes in on standard input.
 */
async function runStartStep(step: BootstrapPlanStep, ctx: StepContext, plan: BootstrapPlan): Promise<StepOutcome> {
  if (!step.command) {
    throw new StepFailure('failed', 'PLAN_INVALID', `The plan step "${step.title}" has no command. Nothing was run.`, null, { changedNothing: true });
  }
  const stages = plan.stages.flatMap((stage) => stage.steps);
  const caContent = stages.find((candidate) => candidate.id === 'agent-hub-ca')?.file?.content ?? null;
  const stdin = startInput({
    agentIdentity: approvedBinding(plan, ctx, plan.paths.agentDir.input),
    composeIdentity: approvedBinding(plan, ctx, plan.paths.composeDir.input),
    composeSha256: sha256Of(ctx.composeWithToken()),
    caSha256: caContent === null ? null : sha256Of(caContent),
  });
  const result = await ctx.session.run(step.command, { timeoutMs: step.timeoutMs, stdin });
  const failure = transportFailure(result, step.title, step.timeoutMs, ctx.secrets);
  if (failure) throw failure;
  if (result.exitCode === START_EXIT.notDirectory) {
    throw new StepFailure('failed', 'DIRECTORY_CHANGED', `The directory the Pilot starts from, or the Compose directory it mounts, is not the one the plan approved (it is not a directory any more, or it, or one of its parents, was replaced or redirected). Nothing was started.`, commandDetail(result, ctx.secrets), { changedNothing: true });
  }
  if (result.exitCode === START_EXIT.inputChanged) {
    throw new StepFailure('failed', 'FILE_CONFLICT', `A file the Pilot starts from is not the one this run wrote. Nothing was started.`, commandDetail(result, ctx.secrets), { changedNothing: true });
  }
  if (result.exitCode !== 0) {
    throw new StepFailure('failed', 'STEP_FAILED', `"${step.title}" failed (exit ${result.exitCode}).`, commandDetail(result, ctx.secrets));
  }
  return { status: 'done', message: `${step.title}: done.` };
}

export async function runPlanStep(step: BootstrapPlanStep, ctx: StepContext, plan: BootstrapPlan): Promise<StepOutcome> {
  if (step.file) return runFileStep(step, ctx, plan);
  if (step.id === KEY_STEP_ID) return runKeyStep(step, ctx, plan);
  return step.effect === 'container-start' ? runStartStep(step, ctx, plan) : runCommandStep(step, ctx, plan);
}

/** The start step's privilege decides how Docker is reached after installation. */
export function dockerNeedsSudo(plan: BootstrapPlan): boolean {
  const start = plan.stages.find((stage) => stage.id === 'agent_start')?.steps[0];
  return start?.privilege === 'sudo';
}

/** The last Docker stage in the plan, after which the daemon and Compose must answer. */
export function lastDockerStage(plan: BootstrapPlan): BootstrapStageId | null {
  const docker = plan.stages.filter((stage) => stage.id === 'docker_packages' || stage.id === 'docker_service');
  return docker.length > 0 ? docker[docker.length - 1].id : null;
}

/** Docker's daemon and Compose plugin answer on the pinned local socket. */
export async function verifyDockerReady(ctx: StepContext, plan: BootstrapPlan): Promise<string> {
  const sudo = dockerNeedsSudo(plan);
  const server = await runChecked(ctx, dockerServerVersionCommand(sudo), 'check the Docker daemon');
  if (server.exitCode !== 0 || !server.stdout.trim()) {
    throw new StepFailure('recovery', 'DOCKER_NOT_READY', 'Docker was prepared, but the daemon does not answer on its local socket.', commandDetail(server, ctx.secrets));
  }
  const compose = await runChecked(ctx, composeVersionCommand(sudo), 'check Docker Compose');
  if (compose.exitCode !== 0 || !compose.stdout.trim()) {
    throw new StepFailure('recovery', 'COMPOSE_NOT_READY', 'Docker answers, but the Compose plugin does not.', commandDetail(compose, ctx.secrets));
  }
  return `Docker ${server.stdout.trim()} and Compose ${compose.stdout.trim()} answer.`;
}

/** systemd reports the Docker service active and enabled at boot, asked with the service step's privilege. */
export async function verifyDockerService(ctx: StepContext, plan: BootstrapPlan): Promise<string> {
  const step = plan.stages.find((stage) => stage.id === 'docker_service')?.steps[0];
  const result = await runChecked(ctx, dockerServiceStateCommand(step?.privilege === 'sudo'), 'check the Docker service');
  const [active, enabled] = result.stdout.trim().split('\n').map((line) => line.trim());
  if (active !== 'active' || enabled !== 'enabled') {
    throw new StepFailure(
      'recovery',
      'DOCKER_SERVICE_NOT_READY',
      `The Docker service is ${active || 'in an unknown state'} and ${enabled || 'of unknown enablement'} after the step.`,
      commandDetail(result, ctx.secrets),
    );
  }
  return 'The Docker service is active and enabled at boot.';
}

/** The Pilot container runs from the approved project and directory. */
export async function verifyAgentContainer(ctx: StepContext, plan: BootstrapPlan): Promise<string> {
  const result = await runChecked(ctx, agentContainerCommand(dockerNeedsSudo(plan)), 'inspect the Pilot container');
  const [status, project, workingDir] = result.stdout.trim().split('|');
  const dirs = new Set([plan.paths.agentDir.input, plan.paths.agentDir.realPath].filter((dir): dir is string => Boolean(dir)));
  if (result.exitCode !== 0 || status !== 'running' || project !== plan.projectName || !dirs.has(workingDir ?? '')) {
    throw new StepFailure(
      'recovery',
      'AGENT_NOT_RUNNING',
      `The ${plan.containerName} container is not running from ${plan.paths.agentDir.input} as the ${plan.projectName} project.`,
      commandDetail(result, ctx.secrets),
    );
  }
  return `The ${plan.containerName} container is running from ${plan.paths.agentDir.input}.`;
}
