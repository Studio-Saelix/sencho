import { loadNativeTlsMaterial } from '../../helpers/nativeTls';
import { sanitizeForLog } from '../../utils/safeLog';
import { DatabaseService } from '../DatabaseService';
import { buildBootstrapEvidence } from './evidence';
import {
  DEFAULT_AGENT_DIR,
  DEFAULT_COMPOSE_DIR,
  DENIED_EXACT_ROOTS,
  MAX_PATH_LENGTH,
  RESERVED_PATH_PREFIXES,
  arePathsDisjoint,
  validatePathSyntax,
} from './pathPolicy';
import { buildBootstrapPlan } from './planBuilder';
import {
  assembleFacts,
  buildProbeCatalog,
  parseFstabMountPoints,
  validateHubUrl,
} from './probes';
import {
  AGENT_FREE_BLOCK_BYTES,
  AGENT_FREE_WARN_BYTES,
  COMPOSE_FREE_BLOCK_BYTES,
  COMPOSE_FREE_WARN_BYTES,
  DENIED_FILESYSTEMS,
  DOCKER_ROOT_FREE_BLOCK_BYTES,
  DOCKER_ROOT_FREE_WARN_BYTES,
} from './evidence';
import {
  SSH_TOTAL_TIMEOUT_MS,
  SshTransportError,
  type BootstrapTransport,
  type SshCommandResult,
} from './sshProbeClient';
import { sshProbeClient } from './sshProbeClient';
import {
  resolveTargetAddresses,
  validateTarget,
  type BootstrapTargetInput,
} from './targetPolicy';
import type {
  BootstrapCapabilities,
  BootstrapHostKeyResult,
  BootstrapPreflightResult,
  HostKeyObservation,
} from './types';

/**
 * Orchestration for the read-only bootstrap preflight: target resolution, host
 * key trust, the probe run, evidence, plan and audit.
 *
 * Nothing here mutates the target. The per-target lock exists so two operators
 * cannot interleave handshakes against the same host, and it is process-local
 * because a restart loses nothing that was not already read-only.
 */

export type BootstrapErrorCode =
  | 'INVALID_TARGET'
  | 'INVALID_PATH'
  | 'HOST_KEY_MISMATCH'
  | 'HOST_KEY_UNTRUSTED'
  | 'BOOTSTRAP_IN_PROGRESS'
  | 'PREFLIGHT_FAILED';

export class BootstrapError extends Error {
  public readonly status: number;
  public readonly code: BootstrapErrorCode;
  public readonly field?: string;
  public readonly details: Record<string, unknown>;

  public constructor(
    status: number,
    code: BootstrapErrorCode,
    message: string,
    options: { field?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'BootstrapError';
    this.status = status;
    this.code = code;
    this.field = options.field;
    this.details = options.details ?? {};
  }
}

export interface BootstrapPreflightRequest {
  host: string;
  port?: number;
  username: string;
  privateKey: string;
  passphrase?: string | null;
  expectedFingerprint?: string | null;
  replacePinnedFingerprint?: string | null;
  targetName: string;
  composeDir?: string;
  agentDir?: string;
}

interface AuditContext {
  username: string;
  ip: string;
  method: string;
  path: string;
}

type AddressResolver = (host: string) => Promise<string[]>;

interface BootstrapDeps {
  transport: BootstrapTransport;
  db: DatabaseService;
  now: () => number;
  resolveAddresses: AddressResolver;
  caPem: () => string | null;
  /** Preflight request budget, including DNS; default is the advertised 90 seconds. */
  requestBudgetMs: number;
}

/**
 * DatabaseService is resolved lazily: evaluating `getInstance()` at module load
 * would initialize the DB before tests (and any caller) can point DATA_DIR at
 * their own copy.
 */
const DEFAULT_DEPS: Omit<BootstrapDeps, 'db'> = {
  transport: sshProbeClient,
  now: () => Date.now(),
  resolveAddresses: (hostname) => resolveTargetAddresses(hostname),
  caPem: () => (loadNativeTlsMaterial()?.caPem ?? null),
  requestBudgetMs: SSH_TOTAL_TIMEOUT_MS,
};

export function validateInstallPaths(composeDirRaw: string, agentDirRaw: string): { composeDir: string; agentDir: string } {
  const compose = validatePathSyntax(composeDirRaw, 'compose');
  if (!compose.ok) {
    throw new BootstrapError(400, 'INVALID_PATH', compose.message ?? 'Invalid Compose directory', { field: 'composeDir' });
  }
  const agent = validatePathSyntax(agentDirRaw, 'agent');
  if (!agent.ok) {
    throw new BootstrapError(400, 'INVALID_PATH', agent.message ?? 'Invalid Agent directory', { field: 'agentDir' });
  }
  const separation = arePathsDisjoint(compose.normalized as string, agent.normalized as string);
  if (!separation.ok) {
    const message = separation.reason === 'equal'
      ? 'The two directories must be different paths.'
      : separation.reason === 'agent-inside-compose'
        ? 'The Agent directory must not be inside the Compose directory.'
        : 'The Compose directory must not be inside the Agent directory.';
    throw new BootstrapError(400, 'INVALID_PATH', message, {
      field: separation.reason === 'compose-inside-agent' ? 'composeDir' : 'agentDir',
    });
  }
  return { composeDir: compose.normalized as string, agentDir: agent.normalized as string };
}


export class NodeBootstrapService {
  private static instance: NodeBootstrapService | null = null;
  private readonly deps: BootstrapDeps;
  private readonly inFlight = new Set<string>();

