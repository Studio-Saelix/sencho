import crypto, { createHash } from 'crypto';
import type Docker from 'dockerode';
import { errorMessageForLog, sanitizeForLog } from '../../utils/safeLog';
import { RecoveryError } from './redaction';
import { getRecoveryAuthorityId } from './recoveryDb';
import { RecoveryPointStore } from './recoveryPoints';
import {
  RecoveryRepositoryStore,
  type RepositoryRegistration,
} from './repositories';
import {
  HELPER_LABEL_REPOSITORY,
  RecoveryHelperRunner,
  resticCommand,
  type HelperRunResult,
} from './restic/helperRunner';
import {
  classifyCheckRun,
  parseRepositoryConfig,
  type IntegrityOutcome,
} from './restic/resticOutput';
import { resolveOwnerNodeKey } from './storageIdentity';
import type {
  BackupEngine,
  IntegrityMethod,
  RecoveryErrorClass,
  RepositoryDescriptor,
} from './types';

/**
 * The node-local restic repository: one Docker volume on this engine, one
 * password encrypted with this instance's key, no network.
 *
 * Provisioning is explicit, idempotent and crash-safe. Every step is resumable:
 * register the row, store a password only if none is stored, pull the pinned
 * helper, create or adopt the labelled volume, open the repository with the
 * stored password, and initialize only when the engine says there is nothing
 * there. A crash between any two steps leaves a state the next attempt reads and
 * continues from, and a repository that opened is never written over.
 *
 * Everything here is node-local. The hub learns only a descriptor, and the
 * descriptor never carries the password.
 */

/** Label stamped on the volume holding a repository, so a foreign volume is refused. */
export const REPOSITORY_VOLUME_DRIVER = 'local';

const BASE64URL_SECRET_BYTES = 32;

/** A fresh repository password. Encrypted before it reaches the database. */
export function generateRepositorySecret(): string {
  return crypto.randomBytes(BASE64URL_SECRET_BYTES).toString('base64url');
}

/**
 * `sencho-recovery-<authority12>-<owner12>-g<n>`, a name no stack owns.
 *
 * Both halves are hash prefixes rather than slices of the raw ids: every engine
 * key starts with `docker-engine:`, so a slice would give two different engines
 * the same twelve characters and the second repository would collide with the
 * first one's volume.
 */
export function repositoryVolumeName(authorityId: string, ownerNodeKey: string, generation: number): string {
  const authority = createHash('sha256').update(authorityId).digest('hex').slice(0, 12);
  const owner = createHash('sha256').update(ownerNodeKey).digest('hex').slice(0, 12);
  if (generation < 1 || !Number.isSafeInteger(generation)) throw new RecoveryError('invalid_request');
  return `sencho-recovery-${authority}-${owner}-g${generation}`;
}

/** The generation a repository locator names, or null when it names none. */
export function generationOfLocator(locator: string): number | null {
  const match = /-g(\d+)$/.exec(locator);
  if (!match) return null;
  const generation = Number(match[1]);
  return Number.isSafeInteger(generation) && generation >= 1 ? generation : null;
}

/** The reserved prefix every recovery-owned volume and image name starts with. */
export const RECOVERY_RESERVED_PREFIX = 'sencho-recovery-';

/** Owner engine key for a node, memoized: it never changes while the daemon lives. */
const ownerKeyCache = new Map<number, Promise<string>>();

export function ownerNodeKeyFor(nodeId: number, docker: Pick<Docker, 'info'>): Promise<string> {
  const cached = ownerKeyCache.get(nodeId);
  if (cached) return cached;
  const pending = resolveOwnerNodeKey(docker).catch((err: unknown) => {
    ownerKeyCache.delete(nodeId);
    throw err;
  });
  ownerKeyCache.set(nodeId, pending);
  return pending;
}

/** Test seam: forget memoized engine identities. */
export function resetOwnerNodeKeyCacheForTests(): void {
  ownerKeyCache.clear();
}

