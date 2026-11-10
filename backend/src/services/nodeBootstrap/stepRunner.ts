import crypto from 'crypto';
import path from 'path';
import { isDockerReleaseKeyFile } from './openpgpKey';
import { APT_POLICY_COMMAND, OFFICIAL_DOCKER_URI, parseAptPolicy } from './probes';
import {
  BOOTSTRAP_MARKER_FILENAME,
  PILOT_PROJECT_NAME,
} from './pathPolicy';
import {
  READ_EXIT,
  WRITE_EXIT,
  agentContainerCommand,
  composeVersionCommand,
  dockerServiceStateCommand,
  dockerServerVersionCommand,
  readFileCommand,
  statCommand,
  writeFileCommand,
} from './executionCommands';
import { scrubSecrets } from './sshProbeClient';
import { EXEC_READ_MAX_BYTES, type ExecResult, type ExecSession } from './sshExecClient';
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

  public constructor(kind: StepFailureKind, code: string, message: string, detail: string | null = null) {
    super(message);
    this.name = 'StepFailure';
    this.kind = kind;
    this.code = code;
    this.detail = detail;
  }
}

export interface StepOutcome {
  status: 'done' | 'skipped';
  message: string;
}

export interface StepContext {
  session: ExecSession;
  /** Every secret the run holds, scrubbed from anything recorded. */
  secrets: string[];
  /** The Pilot compose file with the real token; called only for the compose step. */
  composeWithToken: () => string;
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

/** The recorded detail for a command: its output tail, with every secret removed before anything is cut. */
export function commandDetail(result: ExecResult, secrets: string[]): string | null {
  const parts = [result.stderr, result.stdout]
    .map((text) => lastLines(scrubSecrets(text, secrets), result.truncated))
    .filter(Boolean);
  if (parts.length === 0) return null;
  return lastLines(parts.join('\n'), false);
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} seconds`;
}

/** Map a transport outcome that is not a normal exit to the failure it means. */
function transportFailure(result: ExecResult, what: string, timeoutMs: number, secrets: string[]): StepFailure | null {
  if (result.error === 'CONNECTION_LOST') {
    return new StepFailure('unknown', 'SSH_CONNECTION_LOST', `The SSH connection dropped during "${what}". Whether it took effect is not known.`, commandDetail(result, secrets));
  }
  if (result.timedOut) {
    return new StepFailure('unknown', 'STEP_TIMEOUT', `"${what}" did not finish within ${seconds(timeoutMs)}. It may still be running on the host.`, commandDetail(result, secrets));
  }
  if (result.error === 'COMMAND_ERROR') {
    return new StepFailure('unknown', 'COMMAND_ERROR', `The SSH channel for "${what}" failed before it reported an exit status.`, commandDetail(result, secrets));
  }
  return null;
}

async function runChecked(ctx: StepContext, command: string, what: string, timeoutMs = VERIFY_TIMEOUT_MS): Promise<ExecResult> {
  const result = await ctx.session.run(command, { timeoutMs });
  const failure = transportFailure(result, what, timeoutMs, ctx.secrets);
  if (failure) throw failure;
  return result;
}

interface RemoteFile {
  exists: boolean;
  bytes: Buffer | null;
}

async function readRemoteFile(ctx: StepContext, filePath: string, sudo: boolean): Promise<RemoteFile> {
  const result = await ctx.session.run(readFileCommand(filePath, sudo), {
    timeoutMs: VERIFY_TIMEOUT_MS,
    keep: { mode: 'head', maxBytes: EXEC_READ_MAX_BYTES },
  });
  const failure = transportFailure(result, `read ${filePath}`, VERIFY_TIMEOUT_MS, ctx.secrets);
  if (failure) throw failure;
  if (result.exitCode === READ_EXIT.missing) return { exists: false, bytes: null };
  if (result.exitCode === READ_EXIT.notRegular) {
    throw new StepFailure('recovery', 'UNEXPECTED_ENTRY', `${filePath} exists but is not a regular file. Nothing was written to it.`);
  }
  if (result.exitCode !== 0) {
    throw new StepFailure('failed', 'READ_FAILED', `${filePath} could not be read back.`, commandDetail(result, ctx.secrets));
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

async function runFileStep(step: BootstrapPlanStep, ctx: StepContext, plan: BootstrapPlan): Promise<StepOutcome> {
  const file = step.file;
  const target = step.target;
  if (!file || !target?.owner || !target.group) {
    throw new StepFailure('failed', 'PLAN_INVALID', `The plan step "${step.title}" has no file owner. Nothing was written.`);
  }
  const sudo = step.privilege === 'sudo';
  const desired = step.id === COMPOSE_STEP_ID ? ctx.composeWithToken() : file.content;
  let noClobber = true;
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
      noClobber = false;
    }
  }
  const sha256 = crypto.createHash('sha256').update(desired).digest('hex');
  const command = writeFileCommand(file.path, { mode: file.mode, owner: target.owner, group: target.group, sha256 }, { sudo, noClobber });
  const result = await ctx.session.run(command, { timeoutMs: step.timeoutMs, stdin: desired });
  const failure = transportFailure(result, step.title, step.timeoutMs, ctx.secrets);
  if (failure) throw failure;
  if (result.exitCode === WRITE_EXIT.incomplete) {
    throw new StepFailure('unknown', 'WRITE_INCOMPLETE', `${file.path} did not arrive in full, so it was not put in place. The connection may have dropped.`, commandDetail(result, ctx.secrets));
  }
  if (result.exitCode === WRITE_EXIT.exists || result.exitCode === WRITE_EXIT.notRegular) {
    throw new StepFailure('recovery', 'FILE_CONFLICT', `${file.path} appeared on the host after the plan was approved. It was left as it is.`, commandDetail(result, ctx.secrets));
  }
  if (result.exitCode !== 0) {
    throw new StepFailure('failed', 'STEP_FAILED', `"${step.title}" failed (exit ${result.exitCode}).`, commandDetail(result, ctx.secrets));
  }
  expectStat(file.path, await statRemote(ctx, file.path, sudo), {
    mode: file.mode, owner: target.owner, group: target.group, type: 'regular file',
  });
  return { status: 'done', message: noClobber ? `Wrote ${file.path}.` : `Replaced ${file.path} with a new enrollment.` };
}

async function verifyDockerKey(ctx: StepContext, step: BootstrapPlanStep): Promise<void> {
  const keyPath = step.target?.path;
  if (!keyPath) return;
  const read = await readRemoteFile(ctx, keyPath, step.privilege === 'sudo');
  if (!read.exists || !isDockerReleaseKeyFile(keyPath, read.bytes)) {
    throw new StepFailure(
      'failed',
      'KEY_NOT_VERIFIED',
      `The key downloaded to ${keyPath} is not Docker's release key, so the Docker repository was not added.`,
    );
  }
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