  public constructor(deps: Partial<BootstrapDeps> = {}) {
    this.deps = { ...DEFAULT_DEPS, db: DatabaseService.getInstance(), ...deps };
  }

  public static getInstance(): NodeBootstrapService {
    if (!NodeBootstrapService.instance) NodeBootstrapService.instance = new NodeBootstrapService();
    return NodeBootstrapService.instance;
  }

  public getCapabilities(): BootstrapCapabilities {
    return {
      supported: { os: ['ubuntu-22.04', 'ubuntu-24.04'], arch: ['x86_64'] },
      defaults: { composeDir: DEFAULT_COMPOSE_DIR, agentDir: DEFAULT_AGENT_DIR },
      fixed: {
        projectName: 'sencho-agent',
        containerName: 'sencho-agent',
        dataVolume: 'sencho-agent-data',
        dataMount: '/app/data',
        image: 'saelix/sencho:latest',
      },
      limits: {
        maxPathLength: MAX_PATH_LENGTH,
        blockBelowComposeFreeBytes: COMPOSE_FREE_BLOCK_BYTES,
        warnBelowComposeFreeBytes: COMPOSE_FREE_WARN_BYTES,
        blockBelowAgentFreeBytes: AGENT_FREE_BLOCK_BYTES,
        warnBelowAgentFreeBytes: AGENT_FREE_WARN_BYTES,
        blockBelowDockerRootFreeBytes: DOCKER_ROOT_FREE_BLOCK_BYTES,
        warnBelowDockerRootFreeBytes: DOCKER_ROOT_FREE_WARN_BYTES,
      },
      pathPolicy: {
        reservedPrefixes: [...RESERVED_PATH_PREFIXES],
        exactRoots: [...DENIED_EXACT_ROOTS],
        deniedFilesystems: [...DENIED_FILESYSTEMS],
      },
    };
  }

  /** Capture the host key without authenticating. Aborts the handshake after the key. */
  public async captureHostKey(input: { host: string; port?: number }): Promise<BootstrapHostKeyResult> {
    let host: string;
    let port: number;
    try {
      const validated = validateTarget({
        host: input.host,
        port: input.port,
        username: 'probeuser',
        targetName: 'probe',
      });
      host = validated.host;
      port = validated.port;
    } catch (error: unknown) {
      const field = (error as { field?: string }).field;
      const message = error instanceof Error ? error.message : 'Invalid target';
      throw new BootstrapError(400, 'INVALID_TARGET', message, { field });
    }
    const addresses = await this.resolveOrThrow(host, Date.now() + this.deps.requestBudgetMs);
    let dialed = addresses[0];
    const observation = await this.withTargetLock(host, port, async () => {
      let lastError: unknown = null;
      for (const address of addresses) {
        try {
          const captured = await this.deps.transport.captureHostKey({ host, address, port });
          dialed = address;
          return captured;
        } catch (error: unknown) {
          // A rejected host key is a decision about the target, not a reason to
          // try another record: falling through could reach a pinned key on a
          // different address and hide the change.
          if (error instanceof SshTransportError && error.code === 'HOST_KEY_UNTRUSTED') throw error;
          lastError = error;
        }
      }
      throw lastError ?? new Error('No address answered');
    });

    const pin = this.deps.db.getNodeBootstrapTrust(host, port);
    const trust = pin
      ? (pin.fingerprint === observation.fingerprint ? 'trusted' : 'changed')
      : 'unknown';
    return {
      host,
      port,
      address: dialed,
      algorithm: observation.algorithm,
      fingerprint: observation.fingerprint,
      knownHostsLine: observation.knownHostsLine,
      trust,
      pinnedFingerprint: pin?.fingerprint ?? null,
    };
  }