export interface RepositoryRunContext {
  runner: RecoveryHelperRunner;
  repositoryVolume: string;
  secret: string;
  signal?: AbortSignal;
  operationId: string;
}

function stderrNote(result: HelperRunResult): string {
  return sanitizeForLog(result.stderrTail.split('\n').filter((l) => l.trim() !== '').slice(-2).join(' ')).slice(0, 300);
}

export type RepositoryOpenResult =
  | { kind: 'open'; fingerprint: string }
  /** Exit 10: the path is a volume with no restic repository in it. */
  | { kind: 'absent' }
  | { kind: 'failed'; errorClass: RecoveryErrorClass };

/**
 * Read and parse `restic cat config` in one call: the caller passes the sink the
 * runner fills, so no capture of the whole stream is needed. `--no-lock` lets a
 * health read run against a repository mounted read-only and leaves no lock
 * behind if the helper is killed.
 */
export async function readRepositoryConfig(ctx: RepositoryRunContext): Promise<RepositoryOpenResult> {
  // `cat config` prints a pretty-printed object across several lines, so the
  // whole of stdout is collected and the JSON object inside it is parsed.
  const lines: string[] = [];
  const result = await ctx.runner.run({
    profile: 'config',
    operationId: ctx.operationId,
    cmd: resticCommand('/repo', ['cat', 'config', '--no-lock']),
    mounts: { repository: ctx.repositoryVolume },
    stdinSecret: ctx.secret,
    signal: ctx.signal,
    onStdoutLine: (line) => {
      lines.push(line);
    },
  });
  if (result.aborted) return { kind: 'failed', errorClass: 'interrupted' };
  if (result.killed) return { kind: 'failed', errorClass: 'node_error' };
  switch (result.exitCode) {
    case 0: {
      const config = parseRepositoryConfig(extractJsonObject(lines.join('\n')));
      if (!config) {
        console.error('[Recovery] Repository config could not be parsed:', stderrNote(result));
        return { kind: 'failed', errorClass: 'repository_unavailable' };
      }
      return { kind: 'open', fingerprint: config.id };
    }
    case 10:
      return { kind: 'absent' };
    case 12:
      return { kind: 'failed', errorClass: 'repository_key_unavailable' };
    case 11:
      return { kind: 'failed', errorClass: 'lock_held' };
    default:
      console.error('[Recovery] Repository open failed with exit %s: %s', String(result.exitCode), stderrNote(result));
      return { kind: 'failed', errorClass: 'repository_unavailable' };
  }
}

/** Initialize a repository this volume does not yet hold. */
export async function initRepository(ctx: RepositoryRunContext): Promise<RepositoryOpenResult> {
  const result = await ctx.runner.run({
    profile: 'init',
    operationId: ctx.operationId,
    cmd: resticCommand('/repo', ['init']),
    mounts: { repository: ctx.repositoryVolume },
    stdinSecret: ctx.secret,
    signal: ctx.signal,
  });
  if (result.aborted) return { kind: 'failed', errorClass: 'interrupted' };
  if (result.killed) return { kind: 'failed', errorClass: 'node_error' };
  if (result.exitCode !== 0) {
    console.error('[Recovery] Repository init failed with exit %s: %s', String(result.exitCode), stderrNote(result));
    return {
      kind: 'failed',
      errorClass: result.exitCode === 12 ? 'repository_key_unavailable' : 'repository_unavailable',
    };
  }
  // The fingerprint is written at once, from the repository the init just made.
  return readRepositoryConfig(ctx);
}

/**
 * Clear restic's own locks. Runs while Sencho still holds the repository lock
 * (or at boot, before any operation can exist), because Sencho's lock is the real
 * mutual exclusion: a helper that died left
 * restic's lock behind, and waiting 30 minutes for it to expire would leave the
 * node unusable for no reason. Answers whether restic reported the locks cleared.
 */