/** The Ubuntu suite the plan's own Docker source names, when it writes one. */
function planCodename(plan: BootstrapPlan): string {
  const source = plan.stages.flatMap((stage) => stage.steps).find((step) => step.id === 'docker-sources')?.file?.content ?? '';
  return /\/linux\/ubuntu (\S+) stable/.exec(source)?.[1] ?? '';
}

/**
 * Before installing, ask apt where each package would come from: every one
 * must have a candidate served by the official Docker repository (for the
 * host release, when the plan wrote the source), and a pinned version must be
 * the candidate. Nothing is installed when one is not.
 */
async function verifyDockerCandidates(ctx: StepContext, step: BootstrapPlanStep, plan: BootstrapPlan): Promise<void> {
  const result = await runChecked(ctx, APT_POLICY_COMMAND, 'check the Docker package sources');
  if (result.exitCode !== 0 || result.truncated) {
    throw new StepFailure('failed', 'CANDIDATE_NOT_VERIFIED', 'apt could not report where the Docker packages come from, so nothing was installed.', commandDetail(result, ctx.secrets));
  }
  const packages = parseAptPolicy(result.stdout, planCodename(plan));
  const problems: string[] = [];
  for (const spec of installSpecs(step.command ?? '')) {
    const pkg = packages.find((entry) => entry.name === spec.name);
    const official = pkg?.candidateSources?.some((source) => source.uri === OFFICIAL_DOCKER_URI && source.official !== false) ?? false;
    if (!pkg?.candidateVersion || !official) problems.push(`${spec.name} has no candidate from the official Docker repository`);
    else if (spec.version !== null && pkg.candidateVersion !== spec.version) problems.push(`${spec.name} would install ${pkg.candidateVersion}, not ${spec.version}`);
  }
  if (problems.length > 0) {
    throw new StepFailure('failed', 'CANDIDATE_NOT_VERIFIED', `Nothing was installed: ${problems.join('; ')}.`);
  }
}

async function runCommandStep(step: BootstrapPlanStep, ctx: StepContext, plan: BootstrapPlan): Promise<StepOutcome> {
  if (!step.command) {
    throw new StepFailure('failed', 'PLAN_INVALID', `The plan step "${step.title}" has no command. Nothing was run.`);
  }
  if (step.effect === 'package-install') await verifyDockerCandidates(ctx, step, plan);
  const result = await ctx.session.run(step.command, { timeoutMs: step.timeoutMs });
  const failure = transportFailure(result, step.title, step.timeoutMs, ctx.secrets);
  if (failure) throw failure;
  if (result.exitCode !== 0) {
    throw new StepFailure('failed', 'STEP_FAILED', `"${step.title}" failed (exit ${result.exitCode}).`, commandDetail(result, ctx.secrets));
  }
  if (step.id === 'docker-key') await verifyDockerKey(ctx, step);
  if (step.effect === 'directory-create' && step.target) {
    expectStat(step.target.path, await statRemote(ctx, step.target.path, step.privilege === 'sudo'), {
      mode: step.target.mode, owner: step.target.owner, group: step.target.group, type: 'directory',
    });
  }
  return { status: 'done', message: `${step.title}: done.` };
}

export async function runPlanStep(step: BootstrapPlanStep, ctx: StepContext, plan: BootstrapPlan): Promise<StepOutcome> {
  return step.file ? runFileStep(step, ctx, plan) : runCommandStep(step, ctx, plan);
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