  /** Run the read-only inspection and, when unblocked, build the plan. */
  public async preflight(
    input: BootstrapPreflightRequest,
    context: { hubUrl: string; audit: AuditContext },
  ): Promise<BootstrapPreflightResult> {
    const targetInput = this.validateTargetInput(input);
    const paths = validateInstallPaths(
      input.composeDir ?? DEFAULT_COMPOSE_DIR,
      input.agentDir ?? DEFAULT_AGENT_DIR,
    );
    const expectedFingerprint = input.expectedFingerprint?.trim() || null;
    const replacePinnedFingerprint = input.replacePinnedFingerprint?.trim() || null;
    const hubCheck = validateHubUrl(context.hubUrl);
    if (!hubCheck.ok) {
      throw new BootstrapError(
        400,
        'INVALID_TARGET',
        `${hubCheck.reason ?? 'The hub URL is not valid.'} Set SENCHO_PUBLIC_URL to a URL without credentials.`,
      );
    }

    const deadline = Date.now() + this.deps.requestBudgetMs;
    const preparedKey = input.privateKey ?? '';
    const passphrase = input.passphrase ?? null;
    let hostKey: HostKeyObservation | null = null;
    let dialed = '';
    let pin: import('../DatabaseService').NodeBootstrapTrust | undefined;

    // The pin is read, validated and written under the same per-target lock as
    // the probe run and DNS resolution. A concurrent preflight can therefore
    // never pass validation against a stale snapshot and overwrite a newer pin.
    const results = await this.withTargetLock(targetInput.host, targetInput.port, async () => {
      pin = this.deps.db.getNodeBootstrapTrust(targetInput.host, targetInput.port);
      this.assertPinnedTrust(targetInput, pin, expectedFingerprint, replacePinnedFingerprint, context.audit);

      const addresses = await this.resolveOrThrow(targetInput.host, deadline);
      dialed = addresses[0];
      let lastError: unknown = null;
      for (const address of addresses) {
        try {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            throw new SshTransportError('PREFLIGHT_TIMEOUT', 'The preflight exceeded its 90-second budget.');
          }
          const probeResults = await this.runProbes(
            address,
            targetInput,
            preparedKey,
            passphrase,
            expectedFingerprint,
            context.hubUrl,
            paths,
            remaining,
            (observation) => { hostKey = observation; },
          );
          if (probeResults.some((result) => result.error === 'PREFLIGHT_TIMEOUT')) {
            throw new SshTransportError('PREFLIGHT_TIMEOUT', 'The preflight exceeded its 90-second budget.');
          }
          dialed = address;
          const observation: HostKeyObservation = hostKey ?? {
            algorithm: 'unknown',
            fingerprint: expectedFingerprint ?? '',
            knownHostsLine: `${targetInput.host} expected ${expectedFingerprint ?? ''}`,
          };
          this.persistTrust(
            targetInput,
            observation,
            context.audit,
            pin,
            expectedFingerprint,
            replacePinnedFingerprint,
          );
          return probeResults;
        } catch (error: unknown) {
          if (error instanceof BootstrapError) throw error;
          if (error instanceof SshTransportError && error.code === 'HOST_KEY_UNTRUSTED') {
            // A live key that changes between capture and connection is a trust
            // event, not a generic transport failure. Keep both identities.
            const observedFingerprint = hostKey?.fingerprint ?? null;
            this.recordAudit(context.audit, 'bootstrap.trust.mismatch', {
              target: targetInput.targetName,
              host: targetInput.host,
              port: targetInput.port,
              address,
              pinned: pin?.fingerprint ?? null,
              expected: expectedFingerprint,
              observed: observedFingerprint,
            }, 409);
            throw new BootstrapError(409, 'HOST_KEY_UNTRUSTED', error.message, {
              details: {
                pinnedFingerprint: pin?.fingerprint ?? null,
                expectedFingerprint,
                observedFingerprint,
              },
            });
          }
          lastError = error;
        }
      }
      throw lastError ?? new Error('No address answered');
    });

    const now = this.deps.now();
    const hostKeyObservation: HostKeyObservation = hostKey ?? {
      algorithm: 'unknown',
      fingerprint: expectedFingerprint ?? '',
      knownHostsLine: `${targetInput.host} expected ${expectedFingerprint ?? ''}`,
    };
    const facts = assembleFacts({
      target: {
        host: targetInput.host,
        port: targetInput.port,
        username: targetInput.username,
        address: dialed,
      },
      hostKey: hostKeyObservation,
      hubUrl: context.hubUrl,
      composeDir: paths.composeDir,
      agentDir: paths.agentDir,
      results,
      fstabMountPoints: parseFstabMountPoints(
        results.find((result) => result.id === 'fstab')?.stdout ?? '',
      ),
      now,
    });