export async function unlockRepository(ctx: RepositoryRunContext): Promise<boolean> {
  try {
    const result = await ctx.runner.run({
      profile: 'unlock',
      operationId: ctx.operationId,
      cmd: resticCommand('/repo', ['unlock', '--remove-all']),
      mounts: { repository: ctx.repositoryVolume },
      stdinSecret: ctx.secret,
    });
    if (result.exitCode !== 0) {
      console.warn(
        '[Recovery] Repository unlock exited %s for operation %s: %s',
        String(result.exitCode), ctx.operationId, stderrNote(result),
      );
    }
    return result.exitCode === 0;
  } catch (err) {
    // An unlock that could not run is logged; the next capture's own result is
    // the authority on whether the repository is usable.
    console.warn('[Recovery] Repository unlock could not run:', errorMessageForLog(err));
    return false;
  }
}

/** A repository-wide integrity check. */
export async function checkRepository(
  ctx: RepositoryRunContext,
  method: IntegrityMethod,
): Promise<IntegrityOutcome> {
  const args = ['check', '--no-lock'];
  if (method === 'engine_check_read_data') args.push('--read-data');
  const result = await ctx.runner.run({
    profile: 'check',
    operationId: ctx.operationId,
    cmd: resticCommand('/repo', args),
    mounts: { repository: ctx.repositoryVolume },
    stdinSecret: ctx.secret,
    signal: ctx.signal,
  });
  const outcome = classifyCheckRun({
    exitCode: result.exitCode,
    aborted: result.aborted,
    killed: result.killed,
    stderrTail: result.stderrTail,
  });
  if (outcome.result !== 'verified') {
    console.warn(
      '[Recovery] Repository check for operation %s: %s%s',
      ctx.operationId,
      outcome.result,
      result.stderrTail ? ` (${stderrNote(result)})` : '',
    );
  }
  return outcome;
}

export interface ProvisionDeps {
  nodeId: number;
  docker: Docker;
  authorityId: string;
  ownerNodeKey: string;
  runner: RecoveryHelperRunner;
  operationId: string;
  signal?: AbortSignal;
  /** Called when this attempt started the repository, so the caller can log it. */
  onEvent?: (event: 'registered' | 'secret_created' | 'volume_created' | 'adopted' | 'initialized' | 'replaced') => void;
  /**
   * Take the repository lock as soon as the row exists, before the volume is
   * touched, so no other repository work can race a half-provisioned volume.
   */
  acquireLock?: (repositoryId: string) => void;
}

export interface ProvisionResult {
  repository: RepositoryDescriptor;
  created: boolean;
}

export class RepositoryProvisioner {
  private readonly repositories = RecoveryRepositoryStore.getInstance();

  /**
   * Bring this node to a working repository, or continue one a crash left half
   * made. `replace` registers a new locator generation and moves the active
   * pointer; the previous repository row and volume are kept.
   */
  async provision(deps: ProvisionDeps, options: { replace?: boolean; generation: number }): Promise<ProvisionResult> {
    const registration: RepositoryRegistration = {
      ownerNodeKey: deps.ownerNodeKey,
      kind: 'local_volume',
      locator: repositoryVolumeName(deps.authorityId, deps.ownerNodeKey, options.generation),
      // A Docker volume on the same engine is not a separate disk. The docs say
      // so, and the API returns the same sentence.
      failureDomain: 'same_failure_domain',
    };
    const repository = this.repositories.register(registration);
    deps.onEvent?.('registered');
    deps.acquireLock?.(repository.id);

    // Never overwrite a stored key: the points already in the repository can only
    // be read with the password that made them.
    const wroteSecret = this.repositories.storeSecretIfAbsent(repository.id, generateRepositorySecret);
    if (wroteSecret) deps.onEvent?.('secret_created');
    const secret = this.repositories.readSecret(repository.id);

    // The volume must carry this repository's label. Docker returns an existing
    // volume silently, so the label is the only proof that this volume is ours.
    const volume = await this.ensureVolume(deps, repository.locator, repository.id);
    if (volume.created) deps.onEvent?.('volume_created');

    const ctx: RepositoryRunContext = {
      runner: deps.runner,
      repositoryVolume: repository.locator,
      secret,
      signal: deps.signal,
      operationId: deps.operationId,
    };

    const opened = await readRepositoryConfig(ctx);
    if (opened.kind === 'open') {
      this.repositories.setFingerprint(repository.id, opened.fingerprint);
      if (repository.repositoryFingerprint === null) deps.onEvent?.('adopted');
      this.repositories.setActive(repository.id);
      if (options.replace && repository.repositoryFingerprint !== null) deps.onEvent?.('replaced');
      return { repository: this.requireRepository(repository.id), created: volume.created };
    }
    if (opened.kind === 'failed') throw new RecoveryError(opened.errorClass);
    // `absent`: this labelled volume holds no repository. Initialize it, then
    // record the fingerprint at once so a crash after this point adopts rather
    // than re-initializes.
    const initialized = await initRepository(ctx);
    if (initialized.kind !== 'open') {
      throw new RecoveryError(initialized.kind === 'failed' ? initialized.errorClass : 'repository_unavailable');
    }
    this.repositories.setFingerprint(repository.id, initialized.fingerprint);
    this.repositories.setActive(repository.id);
    deps.onEvent?.('initialized');
    return { repository: this.requireRepository(repository.id), created: true };
  }

  private async ensureVolume(
    deps: ProvisionDeps,
    volumeName: string,
    repositoryId: string,
  ): Promise<{ created: boolean }> {
    const labels = { [HELPER_LABEL_REPOSITORY]: repositoryId };
    let created = false;
    try {
      const inspected = await deps.docker.getVolume(volumeName).inspect() as {
        Labels?: Record<string, string> | null;
      };
      assertRepositoryVolumeOwner(inspected.Labels, repositoryId);
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
      try {
        await deps.docker.createVolume({ Name: volumeName, Driver: REPOSITORY_VOLUME_DRIVER, Labels: labels });
        created = true;
      } catch (createErr) {
        const status = (createErr as { statusCode?: number }).statusCode;
        // Another attempt may have created it between the inspect and the create.
        if (status !== 409) {
          console.error('[Recovery] Repository volume could not be created:', errorMessageForLog(createErr));
          throw new RecoveryError('capability_unavailable');
        }
        const inspected = await deps.docker.getVolume(volumeName).inspect() as {
          Labels?: Record<string, string> | null;
        };
        assertRepositoryVolumeOwner(inspected.Labels, repositoryId);
      }
    }
    return { created };
  }

  private requireRepository(id: string): RepositoryDescriptor {
    const descriptor = this.repositories.get(id);
    if (!descriptor) throw new RecoveryError('repository_unavailable');
    return descriptor;
  }
}

/**
 * The outermost JSON object in a stream, ignoring anything a command printed
 * around it. This build never trusts the rest of that text.
 */
function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return '';
  return text.slice(start, end + 1);
}

/** A volume without this repository's label is not ours, whatever its name. */
export function assertRepositoryVolumeOwner(labels: Record<string, string> | null | undefined, repositoryId: string): void {
  if (!labels || labels[HELPER_LABEL_REPOSITORY] !== repositoryId) {
    throw new RecoveryError('repository_unavailable');
  }
}

/** This instance's authority id, for callers that build labels. */
export function recoveryAuthority(): string {
  return getRecoveryAuthorityId();
}

/** Record a repository-wide check against every point it covers. */
export function recordRepositoryCheck(
  repositoryId: string,
  method: IntegrityMethod,
  result: 'verified' | 'mismatch' | 'error',
  operationId: string | null,
): number {
  return RecoveryPointStore.getInstance().recordVerificationForRepository(repositoryId, method, result, operationId);
}

/** The engine registered at startup, for callers that need its id. */
export function registeredEngineId(engines: readonly BackupEngine[]): string | null {
  return engines[0]?.engineId ?? null;
}