    const nodeNameTaken = this.deps.db.getNodes().some((node) => node.name === targetInput.targetName);
    const evidence = buildBootstrapEvidence({ facts, nodeNameTaken, targetName: targetInput.targetName });
    const blocked = evidence.blockers > 0 || evidence.planSuppressed;
    const plan = blocked
      ? null
      : buildBootstrapPlan({
        facts,
        targetName: targetInput.targetName,
        hubUrl: context.hubUrl,
        caPem: this.deps.caPem(),
        now,
      });

    this.recordAudit(context.audit, 'bootstrap.preflight', {
      target: targetInput.targetName,
      host: targetInput.host,
      port: targetInput.port,
      address: dialed,
      fingerprint: hostKeyObservation.fingerprint,
      composeDir: paths.composeDir,
      composeReal: facts.paths.composeDir.realPath,
      agentDir: paths.agentDir,
      agentReal: facts.paths.agentDir.realPath,
      project: 'sencho-agent',
      volume: 'sencho-agent-data',
      stacks: facts.paths.composeDir.stackCount,
      blocked,
      digest: plan?.digest ?? null,
    });

    return {
      inspection: {
        observedAt: now,
        target: facts.target,
        hostKey: hostKeyObservation,
        paths: facts.paths,
        agent: facts.agent,
        dockerRoot: facts.dockerRoot,
        checks: evidence.checks,
        blockers: evidence.blockers,
        warnings: evidence.warnings,
      },
      plan,
      blocked,
    };
  }

  private validateTargetInput(input: BootstrapPreflightRequest): BootstrapTargetInput {
    try {
      return validateTarget({
        host: input.host,
        port: input.port,
        username: input.username,
        targetName: input.targetName,
      });
    } catch (error: unknown) {
      const field = (error as { field?: string }).field;
      const message = error instanceof Error ? error.message : 'Invalid target';
      throw new BootstrapError(400, 'INVALID_TARGET', message, { field });
    }
  }

  private async resolveOrThrow(host: string, deadline: number): Promise<string[]> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new SshTransportError('PREFLIGHT_TIMEOUT', 'The preflight exceeded its 90-second budget.');
    }
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        this.deps.resolveAddresses(host),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new SshTransportError('PREFLIGHT_TIMEOUT', 'The preflight exceeded its 90-second budget.'));
          }, remaining);
        }),
      ]);
    } catch (error: unknown) {
      if (error instanceof SshTransportError) throw error;
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : 'The target host could not be resolved.';
      if (code === 'SSH_DNS_FAILED') {
        throw new BootstrapError(422, 'PREFLIGHT_FAILED', message);
      }
      throw new BootstrapError(400, 'INVALID_TARGET', message);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * One connection, the whole fixed catalog. Sudo variants are included even on
   * a direct-access host: `sudo -n` refuses immediately when a password would be
   * required, and keeping the run in one session is worth those fast failures.
   */
  private async runProbes(
    address: string,
    target: BootstrapTargetInput,
    privateKey: string,
    passphrase: string | null,
    expectedFingerprint: string | null,
    hubUrl: string,
    paths: { composeDir: string; agentDir: string },
    totalMs: number,
    onHostKey: (observation: HostKeyObservation) => void,
  ): Promise<SshCommandResult[]> {
    const catalog = buildProbeCatalog({
      composeDir: paths.composeDir,
      agentDir: paths.agentDir,
      hubUrl,
    });
    return this.deps.transport.runCommands(
      {
        host: target.host,
        address,
        port: target.port,
        username: target.username,
        privateKey,
        passphrase,
      },
      catalog.map(({ id, command }) => ({ id, command })),
      { expectedFingerprint, onHostKey, totalMs },
    );
  }

  /** Validate the request against the pin observed at the start of the locked run. */
  private assertPinnedTrust(
    target: BootstrapTargetInput,
    pin: import('../DatabaseService').NodeBootstrapTrust | undefined,
    expectedFingerprint: string | null,
    replacePinnedFingerprint: string | null,
    audit: AuditContext,
  ): void {
    if (pin) {
      const replaced = replacePinnedFingerprint !== null && replacePinnedFingerprint === expectedFingerprint;
      if (!expectedFingerprint || (pin.fingerprint !== expectedFingerprint && !replaced)) {
        this.recordAudit(audit, 'bootstrap.trust.mismatch', {
          target: target.targetName,
          host: target.host,
          port: target.port,
          pinned: pin.fingerprint,
          expected: expectedFingerprint,
        }, 409);
        throw new BootstrapError(
          409,
          'HOST_KEY_MISMATCH',
          'The host key does not match the pinned key. Confirm the replacement to continue.',
          { details: { pinnedFingerprint: pin.fingerprint, expectedFingerprint } },
        );
      }
    } else if (!expectedFingerprint) {
      throw new BootstrapError(
        409,
        'HOST_KEY_UNTRUSTED',
        'Trust this host key before running the preflight.',
      );
    }
  }

  /**
   * Compare-and-swap the pin against the record read at the start of this
   * locked run. A pin that changed underneath the request is never overwritten
   * without confirming the replacement of the key that is current now.
   */
  private persistTrust(
    target: BootstrapTargetInput,
    hostKey: HostKeyObservation,
    context: AuditContext,
    initialPin: import('../DatabaseService').NodeBootstrapTrust | undefined,
    expectedFingerprint: string | null,
    replacePinnedFingerprint: string | null,
  ): void {
    if (!hostKey.fingerprint) return;
    const current = this.deps.db.getNodeBootstrapTrust(target.host, target.port);
    if ((current?.fingerprint ?? null) !== (initialPin?.fingerprint ?? null)) {
      this.recordAudit(context, 'bootstrap.trust.mismatch', {
        target: target.targetName,
        host: target.host,
        port: target.port,
        pinned: current?.fingerprint ?? null,
        expected: expectedFingerprint,
        observed: hostKey.fingerprint,
      }, 409);
      throw new BootstrapError(
        409,
        'HOST_KEY_MISMATCH',
        'The pinned key changed while the preflight was running. Confirm the replacement and run it again.',
        { details: { pinnedFingerprint: current?.fingerprint ?? null, expectedFingerprint } },
      );
    }
    const replaced = replacePinnedFingerprint !== null && replacePinnedFingerprint === expectedFingerprint;
    if (current && current.fingerprint !== hostKey.fingerprint && !replaced) {
      this.recordAudit(context, 'bootstrap.trust.mismatch', {
        target: target.targetName,
        host: target.host,
        port: target.port,
        pinned: current.fingerprint,
        expected: expectedFingerprint,
        observed: hostKey.fingerprint,
      }, 409);
      throw new BootstrapError(
        409,
        'HOST_KEY_MISMATCH',
        'The host key does not match the pinned key. Confirm the replacement to continue.',
        { details: { pinnedFingerprint: current.fingerprint, expectedFingerprint } },
      );
    }
    const now = this.deps.now();
    const unchanged = current?.fingerprint === hostKey.fingerprint;
    this.deps.db.upsertNodeBootstrapTrust({
      host: target.host,
      port: target.port,
      fingerprint: hostKey.fingerprint,
      algorithm: hostKey.algorithm,
      approved_by: unchanged ? (current?.approved_by ?? context.username) : context.username,
      approved_at: unchanged ? (current?.approved_at ?? now) : now,
      last_seen_at: now,
    });
    if (!current) {
      this.recordAudit(context, 'bootstrap.trust.pinned', {
        host: target.host,
        port: target.port,
        fingerprint: hostKey.fingerprint,
      });
    } else if (current.fingerprint !== hostKey.fingerprint) {
      this.recordAudit(context, 'bootstrap.trust.replaced', {
        host: target.host,
        port: target.port,
        previous: current.fingerprint,
        fingerprint: hostKey.fingerprint,
      });
    }
  }

  private async withTargetLock<T>(host: string, port: number, run: () => Promise<T>): Promise<T> {
    const key = `${host}:${port}`;
    if (this.inFlight.has(key)) {
      throw new BootstrapError(409, 'BOOTSTRAP_IN_PROGRESS', 'A preflight for this host is already running.');
    }
    this.inFlight.add(key);
    try {
      return await run();
    } finally {
      this.inFlight.delete(key);
    }
  }

  private recordAudit(context: AuditContext, action: string, facts: Record<string, unknown>, statusCode = 200): void {
    const summary = `${action}: ${Object.entries(facts)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => `${key}=${sanitizeForLog(String(value))}`)
      .join(' ')}`;
    try {
      this.deps.db.insertAuditLog({
        timestamp: this.deps.now(),
        username: context.username,
        method: context.method,
        path: context.path,
        status_code: statusCode,
        node_id: null,
        ip_address: context.ip,
        summary,
      });
    } catch (error: unknown) {
      console.warn('[Bootstrap] Audit log write failed:', error instanceof Error ? error.message : 'unknown');
    }
  }
}
