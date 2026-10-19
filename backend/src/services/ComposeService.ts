import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import WebSocket from 'ws';
import DockerController from './DockerController';
import { DatabaseService } from './DatabaseService';
import { FileSystemService } from './FileSystemService';
import { MeshService } from './MeshService';
import { LogFormatter } from './LogFormatter';
import { NodeRegistry } from './NodeRegistry';
import { RegistryService } from './RegistryService';
import { RegistryDeliveryService } from './RegistryDeliveryService';
import { createDockerAuthTempDir } from '../helpers/dockerAuthTempDir';
import { getRegistryDeliveryContext } from '../helpers/registryDeliveryContext';
import { PreparedSourceStore } from '../services/preparedSourceStore';
import { recordRegistryDeliveryEvent } from '../helpers/registryDeliveryEvidence';
import { resolveRegistryAuthAtSeam } from '../helpers/registryDeliverySeam';
import { DriftLedgerService } from './DriftLedgerService';
import SelfIdentityService from './SelfIdentityService';
import { parseEffectiveModel, type EffectiveModel } from './preflight/effectiveModel';
import { deriveStackExposure } from './preflight/exposure';

import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';
import { normalizeContainerName } from '../utils/log-parsing';
import { describeSpawnError } from '../utils/spawnErrors';
import { isPathWithinBase, isValidStackName, isValidRelativeStackPath } from '../utils/validation';
import { COMPOSE_OVERRIDE_FILENAMES, COMPOSE_ROOT_FILENAMES } from '../utils/composeFilenames';
import { authoredComposeFileArgs, authoredComposeEnvFileArgs } from '../utils/authoredComposeArgs';
import type { RollbackInvocationRecord } from '../types/rollbackGeneration';
import { parseMissingRequiredVars } from '../helpers/envVarParse';
import { redactSensitiveText, sanitizeForLog } from '../utils/safeLog';
import { randomUUID } from 'crypto';
import { GitOpsStore } from './gitops/store';
import { GitOpsTransitions } from './gitops/transitions';
import { pathsMatch, resolveHostBindPath } from '../utils/composePathMapping';
import { loadStackBuildServices } from './ImageUpdateService';
import { resolveMissingExternalNetworks } from './network/resolveMissingExternalNetworks';
import {
  MissingExternalNetworksError,
  type DeployInvocationContext,
} from './network/missingExternalNetworksError';
import { digestPinsOverlayYaml, type DigestPinsMap } from './gitops/digestPins';
import { DIGEST_PIN_TEMP_PREFIX } from '../helpers/digestPinTempDir';
import { assertGitOverlaySource, SOPS_DIRECT_MUTATION_MESSAGE } from './gitops/sops/prepareOverlay';
import { classifyInputEncryption, resolveActiveRequiredRecipients } from './gitops/sops/capability';
import { GitOpsDecryptOverlay } from './gitops/sops/overlay';
import { gitSecretsAreaBase } from './gitops/managedPaths';
import {
  PERSISTENT_BIND_REFUSAL,
  PERSISTENT_BIND_UNSAFE,
  planPersistentBindRemap,
} from './gitops/sops/persistentBinds';
import {
  decryptedComposeOutputWithheld,
  runWithDecryptedComposeOutput,
  WITHHELD_DECRYPTED_COMPOSE_OUTPUT,
  WITHHELD_DECRYPTED_COMPOSE_STREAM,
  WITHHELD_DECRYPTED_REQUIRED_ENV_OUTPUT,
} from '../helpers/decryptedComposeOutput';
import { buildUnifiedHeldImagePredicate } from './recoveryHeldImages';
import { invalidateNodeCaches } from '../helpers/cacheInvalidation';
import type { NotificationCategory } from './NotificationService';

/** True when a generation capture recorded an invocation object (prefix may be empty). */
function hasUsableCapturedInvocation(
  invocation: RollbackInvocationRecord | null | undefined,
): invocation is RollbackInvocationRecord {
  return invocation != null;
}

function recordNetworkAutoCreatedActivity(
  nodeId: number,
  stackName: string,
  createdNames: string[],
  level: 'info' | 'warning',
  ctx?: DeployInvocationContext,
): void {
  if (createdNames.length === 0) return;
  const names = [...createdNames].sort((a, b) => a.localeCompare(b)).join(', ');
  const source = ctx?.source ?? 'manual';
  try {
    DatabaseService.getInstance().addNotificationHistory(nodeId, {
      level,
      category: 'network_auto_created' as NotificationCategory,
      message: `Auto-created external network(s) for ${stackName}: ${names} (source: ${source})`,
      timestamp: Date.now(),
      stack_name: stackName,
      actor_username: ctx?.actor ?? null,
    });
  } catch (error) {
    console.error(
      '[ComposeService] Failed to record network_auto_created activity for %s:',
      sanitizeForLog(stackName),
      sanitizeForLog(getErrorMessage(error, 'unknown')),
    );
  }
}

export class ComposeRollbackError extends Error {
  public readonly rollbackAttempted: boolean;
  public readonly rolledBack: boolean;
  public readonly originalError: unknown;
  /**
   * Canonical GitOps deploy operation id of the failed deploy, stamped by
   * ComposeService's deploy catch before this error is rethrown. Mutable
   * because the id is only known at the failure site, after construction.
   * Absent when the deploy was untracked (no GitOps operation opened).
   */
  public gitopsDeployOperationId?: string;

  constructor(originalError: unknown, rollbackAttempted: boolean, rolledBack: boolean) {
    super(getErrorMessage(originalError, 'Compose operation failed'));
    this.name = 'ComposeRollbackError';
    this.rollbackAttempted = rollbackAttempted;
    this.rolledBack = rolledBack;
    this.originalError = originalError;
    Object.setPrototypeOf(this, ComposeRollbackError.prototype);
  }
}

export function getComposeRollbackInfo(error: unknown): { attempted: boolean; rolledBack: boolean } | null {
  if (!(error instanceof ComposeRollbackError)) {
    return null;
  }
  return { attempted: error.rollbackAttempted, rolledBack: error.rolledBack };
}

function isNonFatalCompensationError(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === 'HELD_IMAGE_MISSING' || code === 'RECOVERY_PROBE_FAILED';
}

async function compensateOrSwallow(compensate: () => Promise<boolean>): Promise<boolean> {
  try {
    return await compensate();
  } catch (compError) {
    if (!isNonFatalCompensationError(compError)) throw compError;
    return false;
  }
}

const DEFAULT_COMPOSE_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

/** Public so other services (e.g. recovery claim leases) can size their own timers off the same ceiling without depending on a private module-local. */
export function getComposeCommandTimeoutMs(): number {
  const configured = Number(process.env.SENCHO_COMPOSE_COMMAND_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_COMPOSE_COMMAND_TIMEOUT_MS;
}

// Idle backstop for long-running pull/recreate steps: if the child emits no
// output for this window while still running, the step is treated as stalled
// and terminated, so a hung `docker compose pull` surfaces a fast failure
// instead of spinning until the much longer command timeout above. Conservative
// by default because a working pull can be briefly silent while a large layer
// extracts; operators on slow links or heavy local builds can raise it.
const DEFAULT_COMPOSE_STALL_TIMEOUT_MS = 10 * 60 * 1000;

function getComposeStallTimeoutMs(): number {
  const configured = Number(process.env.SENCHO_COMPOSE_STALL_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_COMPOSE_STALL_TIMEOUT_MS;
}

/**
 * Top-level `volumes.*.driver_opts.device` values from a rendered model.
 *
 * A named volume whose local driver binds a host directory carries its host
 * path here rather than in a service mount, so the pilot mapping check has to
 * read it from the same render. Read only to compare containment against the
 * managed trees; the values are never retained, logged, or quoted, because a
 * device can be interpolated from a decrypted env file.
 */
function volumeDeviceSources(parsed: unknown): string[] {
  const volumes = (parsed as { volumes?: unknown } | null)?.volumes;
  if (!volumes || typeof volumes !== 'object' || Array.isArray(volumes)) return [];
  const devices: string[] = [];
  for (const entry of Object.values(volumes as Record<string, unknown>)) {
    const opts = (entry as { driver_opts?: unknown } | null)?.driver_opts;
    if (!opts || typeof opts !== 'object' || Array.isArray(opts)) continue;
    const device = (opts as Record<string, unknown>).device;
    if (typeof device === 'string' && device !== '') devices.push(device);
  }
  return devices;
}

/**
 * ComposeService - local docker compose CLI execution.
 *
 * In the Distributed API model, remote node compose operations are handled
 * by the remote Sencho instance. This service only executes commands locally.
 */
/**
 * Evidence that a Compose mutation actually ran.
 *
 * Returned rather than inferred from a resolved promise because the recovery
 * path takes its Compose step as a callback: a caller that restores some other
 * way resolves identically, and binding the deployed pointer on that would
 * claim a workload nobody launched.
 */
export type ComposeMutationResult = { mutatedByCompose: true };

/**
 * The GitOps deploy tracking handle beginGitOpsDeploy opens: the generation
 * the deploy records against, the canonical operation id every write of that
 * operation shares (and that a failed deploy stamps on its error), and the
 * two terminal closures. Exported as a type only, so the mutation methods
 * and the stamping tests share one shape instead of mirroring it.
 */
export type GitOpsDeployHandle = {
  generationId: string;
  /**
   * The canonical operation id of the GitOps deploy this call opened. Every
   * write of this operation (start, binding, failure) shares it, and callers
   * that surface their own evidence of the deploy (the apply log line, the
   * GitApplyResult) carry it so the two records can be matched by id.
   */
  gitopsOperationId: string;
  bound: () => void;
  failed: (failureClass: 'pre_mutation' | 'post_mutation') => void;
};

export class ComposeService {
  private baseDir: string;
  private nodeId: number;

  constructor(nodeId?: number) {
    this.nodeId = nodeId ?? NodeRegistry.getInstance().getDefaultNodeId();
    this.baseDir = NodeRegistry.getInstance().getComposeDir(this.nodeId);
  }

  public static getInstance(nodeId?: number): ComposeService {
    return new ComposeService(nodeId);
  }

  /**
   * Build the authored `docker compose` argument list for a stack: the validated
   * multi-file deploy prefix (ordered `-f` files + `-p <stackName>` +
   * `--project-directory`) for a Git source with an applied multi-file spec, then
   * the Sencho Mesh override file last (highest `-f` precedence) when the stack is
   * opted into the mesh, then the action. Single-file / non-git stacks get no file
   * prefix, so docker compose's built-in discovery resolves the root compose.yaml,
   * byte-identical to the pre-multi-file behavior. The user's source files are
   * never mutated. Lifecycle commands (deploy, update, stop/start/restart/down)
   * route through this method, so they share one file prefix plus the mesh override.
   * Image scans (listStackImages) and the Compose Doctor (renderConfig) reuse the
   * same `authoredComposeFileArgs` prefix directly but intentionally omit the mesh
   * override, rendering the user's authored model without mesh injection.
   */
  /** Public wrapper for dual-arg assembly and recovery Compose invocations. */
  public async buildAuthoredComposeArgs(stackName: string, action: string[]): Promise<string[]> {
    return this.authoredComposeArgs(stackName, action);
  }

  public async validateStackForMutation(stackName: string): Promise<void> {
    await this.assertRequiredEnvPresent(stackName);
    await this.assertSafePilotBindMapping(stackName);
  }

  /**
   * Render/validate the exact Compose invocation used by mutating operations
   * (authored files, env pins, and generated Mesh override) before capture.
   */
  public async validateExactComposeInvocation(stackName: string): Promise<void> {
    if (!isValidStackName(stackName)) {
      throw new Error('Invalid stack path');
    }
    const baseResolved = path.resolve(this.baseDir);
    const stackDir = path.resolve(baseResolved, stackName);
    if (!stackDir.startsWith(baseResolved + path.sep)) {
      throw new Error('Invalid stack path');
    }
    const args = await this.authoredComposeArgs(stackName, ['config', '--quiet']);
    await this.execute('docker', args, stackDir, undefined, true);
  }

  private resolveStackDir(stackName: string, ctx?: DeployInvocationContext): string {
    if (ctx?.overlayDir) {
      assertGitOverlaySource(ctx.source);
      if (ctx.overlayBinding) {
        GitOpsDecryptOverlay.getInstance().assertBinding(ctx.overlayDir, ctx.overlayBinding);
      }
      return ctx.overlayDir;
    }
    return path.join(this.baseDir, stackName);
  }

  private async assertSopsOverlayOrRefuse(stackName: string, overlayDir?: string): Promise<void> {
    if (overlayDir) return;
    const required = resolveActiveRequiredRecipients({
      stackName,
      nodeId: this.nodeId,
      basis: 'applied',
    });
    if (required.length > 0) throw new Error(SOPS_DIRECT_MUTATION_MESSAGE);
    await this.assertLiveEnvNotEncrypted(stackName);
  }

  /**
   * Refuse a direct mutation on a git-linked stack when the live `.env`
   * or a configured project env file is still age-encrypted. The caller
   * uses this when the applied generation recorded no required recipients.
   */
  private async assertLiveEnvNotEncrypted(stackName: string): Promise<void> {
    if (!DatabaseService.getInstance().getGitSource(stackName)) return;
    const names = new Set<string>(['.env']);
    for (const file of DatabaseService.getInstance().getStackProjectEnvFiles(this.nodeId, stackName)) {
      if (file && !file.includes('/') && !file.includes('\\') && !file.includes('..')) names.add(file);
    }
    const stackDir = path.resolve(this.baseDir, stackName);
    for (const name of names) {
      const target = path.resolve(stackDir, name);
      if (!target.startsWith(stackDir + path.sep)) continue;
      let content: string;
      try {
        content = await fs.promises.readFile(target, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        console.error(
          '[ComposeService] could not read %s while checking encrypted env:',
          sanitizeForLog(name),
          err instanceof Error ? err.message : String(err),
        );
        throw new Error(`Could not read project env file "${name}" for stack "${stackName}".`);
      }
      if (classifyInputEncryption(content, 'env').encryption === 'sops-age') {
        throw new Error(SOPS_DIRECT_MUTATION_MESSAGE);
      }
    }
  }

  private async authoredComposeArgs(
    stackName: string,
    action: string[],
    stackDirOverride?: string,
    refuseIfUnreadable = false,
  ): Promise<string[]> {
    const args = await this.authoredComposePrefix(stackName, stackDirOverride);
    await this.appendPersistentBindRemap(
      stackName,
      args,
      stackDirOverride,
      refuseIfUnreadable || action.includes('up') || action.includes('create'),
    );
    args.push(...action);
    return args;
  }

  /**
   * Global-flag prefix for one command: authored `-f` files, the stack's env
   * files, the Mesh override layer, and the project-name pin. No action, and no
   * bind remap: a caller that layers a file of its own (a recovery override)
   * between the two appends both itself, so the remap stays the last layer.
   */
  private async authoredComposePrefix(
    stackName: string,
    stackDirOverride?: string,
  ): Promise<string[]> {
    const args: string[] = ['compose'];
    const filePrefix = authoredComposeFileArgs(stackName, this.nodeId, stackDirOverride);
    args.push(...filePrefix);
    args.push(...await authoredComposeEnvFileArgs(stackName, this.nodeId, stackDirOverride));

    const meshEnabled = DatabaseService.getInstance().isMeshStackEnabled(this.nodeId, stackName);
    let overridePath: string | null = null;
    try {
      overridePath = await MeshService.getInstance().ensureStackOverride(this.nodeId, stackName);
    } catch (err) {
      if (meshEnabled) {
        throw err instanceof Error
          ? err
          : new Error(`Mesh override generation failed: ${String(err)}`);
      }
      console.warn('[ComposeService] mesh override skipped:', sanitizeForLog((err as Error).message));
    }
    if (meshEnabled && !overridePath) {
      throw new Error(
        `Mesh override is required for stack "${stackName}" but could not be generated`,
      );
    }
    if (overridePath) {
      if (filePrefix.length === 0) {
        // Single-file stack: passing any -f disables compose's auto-discovery, so name
        // the base file explicitly, then re-add the user's implicit override (if any) so
        // it is not silently dropped, before layering the mesh override on top.
        const fsSvc = FileSystemService.getInstance(this.nodeId);
        const baseFilename = await fsSvc.getComposeFilename(stackName);
        args.push('-f', baseFilename);
        let userOverride: string | null = null;
        try {
          userOverride = await fsSvc.getOverrideFilename(stackName);
        } catch (err) {
          // Containment-guard rejections (bad stack name / symlink escape) are hard errors:
          // abort the deploy rather than degrade. The "no override" case returns null rather
          // than throwing, so any other throw is transient I/O: drop the override and proceed
          // (logging the consequence) instead of failing the deploy.
          const code = (err as { code?: string }).code;
          if (code === 'INVALID_STACK_NAME' || code === 'INVALID_PATH' || code === 'SYMLINK_ESCAPE') {
            throw err;
          }
          console.warn('[ComposeService] could not resolve user compose override; deploying without it:', sanitizeForLog((err as Error).message));
        }
        if (userOverride) {
          args.push('-f', userOverride);
        }
      }
      args.push('-f', overridePath);
    }
    this.pinProjectNameForOverride(stackName, args, stackDirOverride);
    return args;
  }

  /**
   * Ordinary relative data binds must keep the live stack as their host path
   * when Compose's working directory is a decrypt overlay. Secret files that
   * were decrypted into the overlay stay there. The rewrite is a compose layer
   * inside the overlay, so cleanup removes it with the decrypted copies.
   */
  private async appendPersistentBindRemap(
    stackName: string,
    args: string[],
    stackDirOverride?: string,
    refuseIfUnreadable = false,
  ): Promise<void> {
    const overlayDir = this.remapOverlayDir(stackDirOverride);
    if (!overlayDir) return;
    await this.pinComposeFilesForRemap(stackName, args);
    const plan = await planPersistentBindRemap({
      overlayDir,
      liveRoot: this.resolveValidatedStackDir(stackName),
      liveComposeRoot: path.resolve(this.baseDir),
      secretsRoot: path.resolve(gitSecretsAreaBase()),
      composeArgs: args,
      refuseIfUnreadable,
    });
    if (plan.action === 'skip') return;
    if (plan.action === 'refuse') throw new Error(plan.reason);
    if (!args.includes('-f') && !args.includes('--file')) throw new Error(PERSISTENT_BIND_UNSAFE);
    args.push('-f', plan.file);
  }

  /**
   * The GitOps decrypt overlay a command runs in, or null when it does not run
   * in one. Which layers an argv carries is not part of the question: the
   * generated remap layer is appended once per assembly, by the callers below,
   * so nothing here has to recognize it back out of a token (see
   * `planPersistentBindRemap` for the one collision this could otherwise hide).
   */
  private remapOverlayDir(stackDirOverride: string | undefined): string | null {
    if (!stackDirOverride) return null;
    const overlayDir = path.resolve(stackDirOverride);
    const secretsRoot = path.resolve(gitSecretsAreaBase());
    if (!overlayDir.startsWith(secretsRoot + path.sep) || !fs.existsSync(overlayDir)) return null;
    return overlayDir;
  }

  /** Name the base compose file before adding another `-f`, which disables discovery. */
  private async pinComposeFilesForRemap(stackName: string, args: string[]): Promise<void> {
    if (args.includes('-f') || args.includes('--file')) return;
    // Canonical js/path-injection barrier at the existsSync sink.
    const baseResolved = path.resolve(this.baseDir);
    const liveRoot = path.resolve(baseResolved, stackName);
    if (!liveRoot.startsWith(baseResolved + path.sep)) {
      throw new Error('Invalid stack path');
    }
    if (!fs.existsSync(liveRoot)) return;
    try {
      await this.ensureExplicitComposeFiles(stackName, args, true);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'INVALID_STACK_NAME' || code === 'INVALID_PATH' || code === 'SYMLINK_ESCAPE') throw err;
      if (err instanceof Error && err.message.startsWith('No compose file found')) return;
      throw err;
    }
  }

  /**
   * Layer a digest-pin overlay onto authored compose args and append `--pull never`.
   * Authored files on disk are unchanged. The overlay is written into an exclusive
   * mkdtemp directory under os.tmpdir() so the path is neither stack-tainted nor
   * a shared-temp TOCTOU race.
   */
  private async withDigestPinOverlay(
    stackName: string,
    action: string[],
    stackDirOverride: string | undefined,
    digestPins: DigestPinsMap,
  ): Promise<{ args: string[]; overlayDir: string }> {
    const overlayDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), DIGEST_PIN_TEMP_PREFIX));
    const overlayPath = path.join(overlayDir, 'overlay.yml');
    try {
      await fs.promises.writeFile(overlayPath, digestPinsOverlayYaml(digestPins), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      const args = await this.authoredComposeArgs(stackName, [], stackDirOverride, true);
      await this.ensureExplicitComposeFiles(stackName, args, true);
      args.push('-f', overlayPath, ...action, '--pull', 'never');
      return { args, overlayDir };
    } catch (err) {
      await fs.promises.rm(overlayDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  private execute(
    command: string,
    args: string[],
    cwd: string,
    ws?: WebSocket,
    throwOnError = true,
    env?: Record<string, string | undefined>,
    // When set, terminate the child if it emits no output for this long while
    // still running (idle stall backstop). Appended last so the existing
    // registry-auth call sites that pass `env` are unaffected.
    idleTimeoutMs?: number,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const deliveryAbortSignal = getRegistryDeliveryContext()?.abortSignal;
    const effectiveAbortSignal = abortSignal ?? deliveryAbortSignal;
    // Read once, at the top of the run: a decrypted operation must not leak
    // the subprocess output that reaches the progress stream or the rejection,
    // and the decision has to be stable for the life of the child.
    const withholdOutput = decryptedComposeOutputWithheld();

    if (effectiveAbortSignal?.aborted) {
      return Promise.reject(new Error('OPERATION_ABORTED: client disconnected'));
    }

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: env ?? {
          ...process.env,
          PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
        }
      });

      let errorLog = '';
      let settled = false;
      let exited = false;
      let pendingTerminationError: Error | null = null;
      const timeoutMs = getComposeCommandTimeoutMs();
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let forceKillTimeout: ReturnType<typeof setTimeout> | null = null;
      let idleTimeout: ReturnType<typeof setTimeout> | null = null;
      let withheldNoticeSent = false;

      const sendOutput = (text: string) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(text);
        }
      };

      /** One notice in place of a withheld stream, so silence reads as policy. */
      const sendWithheldNotice = () => {
        if (withheldNoticeSent) return;
        withheldNoticeSent = true;
        sendOutput(WITHHELD_DECRYPTED_COMPOSE_STREAM);
      };

      const terminateChild = (error: Error) => {
        pendingTerminationError = pendingTerminationError ?? error;
        if (exited) return;
        try {
          child.kill('SIGTERM');
        } catch (error) {
          console.warn('[ComposeService] Failed to terminate compose command:', sanitizeForLog(getErrorMessage(error, 'unknown')));
        }
        forceKillTimeout = setTimeout(() => {
          if (exited) return;
          try {
            child.kill('SIGKILL');
          } catch (error) {
            console.warn('[ComposeService] Failed to force terminate compose command:', sanitizeForLog(getErrorMessage(error, 'unknown')));
          }
        }, 5000);
      };

      const onAbort = effectiveAbortSignal
        ? () => {
            sendOutput('=== Operation cancelled (client disconnected) ===\n');
            terminateChild(new Error('OPERATION_ABORTED: client disconnected'));
          }
        : undefined;

      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        if (forceKillTimeout) {
          clearTimeout(forceKillTimeout);
          forceKillTimeout = null;
        }
        if (idleTimeout) {
          clearTimeout(idleTimeout);
          idleTimeout = null;
        }
        if (effectiveAbortSignal && onAbort) {
          effectiveAbortSignal.removeEventListener('abort', onAbort);
        }
      };

      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        complete();
      };

      // Idle stall backstop. Armed once below and reset on every output chunk;
      // if it ever fires, the step has been silent for idleTimeoutMs while still
      // running, so terminate it. Never rearmed after a termination is pending or
      // the child has exited, so it cannot re-fire during the SIGTERM grace.
      const armIdleTimeout = () => {
        if (idleTimeoutMs === undefined) return;
        if (exited || settled || pendingTerminationError) return;
        if (idleTimeout) clearTimeout(idleTimeout);
        idleTimeout = setTimeout(() => {
          const seconds = Math.round(idleTimeoutMs / 1000);
          sendOutput(`=== No output for ${seconds}s; the operation appears stalled and was stopped ===\n`);
          terminateChild(new Error(`STACK_STALLED_OUTPUT: no output for ${seconds}s`));
        }, idleTimeoutMs);
      };

      // The progress socket is output-only: a deploy/update/down is owned by the
      // HTTP request that started it, so closing or losing the socket (the user
      // minimizes the panel, navigates away, or the connection blips) must not
      // terminate the compose process. Termination is driven solely by the
      // command timeout here and the optional idle stall backstop above.
      timeout = setTimeout(() => {
        const message = `Command timed out after ${Math.round(timeoutMs / 1000)}s`;
        sendOutput(`${message}\n`);
        terminateChild(new Error(message));
      }, timeoutMs);

      armIdleTimeout();

      if (effectiveAbortSignal && onAbort) {
        effectiveAbortSignal.addEventListener('abort', onAbort);
      }

      const onData = (data: Buffer) => {
        const text = data.toString();
        if (withholdOutput) {
          // Compose echoes interpolated values back, so the chunk is dropped
          // rather than filtered; the stall backstop still counts it as output.
          sendWithheldNotice();
        } else {
          errorLog += text;
          sendOutput(text);
        }
        armIdleTimeout();
      };

      child.stdout.on('data', onData);
      child.stderr.on('data', onData);

      child.on('close', (code: number | null) => {
        exited = true;
        finish(() => {
          sendOutput(`Command exited with code ${code}\n`);
          if (pendingTerminationError) {
            if (throwOnError) reject(pendingTerminationError);
            else resolve();
            return;
          }
          if (code === 0) resolve();
          else if (throwOnError) reject(new Error(
            withholdOutput
              ? WITHHELD_DECRYPTED_COMPOSE_OUTPUT
              : redactSensitiveText(errorLog.trim()) || `Command failed with code ${code}`,
          ));
          else resolve();
        });
      });

      child.on('error', (error: Error & { code?: string }) => {
        exited = true;
        finish(() => {
          const mapped = describeSpawnError(error as NodeJS.ErrnoException, { command });
          const message = redactSensitiveText(mapped.message);
          sendOutput(`Error: ${message}\n`);
          if (mapped.isLowMemory) {
            console.warn('[ComposeService] spawn failed under memory pressure:', message);
          }
          if (pendingTerminationError) {
            if (throwOnError) reject(pendingTerminationError);
            else resolve();
            return;
          }
          if (throwOnError) reject(new Error(message));
          else resolve();
        });
      });
    });
  }

  private async withRegistryAuth<T>(
    fn: (env: Record<string, string | undefined>) => Promise<T>,
    sendOutput?: (data: string) => void,
  ): Promise<T> {
    const deliveryContext = getRegistryDeliveryContext();

    const mergedAuths: Record<string, { auth: string }> = {};

    if (deliveryContext) {
      if (!deliveryContext.seamResult) {
        deliveryContext.seamResult = await resolveRegistryAuthAtSeam({
          envelope: deliveryContext.envelope,
          nodeId: deliveryContext.nodeId,
          stack: deliveryContext.stack,
          stage: deliveryContext.stage,
          service: deliveryContext.service,
        });
        deliveryContext.seamSettled = true;
      }
      Object.assign(mergedAuths, deliveryContext.seamResult.auths);
    } else {
      const registries = DatabaseService.getInstance().getRegistries();
      if (registries.length > 0) {
        const { config, warnings } = await RegistryService.getInstance().resolveDockerConfig();
        if (warnings.length > 0 && sendOutput) {
          for (const warning of warnings) {
            sendOutput(`[Sencho] Warning: ${warning}\n`);
          }
        }
        Object.assign(mergedAuths, config.auths);
      }
    }

    if (Object.keys(mergedAuths).length === 0) {
      return fn({
        ...process.env,
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      });
    }

    const deliverySourceId = RegistryDeliveryService.getInstance().getDeliverySourceId();
    const handle = createDockerAuthTempDir(
      deliverySourceId,
      deliveryContext ? 'delivered' : 'local',
      { auths: mergedAuths },
    );

    try {
      return await fn({
        ...process.env,
        DOCKER_CONFIG: handle.dirPath,
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      });
    } finally {
      try {
        handle.cleanup();
      } catch (cleanupErr) {
        const cleanupMessage = getErrorMessage(cleanupErr, 'unknown error');
        if (deliveryContext) {
          try {
            recordRegistryDeliveryEvent({
              deliverySourceId,
              eventType: 'cleanup_failed',
              tempDirId: path.basename(handle.dirPath),
              stack: deliveryContext.stack ?? null,
              op: deliveryContext.stage ?? null,
            });
            console.error(
              'Registry delivery temp dir cleanup failed for %s:',
              sanitizeForLog(deliverySourceId),
              cleanupMessage,
            );
          } catch (evidenceErr) {
            console.error(
              'Registry delivery cleanup and evidence both failed for %s:',
              sanitizeForLog(deliverySourceId),
              getErrorMessage(evidenceErr, 'unknown error'),
              cleanupMessage,
            );
          }
        } else {
          console.error(
            'Registry delivery temp dir cleanup failed for %s:',
            sanitizeForLog(deliverySourceId),
            cleanupMessage,
          );
        }
      }
      const prepId = deliveryContext?.seamResult?.prepId ?? deliveryContext?.envelope.prepId;
      if (prepId) {
        try {
          PreparedSourceStore.getInstance().finalize(prepId);
        } catch (finalizeErr) {
          console.error(
            'Registry delivery prepared-source finalize failed for %s:',
            sanitizeForLog(prepId),
            getErrorMessage(finalizeErr, 'unknown error'),
          );
        }
      }
    }
  }

  private async createAtomicBackup(
    stackName: string,
    operation: 'deployment' | 'update',
    sendOutput: (data: string) => void,
  ): Promise<void> {
    try {
      const fsSvc = FileSystemService.getInstance(this.nodeId);
      await fsSvc.backupStackFiles(stackName);
      sendOutput(`=== Backup created for atomic ${operation} ===\n`);
    } catch (error) {
      console.error('Atomic backup failed for %s:', sanitizeForLog(stackName), getErrorMessage(error, 'unknown error'));
      sendOutput(`=== Atomic ${operation} backup failed. Operation aborted ===\n`);
      throw new Error(`Atomic ${operation} backup failed: ${getErrorMessage(error, 'unknown error')}`);
    }
  }

  private async restoreAtomicBackup(
    stackName: string,
    stackDir: string,
    ws: WebSocket | undefined,
    sendOutput: (data: string) => void,
  ): Promise<boolean> {
    try {
      const fsSvc = FileSystemService.getInstance(this.nodeId);
      await fsSvc.restoreStackFiles(stackName);
      await this.withRegistryAuth(async (env) => {
        await this.execute('docker', await this.authoredComposeArgs(stackName, ['up', '-d', '--remove-orphans']), stackDir, ws, true, env);
      }, sendOutput);
      sendOutput('=== Restored previous compose and env files ===\n');
      return true;
    } catch (rollbackError) {
      console.error('Rollback failed for %s:', sanitizeForLog(stackName), getErrorMessage(rollbackError, 'unknown error'));
      sendOutput('=== Rollback failed. Manual intervention may be required ===\n');
      return false;
    }
  }

  private createContainerCrashError(exitCode: number): Error {
    return new Error(
      `CONTAINER_CRASHED\nExit Code: ${exitCode}\nContainer exited after deployment. Check container logs for details.`
    );
  }

  async runCommand(stackName: string, action: 'down' | 'start' | 'stop' | 'restart', ws?: WebSocket): Promise<void> {
    const stackDir = path.join(this.baseDir, stackName);
    // Resolve the arguments first: a stack whose compose cannot be resolved is
    // refused before anything is touched, and must not cost a live gate.
    const args = await this.authoredComposeArgs(stackName, [action]);
    // Before the command, not after: compose stops containers one at a time
    // against a 10s Docker stop timeout, and a gate poll landing in that window
    // would record the deliberate stop as a failed update. `start` is excluded
    // because it does not disturb the containers a gate is observing.
    if (action !== 'start') {
      await this.supersedeGatesForContainerOp(
        stackName,
        `the stack was ${action === 'down' ? 'taken down' : action === 'stop' ? 'stopped' : 'restarted'} during the observation`,
      );
    }
    await this.execute('docker', args, stackDir, ws);
  }

  /** Interactive compose down (Take down UI / POST /down). Plain `down` by default. */
  async runDown(stackName: string, options?: { removeVolumes?: boolean }, ws?: WebSocket): Promise<void> {
    const stackDir = path.join(this.baseDir, stackName);
    const args = options?.removeVolumes ? ['down', '--volumes'] : ['down'];
    const composeArgs = await this.authoredComposeArgs(stackName, args);
    await this.supersedeGatesForContainerOp(stackName, 'the stack was taken down during the observation');
    await this.execute('docker', composeArgs, stackDir, ws);
  }

  /**
   * End the gates that a compose run is about to invalidate, immediately before
   * the compose command starts, so no gate poll can read the replaced containers
   * first and report the operation as a failed update. Covers both a deliberate
   * container action (the run commands and the take-downs below) and a
   * stack-scoped deploy or update: from a gate's point of view those are the same
   * event, the runtime it observes is about to be replaced. Awaited dynamic
   * import: HealthGateService imports this module, so a static import would be a
   * cycle.
   *
   * Every caller resolves its compose arguments, and a deploy resolves its
   * registry auth, before getting here, so a run refused at that stage costs no
   * live gate. Ending a gate that the compose run then fails to perform is the
   * honest direction: the verdict is `unknown` with the attempted operation
   * named, never a failure. Callers that open a replacement gate supersede the
   * same gates again a moment later, so this is a harmless no-op for them.
   */
  private async supersedeGatesForContainerOp(stackName: string, reason: string): Promise<void> {
    try {
      const { HealthGateService } = await import('./HealthGateService');
      HealthGateService.getInstance().supersedeForContainerOp(this.nodeId, stackName, reason);
    } catch (error) {
      console.error(
        '[ComposeService] Failed to end health gate observations for %s:',
        sanitizeForLog(stackName),
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * How the missing-variable refusal names the blocked action and the next step.
   *
   * The default is the deploy wording, kept byte-identical because it is quoted
   * verbatim in a published tutorial and its screenshots. An operation that is not
   * a deploy passes its own remedy, and omits `blocked` when the caller already
   * names the action: the editor's pull path surfaces this text behind its own
   * "Image pull failed:" prefix, and a second "Image pull blocked:" in front of it
   * reads as a stutter rather than a clearer message.
   */
  private static readonly ENV_REFUSAL_WORDING = {
    blocked: 'Deploy blocked:',
    remedy: 'then deploy again.',
  } as const;

  /**
   * Ceiling on the decrypt-overlay required-variable check, matching
   * `renderConfig`'s. It only reads an exit code, so the bound matters: without
   * one, a Compose that never returns would hold the deploy open forever with
   * no diagnostic to explain the wait.
   */
  private static readonly REQUIRED_ENV_CHECK_TIMEOUT_MS = 20_000;

  /**
   * Guard (on by default): when `env_block_deploy_on_missing_required` is enabled, refuse a
   * compose operation whose required `${VAR:?err}` variables are unset OR empty,
   * before any backup, cleanup, pull, or `up` runs. Compose's own resolution is
   * authoritative (it passes process.env). A settings-read failure falls
   * through without blocking.
   *
   * Two confidentiality regimes, split by the input. The live project is
   * readable by whoever can read the stack directory, so its diagnostic is
   * parsed and the refusal names the variables. A GitOps decrypt overlay holds
   * plaintext secrets, so its diagnostic is never read at all; see the overlay
   * branch for why a name-only parse is not a boundary there.
   */
  private async assertRequiredEnvPresent(
    stackName: string,
    stackDirOverride?: string,
    wording: { blocked?: string; remedy: string } = ComposeService.ENV_REFUSAL_WORDING,
  ): Promise<void> {
    let enabled = false;
    try {
      enabled = DatabaseService.getInstance().getGlobalSettings()['env_block_deploy_on_missing_required'] === '1';
    } catch {
      return; // safe default: a settings-read failure never blocks a deploy
    }
    if (!enabled) return;
    const lead = wording.blocked ? `${wording.blocked} ` : '';
    if (stackDirOverride) {
      // Withheld for the same reason renderConfig withholds it for this input:
      // Compose quotes whatever it resolved back into its diagnostic, and a
      // `:?` message is itself interpolated, so a decrypted value can land
      // inside it. Nothing here collects output at all, so nothing here can
      // leak it.
      let code: number | null;
      try {
        const args = await this.authoredComposeArgs(stackName, ['config', '--quiet'], stackDirOverride);
        code = await new Promise<number | null>((resolve, reject) => {
          // Both streams to /dev/null: no pipe to fill, and no collected text
          // that could later be mistaken for something safe to publish.
          const child = spawn('docker', args, {
            cwd: stackDirOverride,
            stdio: 'ignore',
            env: {
              ...process.env,
              PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            },
          });
          // The exit code is the only signal this check gets, so a wedged
          // Compose is bounded here rather than left to hang the deploy.
          const timer = setTimeout(() => child.kill('SIGKILL'), ComposeService.REQUIRED_ENV_CHECK_TIMEOUT_MS);
          child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
          });
          child.on('close', (code) => {
            clearTimeout(timer);
            resolve(code);
          });
        });
      } catch (err) {
        if (err instanceof Error && (
          err.message === PERSISTENT_BIND_REFUSAL || err.message === PERSISTENT_BIND_UNSAFE
        )) {
          throw err;
        }
        return; // a launch failure is not a missing variable
      }
      // A render that resolved reports no required-variable error at all, so
      // the exit code is the whole signal here. Anything else, including a
      // child killed on timeout (which closes with no code at all), is refused
      // without a name: the guard cannot tell a missing variable from any
      // other render fault without reading the diagnostic it must not read,
      // so it fails closed the way the network gate already does.
      if (code === 0) return;
      throw new Error(`${lead}${WITHHELD_DECRYPTED_REQUIRED_ENV_OUTPUT}${wording.remedy}`);
    }
    const result = await this.renderConfig(stackName);
    const missing = parseMissingRequiredVars(result.stderr);
    if (missing.length === 0) return;
    const plural = missing.length > 1;
    throw new Error(
      `${lead}required environment variable${plural ? 's' : ''} ${missing.join(', ')} ` +
      `${plural ? 'are' : 'is'} missing. Define ${plural ? 'them' : 'it'} in a .env or env_file, ${wording.remedy}`,
    );
  }

  /**
   * Pilot host-path guard. The question it answers is whether any host path
   * resolves into a directory Sencho manages for the stack, given that the host
   * path for that directory is somewhere else: the live stack directory is what
   * the Pilot Agent maps, so a relative bind, or the host directory a named
   * volume's local driver binds, lands on a host path Sencho did not choose.
   *
   * `overlayDir` is the GitOps decrypt overlay a Git deploy runs Compose in. The
   * live project cannot answer the question for such a deploy when a typed value
   * (a published port, an external network name) is held in an encrypted env
   * file, because the live render fails on the ciphertext. Reading the overlay is
   * therefore not a way around the check, it is how the check still runs; see
   * `renderPilotBinds` for why the overlay is the render that speaks for a deploy.
   *
   * `composeArgsPrefix` is for a command whose invocation was rebuilt rather than
   * derived from live state (a rollback from a captured generation). The caller
   * hands over the exact prefix it is about to execute, so the model this guard
   * reads is the one that command would run: same files, env selection, recovery
   * layer, and working directory.
   */
  private async assertSafePilotBindMapping(
    stackName: string,
    overlayDir?: string,
    composeArgsPrefix?: string[],
  ): Promise<void> {
    if (process.env.SENCHO_MODE !== 'pilot') return;

    let mounts: Array<{ source: string; destination: string }> | null;
    try {
      mounts = await SelfIdentityService.getInstance().getBindMounts();
    } catch (error) {
      console.warn('[ComposeService] Could not verify pilot compose path mapping:', sanitizeForLog(getErrorMessage(error, 'unknown')));
      return;
    }
    if (mounts === null) return;

    const composeDir = path.resolve(this.baseDir);
    const hostComposeDir = resolveHostBindPath(composeDir, mounts);
    if (!hostComposeDir || pathsMatch(hostComposeDir, composeDir)) return;

    const analysis = await this.renderPilotBinds(stackName, overlayDir, composeArgsPrefix);
    if (!analysis) return;

    const unsafeBind = analysis.model.services
      .flatMap((service) => service.binds)
      .find((bind) => analysis.bases.some((base) => isPathWithinBase(path.resolve(bind.source), base)));
    // Only an absolute device is a host path; a remote export (`:/export`,
    // `//server/share`) is not, and must not be resolved against the process
    // working directory to decide whether it lands in a managed tree.
    const unsafeDevice = analysis.deviceSources
      .filter((device) => path.isAbsolute(device))
      .find((device) => analysis.bases.some((base) => isPathWithinBase(device, base)));
    if (!unsafeBind && !unsafeDevice) return;

    throw new Error(
      `Deploy blocked: a mount resolves into a directory Sencho manages on this node. ` +
      `The host maps ${composeDir} to ${hostComposeDir}, so the data would land at a path this stack was not configured for. ` +
      `Use a 1:1 mount with the same absolute path on the host and in the Pilot Agent, then retry.`,
    );
  }

  /**
   * The rendered binds for the pilot check, with the trees a bind must stay out
   * of.
   *
   * The render has to describe the project Compose will actually run, and for a
   * Git deploy that is the overlay, so the overlay is the only render that speaks
   * for it. Reading the live project instead inspects a model the deploy does not
   * use, and a bind can resolve differently once the values in front of it are
   * decrypted. An interpolated source is the clearest case: ciphertext that
   * Compose accepts as a relative path resolves under the live stack directory,
   * while the decrypted value beside it can name an absolute external path the
   * deploy is entitled to use.
   *
   * An overlay adds a second tree to stay out of, it does not replace the first.
   * Ordinary relative data binds are rewritten onto the live stack before this
   * render, so they show up inside the compose tree. A decrypted secret file
   * that is itself mounted stays under the overlay, and the tree to compare
   * that against sits one level above the overlay directory, the same depth
   * `this.baseDir` sits above a live stack. Comparing against the overlay
   * directory itself would let `../data` through when the rewrite did not move
   * it. The compose tree stays in the set as well, because a bind can also name
   * it outright, and that is the tree the Pilot Agent maps.
   *
   * A named volume whose local driver binds a host directory is read from the
   * same render: its path is a `driver_opts.device`, not a service mount, and a
   * relative device is rewritten onto the live stack exactly as a relative bind
   * is. Leaving that form out would let a rewritten device reach the host as
   * the container path this check exists to refuse.
   *
   * The set has the same reach the live arm has always had, no more: one level of
   * `..` from the project directory is inside it and two is not, and a service
   * bind is read from a `type: bind` mount only. Widening either is a separate
   * change.
   * The overlay tree is taken from the directory the render ran in rather than
   * rebuilt from the stack identity, so it can never fail to contain the project
   * Compose just resolved against, whatever shape the overlay layout takes.
   *
   * `null` when the render could not be read, which leaves the guard without a
   * decision, exactly as an unreadable render always has.
   */
  private async renderPilotBinds(
    stackName: string,
    overlayDir?: string,
    composeArgsPrefix?: string[],
  ): Promise<{ model: EffectiveModel; bases: string[]; deviceSources: string[] } | null> {
    let rendered: Awaited<ReturnType<ComposeService['renderConfig']>>;
    if (composeArgsPrefix) {
      // A rebuilt invocation is the project this command runs, so the render
      // reuses its exact global flags instead of deriving a second one.
      rendered = await this.renderConfig(stackName, { stackDirOverride: overlayDir, composePrefix: composeArgsPrefix });
    } else if (overlayDir) {
      rendered = await this.renderConfig(stackName, { stackDirOverride: overlayDir });
    } else {
      rendered = await this.renderConfig(stackName);
    }
    if (rendered.rendered === null) return null;

    const parsed = this.parsePilotBinds(rendered.rendered, stackName);
    if (!parsed) return null;

    const composeDir = path.resolve(this.baseDir);
    return {
      model: parsed.model,
      bases: overlayDir ? [path.dirname(path.resolve(overlayDir)), composeDir] : [composeDir],
      deviceSources: parsed.deviceSources,
    };
  }

  /**
   * Parse one rendered model for the pilot check. Only the bind sources and the
   * named-volume devices are read, and neither this nor the refusal quotes one:
   * an overlay's source can be an interpolated value, and the operator is told
   * which two paths disagree, not what a bind said.
   */
  private parsePilotBinds(
    rendered: string,
    stackName: string,
  ): { model: EffectiveModel; deviceSources: string[] } | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rendered);
    } catch {
      // A parse error quotes the text around the fault, and an overlay render can
      // carry a decrypted value, so the log names the fault without Compose's own
      // words on either arm. The render is JSON by construction, so this is only
      // reachable through corrupt output.
      console.warn('[ComposeService] Could not inspect rendered binds for pilot path safety: the render was not JSON.');
      return null;
    }
    return { model: parseEffectiveModel(parsed, stackName), deviceSources: volumeDeviceSources(parsed) };
  }

  /**
   * Missing-external gate: after env/Pilot asserts, before atomic backup.
   * Creates safe bridge networks only when the opt-in setting is on.
   *
   * A Git deploy runs Compose out of a decrypt overlay, so the gate renders
   * that same overlay. Reading the live project instead resolves a published
   * port or an external network name out of ciphertext, refuses the deploy
   * before `up`, and leaves the applied generation and the running one
   * describing different models.
   *
   * Overlay parity covers the node, project identity, authored files, and env
   * inputs. It does not cover the layers only `up` adds: the generated mesh
   * override (which `renderConfig` omits by design, so it cannot report the
   * managed `sencho_mesh` network as missing) and an ephemeral digest-pin
   * overlay (which changes image digests, not network declarations).
   */
  private async ensureExternalNetworksForDeploy(
    stackName: string,
    ctx?: DeployInvocationContext,
  ): Promise<void> {
    const renderCtx = { stackDirOverride: ctx?.overlayDir };
    const resolved = await resolveMissingExternalNetworks(this.nodeId, stackName, renderCtx);
    if (resolved.status === 'render_unavailable') {
      // The resolver already reduced the render failure to a specific,
      // redacted cause. Surface it rather than a generic sentence that names
      // none of the possible faults, so the operator learns what to fix.
      throw new MissingExternalNetworksError({
        kind: 'unavailable',
        message: resolved.renderError
          || 'Sencho could not render this stack\'s Compose model to check external networks.',
      });
    }
    if (resolved.status === 'runtime_unavailable') {
      // No declared externals: nothing to verify; proceed.
      if (resolved.declaredExternalCount === 0) return;
      throw new MissingExternalNetworksError({
        kind: 'unavailable',
        message: 'Sencho could not read Docker networking state to check external networks.',
      });
    }

    if (resolved.networks.length === 0) return;

    const unsafe = resolved.networks.filter((n) => !n.safe);
    if (unsafe.length > 0) {
      throw new MissingExternalNetworksError({
        kind: 'unsupported',
        message: 'One or more missing external networks cannot be created safely by Sencho.',
        networks: resolved.networks,
      });
    }

    if (!resolved.autoCreateEnabled) {
      throw new MissingExternalNetworksError({
        kind: 'prompt',
        message: 'One or more external networks required by this stack are missing on this node.',
        networks: resolved.networks,
      });
    }

    const docker = DockerController.getInstance(this.nodeId);
    const createdNames: string[] = [];
    const recordCreatedNetworks = (level: 'info' | 'warning') => {
      if (createdNames.length === 0) return;
      invalidateNodeCaches(this.nodeId);
      recordNetworkAutoCreatedActivity(this.nodeId, stackName, createdNames, level, ctx);
    };

    for (const network of resolved.networks) {
      try {
        await docker.createNetwork({ Name: network.name, Driver: 'bridge' });
        createdNames.push(network.name);
      } catch (createErr) {
        // Authoritative re-check: continue only if the network now exists.
        let exists = false;
        try {
          const knownStacks = await FileSystemService.getInstance(this.nodeId).getStacks();
          const snapshot = await docker.getDependencySnapshot(knownStacks);
          exists = snapshot.networks.some((n) => n.name === network.name);
        } catch (snapErr) {
          console.warn(
            '[ComposeService] Post-create snapshot failed for %s:',
            sanitizeForLog(network.name),
            sanitizeForLog(getErrorMessage(snapErr, 'unknown')),
          );
        }
        if (!exists) {
          recordCreatedNetworks('warning');
          throw new MissingExternalNetworksError({
            kind: 'create_failed',
            message: `Failed to create external network "${network.name}".`,
            networks: resolved.networks,
            createdNames,
            remainingNames: resolved.networks
              .map((missingNetwork) => missingNetwork.name)
              .filter((name) => !createdNames.includes(name)),
          });
        }
        // Race-existing: do not record in createdNames.
      }
    }

    // Re-resolve before Compose, out of the same project the first pass read.
    const recheck = await resolveMissingExternalNetworks(this.nodeId, stackName, renderCtx);
    if (recheck.status !== 'ok' || recheck.networks.length > 0) {
      recordCreatedNetworks('warning');
      throw new MissingExternalNetworksError({
        kind: recheck.status === 'ok' ? 'create_failed' : 'unavailable',
        message: 'External networks were still missing after automatic creation.',
        networks: recheck.networks,
        createdNames,
        remainingNames: recheck.networks.map((n) => n.name),
      });
    }

    recordCreatedNetworks('info');
  }

  /**
   * Open a GitOps deploy operation for this stack, or nothing when there is no
   * generation to bind.
   *
   * Returns closures rather than ids so the caller cannot terminate an
   * operation it never started. A stack with no live application, or one whose
   * target has nothing applied, has no deploy identity to record, so the whole
   * thing is a no-op. Recording never fails the deploy: the store describes
   * what happened, it does not make it happen.
   *
   * `deployOperationId` lets a caller with durable prior intent (Git
   * dispatch's `deploy_dispatched` record; a dispatch whose intent could
   * not be recorded never calls this) open this deploy's transitions under
   * an id it already knows, so recovery of an interrupted attempt can find
   * this deploy's rows by exact id rather than guessing which deploy ran
   * under it. Ordinary callers omit it and get a freshly minted id,
   * unchanged behavior.
   */
  private beginGitOpsDeploy(stackName: string, deployOperationId?: string): GitOpsDeployHandle | null {
    try {
      const app = GitOpsStore.getInstance().getLiveDirectApplication(stackName);
      if (!app || app.lifecycle_status !== 'active') return null;
      const target = GitOpsStore.getInstance().getTarget(app.id, this.nodeId);
      const generationId = target?.applied_generation_id;
      if (!target || target.target_status !== 'active' || !generationId) return null;

      const tx = GitOpsTransitions.getInstance();
      const envelope = {
        operationId: deployOperationId ?? randomUUID(),
        actor: 'system:compose',
        trigger: 'deploy',
        at: Date.now(),
      };
      const record = (what: string, write: () => void): boolean => {
        try {
          write();
          return true;
        } catch (error) {
          console.error(
            '[GitOps] Could not record deploy %s for %s (application %s, generation %s):',
            what,
            sanitizeForLog(stackName),
            app.id,
            generationId,
            error instanceof Error ? error.stack ?? error.message : String(error),
          );
          return false;
        }
      };
      if (!record('start', () => tx.deployStarted(app.id, this.nodeId, generationId, envelope))) {
        return null;
      }
      return {
        generationId,
        gitopsOperationId: envelope.operationId,
        bound: () => record('binding', () => tx.deployBound(app.id, this.nodeId, generationId, envelope)),
        failed: (failureClass) => record('failure', () => tx.deployFailed(app.id, this.nodeId, failureClass, envelope)),
      };
    } catch (error) {
      console.error(
        '[GitOps] Could not open a deploy operation for %s:',
        sanitizeForLog(stackName),
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  /**
   * Name the GitOps deploy operation a failed deploy belongs to on the
   * error that leaves the mutation method, so a caller settling its own
   * durable evidence (Git dispatch's reconcile attempt) can correlate the
   * failure to the exact deploy record instead of guessing by timestamp.
   * Guarded because `catch` holds `unknown`: a thrown primitive would
   * make the property assignment itself throw, replacing the original
   * deploy failure inside its own catch block. An untracked deploy (no
   * handle) never calls this, which the caller reads as "no id exists".
   */
  private stampGitOpsDeployId(err: unknown, gitopsOperationId: string): void {
    if (typeof err === 'object' && err !== null) {
      (err as { gitopsDeployOperationId?: string }).gitopsDeployOperationId = gitopsOperationId;
    }
  }

  /**
   * Retire the stack's per-service recovery snapshots after a successful
   * stack-scoped deploy or update replaced its runtime. Those snapshots point at
   * images the stack is no longer running, so offering one would be a rollback
   * behind the deploy the operator just ran.
   *
   * Deliberately after the compose up and only on success: a run that failed
   * before handing off left the previous workload provably intact, and its
   * snapshots still describe what is running.
   *
   * Best effort by design: the deploy already succeeded and its own evidence is
   * recorded, so failing it over an offer the operator can decline would be the
   * worse outcome. Dynamic import for the same reason as above: this module and
   * the recovery services form an import cycle.
   */
  private async retireStaleServiceRecoveries(stackName: string): Promise<void> {
    try {
      const { ServiceUpdateRecoveryService } = await import('./ServiceUpdateRecoveryService');
      ServiceUpdateRecoveryService.getInstance().invalidateActiveForStack(this.nodeId, stackName);
    } catch (error) {
      console.error(
        '[ComposeService] Failed to retire stale service recovery records for %s:',
        sanitizeForLog(stackName),
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async deployStack(
    stackName: string,
    ws?: WebSocket,
    atomic?: boolean,
    ctx?: DeployInvocationContext,
  ): Promise<{ recoveryId: string | null; deployedGenerationId: string | null; gitopsOperationId: string | null }> {
    if (ctx?.overlayDir) {
      assertGitOverlaySource(ctx.source);
      // The whole deploy reads the overlay, so every Compose run it starts,
      // including the compensation compose up in the catch below, runs inside
      // this scope and withholds its output.
      if (!decryptedComposeOutputWithheld()) {
        return runWithDecryptedComposeOutput(
          { stackName, nodeId: this.nodeId },
          () => this.deployStack(stackName, ws, atomic, ctx),
        );
      }
    }
    await this.assertSopsOverlayOrRefuse(stackName, ctx?.overlayDir);
    const stackDir = this.resolveStackDir(stackName, ctx);
    await this.assertRequiredEnvPresent(stackName, ctx?.overlayDir);
    // The overlay is the project this deploy will actually run, so the guard
    // reads it rather than the live stack.
    await this.assertSafePilotBindMapping(stackName, ctx?.overlayDir);
    await this.ensureExternalNetworksForDeploy(stackName, ctx);

    const debug = isDebugEnabled();
    const t0 = Date.now();
    if (debug) console.debug('[ComposeService:debug] deployStack', { stackName, stackDir, atomic });
    const sendOutput = (data: string) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    };

    const { StackUpdateRecoveryService } = await import('./StackUpdateRecoveryService');
    const recoverySvc = atomic ? StackUpdateRecoveryService.getInstance() : null;
    let recoveryId: string | null = null;
    let handedOff = false;

    if (atomic && recoverySvc) {
      sendOutput('=== Capturing rollback generation for atomic deploy ===\n');
      const candidate = await recoverySvc.captureCandidate({
        nodeId: this.nodeId,
        stackName,
        createdBy: 'atomic-deploy',
        operationKind: 'deployment',
      });
      recoveryId = candidate.id;
      if (!recoverySvc.markAcquired(candidate.id)) {
        await recoverySvc.abandon(candidate.id);
        throw new Error('Failed to mark recovery generation as acquired');
      }
      if (!recoverySvc.handoff(candidate.id, this.nodeId, stackName)) {
        await recoverySvc.abandon(candidate.id);
        throw new Error('Failed to hand off recovery generation');
      }
      handedOff = true;
      if (!recoverySvc.markReconciling(candidate.id)) {
        throw new Error('Failed to mark recovery generation as reconciling after handoff');
      }
    }

    // ComposeService is the only producer of deploy events: every deploy path
    // (manual, bulk, Git auto-deploy, App Store, scheduler, webhook) funnels
    // through here, so recording it anywhere else would double-count. A Git
    // dispatch deploy passes the id it durably recorded as its deploy intent
    // (a dispatch whose intent could not be recorded never reaches this call
    // at all), so recovery of an interrupted attempt finds this deploy's
    // rows by exact id; every other caller lets an id be minted here,
    // unchanged.
    const gitopsDeploy = this.beginGitOpsDeploy(stackName, ctx?.gitopsDeployOperationId);
    let composeHandedOff = false;

    try {
      try {
        const dockerController = DockerController.getInstance(this.nodeId);
        const legacyOrphans = await dockerController.getLegacyOrphanContainersByStack(stackName);
        if (legacyOrphans.length > 0) {
          sendOutput(`=== Cleaning up legacy orphan containers before deployment ===\n`);
          await dockerController.removeContainers(legacyOrphans.map((c) => c.Id));
        }
      } catch (e) {
        console.warn('Failed to clean up legacy containers for %s:', sanitizeForLog(stackName), e);
      }

      await this.withRegistryAuth(async (env) => {
        const digestPins = ctx?.digestPins;
        let overlayDir: string | null = null;
        try {
          const upAction = ['up', '-d', '--remove-orphans'];
          let args: string[];
          if (digestPins && Object.keys(digestPins).length > 0) {
            const pinned = await this.withDigestPinOverlay(
              stackName,
              upAction,
              stackDir,
              digestPins,
            );
            args = pinned.args;
            overlayDir = pinned.overlayDir;
          } else {
            args = await this.authoredComposeArgs(stackName, upAction, stackDir);
          }
          // End the gates from any earlier run here, after the arguments and the
          // registry auth have resolved and immediately before the compose up
          // replaces the containers they are observing, so neither a refused
          // deploy nor a poll in the compose up's own seconds costs a live gate.
          // The snapshots are retired further down, once this has provably
          // succeeded.
          await this.supersedeGatesForContainerOp(stackName, 'the stack was redeployed during the observation');
          composeHandedOff = true;
          await this.execute('docker', args, stackDir, ws, true, env, getComposeStallTimeoutMs());
        } finally {
          if (overlayDir) {
            await fs.promises.rm(overlayDir, { recursive: true, force: true }).catch(() => undefined);
          }
        }
      }, sendOutput);

      // Post-Deploy Health Probe
      await new Promise(resolve => setTimeout(resolve, 3000));

      const dockerController = DockerController.getInstance(this.nodeId);
      const containers = await dockerController.getDocker().listContainers({
        all: true,
        filters: { label: [`com.docker.compose.project=${stackName}`] }
      });

      for (const containerInfo of containers) {
        if (containerInfo.State === 'exited') {
          const container = dockerController.getDocker().getContainer(containerInfo.Id);
          const inspectData = await container.inspect();
          const exitCode = inspectData.State.ExitCode;

          if (exitCode !== 0) {
            throw this.createContainerCrashError(exitCode);
          }
        }
      }

      if (atomic && recoverySvc && recoveryId) {
        if (!recoverySvc.markImmediateVerified(recoveryId)) {
          console.warn(
            '[ComposeService] Could not CAS immediate_verified for recovery %s',
            sanitizeForLog(recoveryId),
          );
        }
      }
      // The deploy replaced every service's image, so the per-service snapshots
      // taken before it stop being rollback targets. This is the one commit every
      // deploy path (route, template, webhook, scheduler, mesh, blueprint, Git
      // apply) passes through. A stack rollback runs its own compose up, so the
      // route settles it there.
      await this.retireStaleServiceRecoveries(stackName);
      if (debug) console.debug(`[ComposeService:debug] deployStack completed in ${Date.now() - t0}ms`, { stackName });
      gitopsDeploy?.bound();
    } catch (deployError) {
      // Classified by whether Compose was handed the mutation. Only a failure
      // before that leaves the previous workload provably intact.
      gitopsDeploy?.failed(composeHandedOff ? 'post_mutation' : 'pre_mutation');
      // Name the GitOps deploy operation this failure belongs to on the
      // error that leaves this method; both rethrow arms carry it (see
      // stampGitOpsDeployId).
      if (gitopsDeploy) {
        this.stampGitOpsDeployId(deployError, gitopsDeploy.gitopsOperationId);
      }
      if (atomic && recoverySvc && handedOff && recoveryId) {
        sendOutput('\n=== Deployment failed - restoring previous runtime from recovery generation ===\n');
        const generationId = recoveryId;
        const rolledBack = await compensateOrSwallow(() =>
          recoverySvc.compensateWithCandidate(
            generationId,
            (overridePath, invocation, overlay) => this.composeUpWithRecoveryOverride(
              stackName,
              overridePath,
              ws,
              invocation,
              overlay,
            ),
          ),
        );
        const wrapped = new ComposeRollbackError(deployError, true, rolledBack);
        if (gitopsDeploy) {
          wrapped.gitopsDeployOperationId = gitopsDeploy.gitopsOperationId;
        }
        throw wrapped;
      }
      if (atomic && recoverySvc && recoveryId && !handedOff) {
        await recoverySvc.abandon(recoveryId);
      }
      throw deployError;
    }
    // Reached only on a successful deploy (the catch above always rethrows). Record
    // the drift baseline here so every deploy path gets one, not just the manual
    // route: bulk, Git-source, App Store, scheduler, and webhook deploys all funnel
    // through this method. Internally guarded; awaited so it cannot race later work.
    await DriftLedgerService.getInstance().recordBaseline(this.nodeId, stackName);
    // Reconcile the ledger against the just-deployed runtime: findings this deploy
    // fixed are resolved and any it left are recorded (and surfaced in the activity
    // feed) now, instead of waiting for someone to open the Drift tab. The rollback
    // route re-deploys through this method, so it is covered; a failed atomic deploy
    // instead restores the previous files and throws above, so that recovery path
    // reconciles on its next deploy or scan, not here. Best-effort internally.
    await DriftLedgerService.getInstance().reconcileStack(this.nodeId, stackName);
    // Refresh the exposure cache so posture reflects the just-deployed model.
    // Best-effort: a refresh failure logs a warning but never fails the deploy.
    try {
      await this.refreshExposureCache(stackName);
    } catch (err) {
      console.warn('[ComposeService] Exposure refresh failed after deploy for %s:',
        sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(err, 'unknown')));
    }
    return {
      recoveryId,
      deployedGenerationId: gitopsDeploy?.generationId ?? null,
      gitopsOperationId: gitopsDeploy?.gitopsOperationId ?? null,
    };
  }

  streamLogs(stackName: string, ws: WebSocket) {
    let isClosed = false;
    let isFirstRun = true;
    let isWaitingForActivity = false;

    ws.on('close', () => { isClosed = true; });

    const startStream = async () => {
      if (isClosed || ws.readyState !== WebSocket.OPEN) return;

      // Canonical js/path-injection barrier at the fs.stat sink.
      const baseResolved = path.resolve(this.baseDir);
      const stackDir = path.resolve(baseResolved, stackName);
      let stackDirGone = !stackDir.startsWith(baseResolved + path.sep);
      if (!stackDirGone) {
        try {
          const st = await fs.promises.stat(stackDir);
          stackDirGone = !st.isDirectory();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            stackDirGone = true;
          }
          // Other stat failures: keep the existing compose-ps path.
        }
      }
      if (stackDirGone) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(`\r\n\x1b[33m[Sencho] Stack directory is gone. Log stream idle.\x1b[0m\r\n`);
        }
        return;
      }

      try {
        const dockerController = DockerController.getInstance(this.nodeId);
        const containers = await dockerController.getContainersByStack(stackName);

        if (!containers || containers.length === 0) {
          if (!isWaitingForActivity) {
            ws.send(`\r\n\x1b[33m[Sencho] No containers found. Waiting for activity...\x1b[0m\r\n`);
            isWaitingForActivity = true;
          }
          setTimeout(startStream, 2000);
          return;
        }

        const runningContainers = containers.filter((c: any) => c.State === 'running');

        if (!isFirstRun && runningContainers.length === 0) {
          if (!isWaitingForActivity) {
            ws.send(`\r\n\x1b[33m[Sencho] Log stream ended. Waiting for container activity...\x1b[0m\r\n`);
            isWaitingForActivity = true;
          }
          setTimeout(startStream, 2000);
          return;
        }

        const containersToLog = isFirstRun ? containers : runningContainers;
        isFirstRun = false;
        isWaitingForActivity = false;

        let activeProcesses = 0;
        let streamEndedHandled = false;
        const localProcesses: ReturnType<typeof spawn>[] = [];

        const onWsClose = () => {
          localProcesses.forEach(cp => { try { cp.kill(); } catch { } });
        };

        ws.on('close', onWsClose);

        const handleProcessEnd = () => {
          activeProcesses--;
          if (activeProcesses <= 0 && !streamEndedHandled) {
            streamEndedHandled = true;
            ws.removeListener('close', onWsClose);
            if (!isClosed && ws.readyState === WebSocket.OPEN) {
              setTimeout(startStream, 1000);
            }
          }
        };

        for (const container of containersToLog) {
          const rawName = container.Names?.[0]?.replace(/^\//, '') || container.Id;
          const displayName = normalizeContainerName(rawName, stackName);
          activeProcesses++;
          let lineBuffer = '';

          const sendOutput = (data: Buffer) => {
            if (ws.readyState === WebSocket.OPEN) {
              lineBuffer += data.toString();
              const lines = lineBuffer.split(/\r?\n/);
              lineBuffer = lines.pop() || '';
              for (const line of lines) {
                ws.send(LogFormatter.process(`${displayName} | ${line}`) + '\r\n');
              }
            }
          };

          const flushBuffer = () => {
            if (lineBuffer && ws.readyState === WebSocket.OPEN) {
              ws.send(LogFormatter.process(`${displayName} | ${lineBuffer}`) + '\r\n');
              lineBuffer = '';
            }
          };

          const child = spawn('docker', ['logs', '-f', '-t', '--tail', '100', rawName], {
            env: {
              ...process.env,
              PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
            }
          });
          localProcesses.push(child);
          child.stdout.on('data', sendOutput);
          child.stderr.on('data', sendOutput);
          child.on('error', handleProcessEnd);
          child.on('close', () => {
            flushBuffer();
            handleProcessEnd();
          });
        }
      } catch (err) {
        if (!isClosed && ws.readyState === WebSocket.OPEN) {
          if (!isWaitingForActivity) {
            ws.send(`\r\n\x1b[31m[Sencho] Error tracking containers. Retrying...\x1b[0m\r\n`);
            isWaitingForActivity = true;
          }
          setTimeout(startStream, 2000);
        }
      }
    };

    startStream();
  }


  /**
   * Pinned compose-up with a recovery override layered last
   * (`--pull never --no-build`). Used by manual rollback and deploy/update
   * compensation. When `invocation` is set, Compose args come from the
   * generation capture instead of the live database-derived invocation.
   */
  async composeUpWithRecoveryOverride(
    stackName: string,
    overridePath: string,
    ws?: WebSocket,
    invocation?: RollbackInvocationRecord | null,
    overlay?: Pick<DeployInvocationContext, 'overlayDir' | 'overlayBinding'>,
  ): Promise<ComposeMutationResult> {
    // Same confidentiality boundary as a deploy against an overlay: a manual
    // rollback restores into one and streams its Compose output.
    if (overlay?.overlayDir && !decryptedComposeOutputWithheld()) {
      return runWithDecryptedComposeOutput(
        { stackName, nodeId: this.nodeId },
        () => this.composeUpWithRecoveryOverride(stackName, overridePath, ws, invocation, overlay),
      );
    }
    if (overlay?.overlayDir && overlay.overlayBinding) {
      GitOpsDecryptOverlay.getInstance().assertBinding(overlay.overlayDir, overlay.overlayBinding);
    }
    const stackDir = overlay?.overlayDir ?? path.join(this.baseDir, stackName);
    const sendOutput = (data: string) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    };
    const upAction = ['up', '-d', '--remove-orphans', '--pull', 'never', '--no-build'];
    const args = await this.buildComposeArgsWithRecoveryOverride(
      stackName,
      upAction,
      overridePath,
      invocation ?? null,
      stackDir,
    );
    // The recovery is about to run this exact invocation, so the Pilot host-path
    // guard reads the same one: the captured file set, the env selection, the
    // recovery layer, and the decrypt overlay, all as assembled. Ordinary
    // deployment already refuses a mismapped overlay; a rollback restoring a
    // relative mount has the same consequence, so it refuses on the same terms.
    // `buildComposeArgsWithRecoveryOverride` appends the action last, so the
    // global-flag prefix is this argv without those tokens.
    await this.assertSafePilotBindMapping(
      stackName,
      overlay?.overlayDir,
      args.slice(0, args.length - upAction.length),
    );
    await this.withRegistryAuth(async (env) => {
      await this.execute(
        'docker',
        args,
        stackDir,
        ws,
        true,
        env,
        getComposeStallTimeoutMs(),
      );
    }, sendOutput);
    return { mutatedByCompose: true };
  }

  /**
   * Authored (+ mesh) compose args with an optional recovery override, and the
   * bind remap layered last. When `invocation` is provided, use its validated
   * captured prefix so recovery does not mix restored files with the live
   * deploy-spec / project-env selection.
   */
  public async buildComposeArgsWithRecoveryOverride(
    stackName: string,
    action: string[],
    recoveryOverridePath: string | null,
    invocation?: RollbackInvocationRecord | null,
    stackDirOverride?: string,
  ): Promise<string[]> {
    const useCaptured = hasUsableCapturedInvocation(invocation);
    const out = useCaptured
      ? ['compose', ...await this.composePrefixFromCapturedInvocation(stackName, invocation, stackDirOverride)]
      : await this.authoredComposePrefix(stackName, stackDirOverride);

    if (useCaptured && invocation.meshEnabled) {
      await this.appendCapturedMeshLayer(stackName, out);
    }

    if (recoveryOverridePath) {
      // A captured invocation encodes its file set once it recorded its compose
      // layers; older generations did not, so for those the implicit override
      // still has to be named or the trailing layer silently drops it.
      await this.ensureExplicitComposeFiles(
        stackName,
        out,
        !useCaptured || !invocation?.composeLayers,
      );
      out.push('-f', recoveryOverridePath);
    }
    await this.appendPersistentBindRemap(
      stackName,
      out,
      stackDirOverride,
      action.includes('up') || action.includes('create'),
    );
    out.push(...action);
    return out;
  }

  /**
   * Re-apply the Mesh override layer when the generation captured Mesh as enabled.
   * Uses live ensureStackOverride (same absolute override path semantics as deploy).
   */
  private async appendCapturedMeshLayer(stackName: string, args: string[]): Promise<void> {
    const overridePath = await MeshService.getInstance().ensureStackOverride(this.nodeId, stackName);
    if (!overridePath) {
      throw new Error(
        `Captured Mesh-enabled invocation cannot regenerate mesh override for stack "${stackName}"`,
      );
    }
    await this.ensureExplicitComposeFiles(stackName, args, true);
    args.push('-f', overridePath);
  }

  /**
   * When args lack `-f`, pin the stack compose file (and optionally the user
   * override) so a trailing override layer is accepted by docker compose.
   */
  private async ensureExplicitComposeFiles(
    stackName: string,
    args: string[],
    includeUserOverride: boolean,
  ): Promise<void> {
    if (args.includes('-f')) return;
    const fsSvc = FileSystemService.getInstance(this.nodeId);
    args.push('-f', await fsSvc.getComposeFilename(stackName));
    if (!includeUserOverride) return;
    try {
      const userOverride = await fsSvc.getOverrideFilename(stackName);
      if (userOverride) args.push('-f', userOverride);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'INVALID_STACK_NAME' || code === 'INVALID_PATH' || code === 'SYMLINK_ESCAPE') {
        throw err;
      }
      console.warn(
        '[ComposeService] could not resolve user compose override while pinning compose files:',
        sanitizeForLog((err as Error).message),
      );
    }
  }

  private resolveValidatedStackDir(stackName: string): string {
    const stackDir = path.resolve(this.baseDir, stackName);
    if (!isPathWithinBase(stackDir, this.baseDir) || path.resolve(this.baseDir) === stackDir) {
      throw new Error('Invalid stack path');
    }
    return stackDir;
  }

  /**
   * Pin `-p <stack>` when Compose runs from an override directory.
   *
   * The project name normally comes from the working-directory basename, so a
   * single-file stack carries no `-p` in its live or captured prefix. A SOPS
   * decrypt overlay changes that basename to the operation id; without the pin
   * Compose creates a stray project and leaves the real stack untouched.
   */
  private pinProjectNameForOverride(
    stackName: string,
    args: string[],
    stackDirOverride?: string,
  ): void {
    if (!stackDirOverride) return;
    if (path.resolve(stackDirOverride) === this.resolveValidatedStackDir(stackName)) return;
    if (this.hasProjectNameFlag(args)) return;
    if (this.composeDeclaresProjectName(args, path.resolve(stackDirOverride))) return;
    const composeIdx = args.indexOf('compose');
    args.splice(composeIdx >= 0 ? composeIdx + 1 : 0, 0, '-p', stackName);
  }

  /**
   * A compose file with a top-level `name:` already fixes the project name, so
   * an overlay's working-directory basename cannot leak into it. The pin must
   * not override the authored name, or a SOPS deploy would start a second
   * project beside the one the stack already runs.
   */
  private composeDeclaresProjectName(args: string[], stackDir: string): boolean {
    const resolvedStackDir = path.resolve(stackDir);
    const files: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '-f' || args[i] === '--file') files.push(args[i + 1]);
    }
    if (files.length === 0) {
      // No explicit -f, so Compose's own discovery decides: the two families in
      // the order Compose resolves them, roots before the implicit override.
      files.push(...COMPOSE_ROOT_FILENAMES, ...COMPOSE_OVERRIDE_FILENAMES);
    }
    for (const file of files) {
      const abs = path.resolve(resolvedStackDir, file);
      // Canonical inline js/path-injection barrier at the read sink: only the
      // stack tree is read. Generated overlay layers (digest pin, mesh,
      // recovery) live outside it and cannot declare a project name.
      if (!abs.startsWith(resolvedStackDir + path.sep)) continue;
      try {
        const content = fs.readFileSync(abs, 'utf8');
        // A compose layer is small; anything larger is not one, and the read is
        // synchronous on the deploy path.
        if (content.length > 1_048_576) continue;
        const doc: unknown = parseYaml(content);
        if (doc !== null && typeof doc === 'object' && !Array.isArray(doc)) {
          const name = (doc as Record<string, unknown>).name;
          if (typeof name === 'string' && name.trim() !== '') return true;
        }
      } catch {
        // A missing, unreadable, or non-YAML layer cannot declare a name.
      }
    }
    return false;
  }

  /**
   * Positional scan: a compose file or env file literally named `-p` is a flag
   * value, not a project-name flag, so skip each flag's value token.
   */
  private hasProjectNameFlag(args: string[]): boolean {
    for (let i = 0; i < args.length; i++) {
      const token = args[i];
      if (token === '-f' || token === '--file' || token === '--env-file' || token === '--project-directory') {
        i++;
        continue;
      }
      if (token === '-p' || token === '--project-name') return true;
    }
    return false;
  }

  /** Rebase a captured absolute stack path onto the overlay root when present. */
  private remapCapturedAbsToRoot(abs: string, stackDir: string, pathRoot: string): string | null {
    const remapped = path.resolve(pathRoot, path.relative(stackDir, abs));
    return isPathWithinBase(remapped, pathRoot) ? remapped : null;
  }

  /**
   * The real form of a captured path, falling back to the lexical one when it
   * does not resolve (missing, dangling, or unreadable). Compose reports a
   * missing env file itself; an unresolvable path is not a path escape.
   */
  private async realCapturedPath(abs: string): Promise<string> {
  try {
    return await fs.promises.realpath(abs);
  } catch {
    return abs;
  }
}

  /**
   * Resolve a captured `--env-file` to the path recovery must launch with.
   *
   * Capture emits the path of a selected project env file, which is the real
   * path for a configured file and the compose-root spelling for the
   * context-directory fallback, and the helper that produced it authorizes any
   * path inside the compose root, not only inside the stack directory. A stack
   * whose selected env file links to a sibling in that root therefore captures
   * an env-file recovery has to accept, so recovery validates against the same
   * root instead of a narrower one. Containment is decided on the real path, as
   * capture does, so a name inside the root whose link target leaves it is
   * refused rather than followed. An in-stack path is mirrored under the
   * overlay root; an authorized path outside the stack directory keeps its live
   * location, because a recovery overlay mirrors the stack directory alone.
   * Both the lexical and the real compose root are matched, so a relocated
   * (symlinked) compose directory still resolves, and the mirror is derived in
   * the coordinates of the root that matched. Anything outside the compose root
   * is refused.
   */
  private async resolveCapturedEnvFile(
    stackName: string,
    abs: string,
    stackDir: string,
    pathRoot: string,
  ): Promise<string> {
    const baseResolved = path.resolve(this.baseDir);
    // Real compose base plus the lexical stack name, the same rule the
    // generation store applies, so a stack dir that links elsewhere stays out.
    const realBase = await this.realCapturedPath(baseResolved);
    const roots = [{ stackDir, base: baseResolved }];
    if (realBase !== baseResolved) {
      roots.push({ stackDir: path.join(realBase, stackName), base: realBase });
    }
    const realAbs = await this.realCapturedPath(abs);
    for (const root of roots) {
      if (!isPathWithinBase(realAbs, root.stackDir)) continue;
      // The root that matched decides the coordinate system the path is rebased
      // in. A captured spelling that already lives under it is kept, so a stack
      // file that links to a sibling keeps its own name; otherwise the real path
      // is used, because a linked compose root puts the captured lexical name
      // outside the real stack directory while the file itself is inside it.
      const matched = isPathWithinBase(abs, root.stackDir) ? abs : realAbs;
      const remapped = this.remapCapturedAbsToRoot(matched, root.stackDir, pathRoot);
      if (!remapped) {
        throw new Error(`Captured env-file path escapes overlay directory for "${stackName}"`);
      }
      return remapped;
    }
    if (roots.some(root => isPathWithinBase(realAbs, root.base))) return abs;
    throw new Error(`Captured env-file path escapes stack directory for "${stackName}"`);
  }

  /**
   * Refuse a captured compose layer whose real target Compose would open
   * outside the compose root. The path is the one recovery passes to `-f`,
   * resolved against the working directory (the stack, or an overlay outside
   * that root). A lexical name inside the stack can still be a symlink.
   * A missing path is left for Compose: restore writes held files back, and an
   * omitted layer that is simply absent is not an escape. A dangling or
   * looping link cannot be shown to stay inside the root, so it is refused.
   * A target inside the compose root stays allowed, including a shared file
   * outside the stack directory. When the working directory itself is an
   * overlay outside the compose root, a target inside that overlay is allowed
   * too.
   */
  private async assertCapturedComposeLayerTarget(layer: string, pathRoot: string): Promise<void> {
    const lexical = path.resolve(pathRoot, layer);
    try {
      await fs.promises.lstat(lexical);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    let real: string;
    try {
      real = await fs.promises.realpath(lexical);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') {
        throw Object.assign(
          new Error(`Captured compose layer "${layer}" does not resolve inside the compose directory`),
          { code: 'SYMLINK_ESCAPE' },
        );
      }
      throw e;
    }
    const baseResolved = path.resolve(this.baseDir);
    const realBase = await this.realCapturedPath(baseResolved);
    if (isPathWithinBase(real, baseResolved) || isPathWithinBase(real, realBase)) return;
    const cwdInside = isPathWithinBase(pathRoot, baseResolved) || isPathWithinBase(pathRoot, realBase);
    if (!cwdInside && isPathWithinBase(real, pathRoot)) return;
    throw Object.assign(
      new Error(`Captured compose layer "${layer}" resolves outside the compose directory`),
      { code: 'SYMLINK_ESCAPE' },
    );
  }

  /**
   * Rebuild a spawn-safe compose global-flag prefix from a generation's
   * captured invocation. Captured paths must resolve inside the stack
   * directory (a captured `--env-file` inside the compose root, which is the
   * root its capture-time validation uses); when overlayDir is set, absolute
   * --env-file and --project-directory paths are rewritten under that overlay.
   * Compose layers are also checked on the real path Compose will open.
   */
  private async composePrefixFromCapturedInvocation(
    stackName: string,
    invocation: RollbackInvocationRecord,
    overlayDir?: string,
  ): Promise<string[]> {
    const stackDir = this.resolveValidatedStackDir(stackName);
    const pathRoot = overlayDir ? path.resolve(overlayDir) : stackDir;
    // Empty prefix is valid (single-file auto-discovery at capture time).
    const raw = [...invocation.composeArgsPrefix];
    const out: string[] = [];
    // Compose picks the root compose file and the implicit override by name, so
    // an ordinary single-file stack captured no -f and left the choice to
    // discovery. Recovery pins the layers the generation captured instead:
    // otherwise a root added after capture wins discovery and the recovery runs
    // a configuration the generation never held. Only the layers Compose
    // selects at the project root belong here, never an included file.
    if (invocation.composeLayers && !raw.includes('-f') && !raw.includes('--file')) {
      for (const layer of invocation.composeLayers) {
        if (!isValidRelativeStackPath(layer)) {
          throw new Error(`Invalid captured compose layer path for stack "${stackName}"`);
        }
        if (!isPathWithinBase(path.resolve(stackDir, layer), stackDir)) {
          throw new Error(`Captured compose layer path escapes stack directory for "${stackName}"`);
        }
        await this.assertCapturedComposeLayerTarget(layer, pathRoot);
        out.push('-f', layer);
      }
    }
    for (let i = 0; i < raw.length; i++) {
      const token = raw[i];
      if (token === '-f' || token === '--file') {
        const file = raw[++i];
        if (!file || !isValidRelativeStackPath(file)) {
          throw new Error(`Invalid captured compose file path for stack "${stackName}"`);
        }
        if (!isPathWithinBase(path.resolve(stackDir, file), stackDir)) {
          throw new Error(`Captured compose file path escapes stack directory for "${stackName}"`);
        }
        await this.assertCapturedComposeLayerTarget(file, pathRoot);
        out.push('-f', file);
        continue;
      }
      if (token === '--env-file') {
        const envPath = raw[++i];
        if (!envPath) {
          throw new Error(`Invalid captured --env-file for stack "${stackName}"`);
        }
        out.push('--env-file', await this.resolveCapturedEnvFile(
          stackName,
          path.resolve(envPath),
          stackDir,
          pathRoot,
        ));
        continue;
      }
      if (token === '--project-directory') {
        const dir = raw[++i];
        if (!dir) {
          throw new Error(`Invalid captured --project-directory for stack "${stackName}"`);
        }
        const abs = path.isAbsolute(dir) ? path.resolve(dir) : path.resolve(stackDir, dir);
        if (!isPathWithinBase(abs, stackDir)) {
          throw new Error(`Captured project-directory escapes stack directory for "${stackName}"`);
        }
        const remapped = this.remapCapturedAbsToRoot(abs, stackDir, pathRoot);
        if (!remapped) {
          throw new Error(`Captured project-directory escapes overlay directory for "${stackName}"`);
        }
        out.push('--project-directory', remapped);
        continue;
      }
      if (token === '-p' || token === '--project-name') {
        const name = raw[++i];
        if (!name || name !== (invocation.projectName || stackName)) {
          throw new Error(`Captured project name mismatch for stack "${stackName}"`);
        }
        out.push('-p', stackName);
        continue;
      }
      throw new Error(`Unsupported captured compose flag "${token}" for stack "${stackName}"`);
    }
    this.pinProjectNameForOverride(stackName, out, overlayDir);
    return out;
  }

  async updateStack(
    stackName: string,
    ws?: WebSocket,
    atomic?: boolean,
  ): Promise<{ recoveryId: string | null; deployedGenerationId: string | null; gitopsOperationId: string | null }> {
    await this.assertSopsOverlayOrRefuse(stackName);
    await this.assertRequiredEnvPresent(stackName);
    await this.assertSafePilotBindMapping(stackName);
    const stackDir = path.join(this.baseDir, stackName);
    const debug = isDebugEnabled();
    const t0 = Date.now();
    if (debug) console.debug('[ComposeService:debug] updateStack', { stackName, stackDir, atomic });
    const sendOutput = (data: string) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    };

    // Opened once the update is committed to recreating containers, not at the
    // top: an update that fails during capture or classification never reached
    // Compose, so there is no deploy to record.
    let gitopsDeploy: ReturnType<ComposeService['beginGitOpsDeploy']> = null;
    let composeHandedOff = false;

    // Dynamic import avoids a static cycle (recovery imports getComposeCommandTimeoutMs).
    const { StackUpdateRecoveryService } = await import('./StackUpdateRecoveryService');
    const recoverySvc = StackUpdateRecoveryService.getInstance();
    let recoveryId: string | null = null;
    let handedOff = false;

    try {
      sendOutput('=== Validating stack for update ===\n');
      sendOutput('=== Capturing rollback generation ===\n');
      const candidate = await recoverySvc.captureCandidate({
        nodeId: this.nodeId,
        stackName,
        createdBy: null,
        operationKind: 'update',
      });
      recoveryId = candidate.id;

      const buildServices = await loadStackBuildServices(this.nodeId, stackName);
      const buildAware = buildServices.length > 0;

      try {
        await this.withRegistryAuth(async (env) => {
          if (buildAware) {
            sendOutput('=== Building images ===\n');
            await this.execute(
              'docker',
              await this.authoredComposeArgs(stackName, ['build', '--pull']),
              stackDir, ws, true, env, getComposeStallTimeoutMs(),
            );
            sendOutput('=== Pulling registry images ===\n');
            await this.execute(
              'docker',
              await this.authoredComposeArgs(stackName, ['pull', '--ignore-buildable']),
              stackDir, ws, true, env, getComposeStallTimeoutMs(),
            );
          } else {
            sendOutput('=== Pulling latest images ===\n');
            await this.execute(
              'docker',
              await this.authoredComposeArgs(stackName, ['pull']),
              stackDir, ws, true, env, getComposeStallTimeoutMs(),
            );
          }
        }, sendOutput);
      } catch (acquireError) {
        // Acquisition failure: abandon candidate; leave runtime untouched.
        await recoverySvc.abandon(candidate.id);
        recoveryId = null;
        throw acquireError;
      }

      if (!recoverySvc.markAcquired(candidate.id)) {
        await recoverySvc.abandon(candidate.id);
        throw new Error('Failed to mark recovery generation as acquired');
      }

      const dockerController = DockerController.getInstance(this.nodeId);
      sendOutput('=== Classifying legacy orphans ===\n');
      const classified = await dockerController.classifyLegacyOrphansForUpdate(stackName);
      if (classified.status === 'classification_failed') {
        await recoverySvc.abandon(candidate.id);
        recoveryId = null;
        throw new Error(`Legacy orphan classification failed: ${classified.error}`);
      }

      if (!recoverySvc.handoff(candidate.id, this.nodeId, stackName)) {
        await recoverySvc.abandon(candidate.id);
        recoveryId = null;
        throw new Error('Failed to hand off recovery generation');
      }
      handedOff = true;
      if (!recoverySvc.markReconciling(candidate.id)) {
        throw new Error('Failed to mark recovery generation as reconciling after handoff');
      }

      if (classified.status === 'orphans') {
        sendOutput(`=== Removing ${classified.ids.length} legacy orphan container(s) ===\n`);
        const results = await dockerController.removeContainers(classified.ids);
        const failed = results.filter((r) => !r.success);
        if (failed.length > 0) {
          throw new Error(
            `Failed to remove ${failed.length} legacy orphan container(s) after handoff`,
          );
        }
      }

      gitopsDeploy = this.beginGitOpsDeploy(stackName);
      await this.withRegistryAuth(async (env) => {
        sendOutput('=== Recreating containers ===\n');
        const args = await this.authoredComposeArgs(stackName, ['up', '-d', '--remove-orphans']);
        // End the gates from any earlier run here, for the same reason as the
        // deploy path: after the arguments and the registry auth have resolved,
        // and immediately before the compose up replaces the containers they are
        // observing.
        await this.supersedeGatesForContainerOp(stackName, 'the stack was updated during the observation');
        // Set only once Compose is genuinely about to receive the mutation:
        // reading compose args or resolving registry auth can still fail with
        // the previous workload provably intact.
        composeHandedOff = true;
        await this.execute('docker', args, stackDir, ws, true, env, getComposeStallTimeoutMs());
      }, sendOutput);

      // Immediate verification probe
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const containers = await dockerController.getDocker().listContainers({
        all: true,
        filters: { label: [`com.docker.compose.project=${stackName}`] },
      });

      for (const containerInfo of containers) {
        if (containerInfo.State === 'exited') {
          const container = dockerController.getDocker().getContainer(containerInfo.Id);
          const inspectData = await container.inspect();
          const exitCode = inspectData.State.ExitCode;
          if (exitCode !== 0) {
            throw this.createContainerCrashError(exitCode);
          }
        }
      }

      if (!recoverySvc.markImmediateVerified(candidate.id)) {
        console.warn(
          '[ComposeService] Could not CAS immediate_verified for recovery %s',
          sanitizeForLog(candidate.id),
        );
      }

      // The update replaced every service's image, so the per-service snapshots
      // taken before it stop being rollback targets. With the same step on the
      // deploy path, this is the one place a stack runtime change retires them.
      await this.retireStaleServiceRecoveries(stackName);

      sendOutput('=== Stack updated successfully ===\n');

      // Defer prune until gate retention / gate link: only prune when no active holds
      // would be violated. Still honor prune_on_update, but use unified holds so
      // candidate/current rollback images are retained.
      try {
        const pruneOnUpdate = DatabaseService.getInstance().getGlobalSettings()['prune_on_update'] === '1';
        if (pruneOnUpdate) {
          const isImageHeld = buildUnifiedHeldImagePredicate(this.nodeId);
          const result = await DockerController.getInstance(this.nodeId).pruneDanglingImages(isImageHeld);
          const reclaimed = result.reclaimedBytes > 0
            ? ` · reclaimed ${(result.reclaimedBytes / (1024 * 1024)).toFixed(1)} MB`
            : '';
          sendOutput(`=== Pruned dangling images${reclaimed} ===\n`);
        }
      } catch (pruneError) {
        console.warn(
          'Failed to prune dangling images after update for %s:',
          sanitizeForLog(stackName),
          pruneError,
        );
      }

      if (debug) {
        console.debug(`[ComposeService:debug] updateStack completed in ${Date.now() - t0}ms`, { stackName });
      }
      gitopsDeploy?.bound();
    } catch (updateError) {
      gitopsDeploy?.failed(composeHandedOff ? 'post_mutation' : 'pre_mutation');
      // Mirrors the deployStack stamp so any caller correlating a failed
      // deploy to its GitOps record reads the id off the thrown error,
      // whichever mutation seam it came through.
      if (gitopsDeploy) {
        this.stampGitOpsDeployId(updateError, gitopsDeploy.gitopsOperationId);
      }
      if (!handedOff && recoveryId) {
        await recoverySvc.abandon(recoveryId);
        recoveryId = null;
      }
      if (handedOff && recoveryId) {
        sendOutput('\n=== Update failed - restoring previous runtime from recovery generation ===\n');
        const generationId = recoveryId;
        const rolledBack = await compensateOrSwallow(() =>
          recoverySvc.compensateWithCandidate(
            generationId,
            (overridePath, invocation, overlay) => this.composeUpWithRecoveryOverride(
              stackName,
              overridePath,
              ws,
              invocation,
              overlay,
            ),
          ),
        );
        const wrapped = new ComposeRollbackError(updateError, true, rolledBack);
        if (gitopsDeploy) {
          wrapped.gitopsDeployOperationId = gitopsDeploy.gitopsOperationId;
        }
        throw wrapped;
      }
      // Pre-handoff failure: abandon already handled on acquire/classify; runtime untouched.
      throw updateError;
    }

    await DriftLedgerService.getInstance().recordBaseline(this.nodeId, stackName);
    await DriftLedgerService.getInstance().reconcileStack(this.nodeId, stackName);
    try {
      await this.refreshExposureCache(stackName);
    } catch (err) {
      console.warn(
        '[ComposeService] Exposure refresh failed after update for %s:',
        sanitizeForLog(stackName),
        sanitizeForLog(getErrorMessage(err, 'unknown')),
      );
    }
    return {
      recoveryId,
      deployedGenerationId: gitopsDeploy?.generationId ?? null,
      gitopsOperationId: gitopsDeploy?.gitopsOperationId ?? null,
    };
  }

  /**
   * Acquire registry-backed images for a stack without touching the runtime.
   *
   * Never builds, and never pulls a build-backed service: `--ignore-buildable`
   * is passed unconditionally, so a service declaring `build:` is skipped rather
   * than pulled or built whether or not this method knows about it. The
   * unconditional flag is what makes that true; the name list is a report only.
   * A service declaring both `image:` and `build:` does have a fetchable image;
   * skipping it is the deliberate choice, not a lack of one. That list comes from
   * `loadStackBuildServices`, the same helper the update path uses: the rendered
   * effective model when a Git deploy spec is applied and renders, the root
   * compose file otherwise, which includes a Git-sourced stack whose effective
   * render failed. A `build:` that only an override file declares is therefore
   * skipped by the CLI but not named in the list. This method opens no rollback
   * generation, writes no deployment generation, and starts no health gate,
   * because it does not reconcile the runtime and therefore has nothing to roll
   * back to. The only state it changes is which images exist in the local Docker
   * image store.
   */
  async pullStackImages(
    stackName: string,
    ws?: WebSocket,
  ): Promise<{ skippedBuildBacked: string[] }> {
    const stackDir = path.join(this.baseDir, stackName);
    const sendOutput = (data: string) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    };

    // Same preflight every sibling compose operation runs. Without it, ${VAR} in
    // an image reference resolves against still-encrypted files on a SOPS stack,
    // so the pull can fetch a different image than a deploy would use.
    await this.assertSopsOverlayOrRefuse(stackName);
    // No `blocked` clause: the editor surfaces this behind its own "Image pull
    // failed:" prefix, and the remedy names the action the operator actually chose.
    await this.assertRequiredEnvPresent(stackName, undefined, {
      remedy: 'then run Save & Pull Images again.',
    });

    // Best-effort, and only for the skip report. loadStackBuildServices reads the
    // root compose file for stacks without a Git source, so a build: declared
    // only in compose.override.yaml is not listed below.
    const skippedBuildBacked = await loadStackBuildServices(this.nodeId, stackName);

    await this.withRegistryAuth(async (env) => {
      if (skippedBuildBacked.length > 0) {
        sendOutput(
          `=== Skipping build-backed services: ${skippedBuildBacked.join(', ')} ===\n`,
        );
      }
      // --ignore-buildable is unconditional: it is what makes "skip, never
      // build" true at the CLI level, for a service declaring both `image:` and
      // `build:`. It does not rely on the skip list above being complete, so a
      // build: that only an override file declares is still skipped.
      sendOutput('=== Pulling registry images ===\n');
      await this.execute(
        'docker',
        await this.authoredComposeArgs(stackName, ['pull', '--ignore-buildable']),
        stackDir, ws, true, env, getComposeStallTimeoutMs(),
      );
    }, sendOutput);

    return { skippedBuildBacked };
  }

  /**
   * Service-scoped update: pull (or `build --pull` for a build-backed service)
   * and recreate a single service's replicas in place. Always
   * `--no-deps --force-recreate`, never `--remove-orphans`, so sibling services
   * keep their container ids and StartedAt. No drift re-baseline and no dangling
   * prune here; the orchestrator owns per-service post-update reconciliation.
   */
  async updateService(stackName: string, serviceName: string, hasBuild: boolean, ws?: WebSocket): Promise<void> {
    await this.assertSopsOverlayOrRefuse(stackName);
    await this.assertRequiredEnvPresent(stackName);
    await this.assertSafePilotBindMapping(stackName);
    const stackDir = path.join(this.baseDir, stackName);
    const sendOutput = (data: string) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    };
    await this.withRegistryAuth(async (env) => {
      if (hasBuild) {
        sendOutput(`=== Building ${serviceName} ===\n`);
        await this.execute('docker', await this.authoredComposeArgs(stackName, ['build', '--pull', serviceName]), stackDir, ws, true, env, getComposeStallTimeoutMs());
      } else {
        sendOutput(`=== Pulling ${serviceName} ===\n`);
        await this.execute('docker', await this.authoredComposeArgs(stackName, ['pull', serviceName]), stackDir, ws, true, env, getComposeStallTimeoutMs());
      }
      sendOutput(`=== Recreating ${serviceName} ===\n`);
      await this.execute('docker', await this.authoredComposeArgs(stackName, ['up', '-d', '--no-deps', '--force-recreate', serviceName]), stackDir, ws, true, env, getComposeStallTimeoutMs());
    }, sendOutput);
  }

  /**
   * Recreate a single service from the image already present locally, without
   * pulling or building. Used by service restore after the recovery image id has
   * been retagged onto the declared ref (`--pull never --no-build` so Compose
   * uses the just-retagged local image). Always `--no-deps --force-recreate`,
   * never `--remove-orphans`.
   */
  async recreateServiceFromLocal(stackName: string, serviceName: string, ws?: WebSocket): Promise<void> {
    await this.assertSopsOverlayOrRefuse(stackName);
    await this.assertRequiredEnvPresent(stackName);
    await this.assertSafePilotBindMapping(stackName);
    const stackDir = path.join(this.baseDir, stackName);
    const sendOutput = (data: string) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    };
    await this.withRegistryAuth(async (env) => {
      sendOutput(`=== Restoring ${serviceName} ===\n`);
      await this.execute('docker', await this.authoredComposeArgs(stackName, ['up', '-d', '--no-deps', '--force-recreate', '--pull', 'never', '--no-build', serviceName]), stackDir, ws, true, env, getComposeStallTimeoutMs());
    }, sendOutput);
  }

  public async downStack(stackName: string, options?: { removeVolumes?: boolean }): Promise<void> {
    const stackPath = path.join(this.baseDir, stackName);
    try {
      const args = options?.removeVolumes
        ? ['down', '--volumes', '--remove-orphans']
        : ['down', '--remove-orphans'];
      // Teardown removes the containers a gate would be observing (stack deletion,
      // and the rollback down of a failed template deploy), so it ends the gates
      // first, for the same reason runDown does.
      await this.supersedeGatesForContainerOp(stackName, 'the stack was torn down during the observation');
      await this.execute('docker', await this.authoredComposeArgs(stackName, args), stackPath, undefined, false);
    } catch (error) {
      console.warn(`[Teardown] Docker down failed or nothing to clean up for ${sanitizeForLog(stackName)}`);
    }
  }

  /**
   * Enumerate image references declared in a stack's compose file.
   *
   * Used by the pre-deploy policy gate to decide which images to scan before
   * `docker compose up` runs. Path traversal is guarded against the node's
   * compose base directory; missing / unreadable compose files or `.env`
   * interpolation failures surface as a rejected Promise so the gate can
   * block the deploy rather than silently allow it.
   */
  public async listStackImages(
    stackName: string,
    invocation?: RollbackInvocationRecord | null,
  ): Promise<string[]> {
    if (!isValidStackName(stackName)) {
      throw new Error('Invalid stack path');
    }
    const stackDir = this.resolveValidatedStackDir(stackName);
    // Prefer a generation-captured invocation so restored-target policy does not
    // scan with the live deploy-spec / project-env selection.
    const useCaptured = hasUsableCapturedInvocation(invocation);
    const fileAndEnvPrefix = useCaptured
      ? await this.composePrefixFromCapturedInvocation(stackName, invocation)
      : [
        ...authoredComposeFileArgs(stackName, this.nodeId),
        ...(await authoredComposeEnvFileArgs(stackName, this.nodeId)),
      ];
    if (useCaptured && invocation.meshEnabled) {
      await this.appendCapturedMeshLayer(stackName, fileAndEnvPrefix);
    }
    const stdout = await this.captureCompose([...fileAndEnvPrefix, 'config', '--images'], stackDir);
    const seen = new Set<string>();
    const images: string[] = [];
    for (const raw of stdout.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('sha256:')) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      images.push(line);
    }
    return images;
  }

  /** Render the effective Compose model and cache the per-stack exposure
   *  descriptor so the Security posture can join exposed images against
   *  vulnerability findings without re-rendering config on every poll.
   *  Best-effort: render or parse failure logs a warning and keeps the
   *  prior cached descriptor, never failing the deploy. */
  private async refreshExposureCache(stackName: string): Promise<void> {
    const result = await this.renderConfig(stackName);
    if (result.rendered === null) {
      console.warn('[ComposeService] Exposure cache skipped for %s: model not renderable',
        sanitizeForLog(stackName));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.rendered);
    } catch {
      console.warn('[ComposeService] Exposure cache skipped for %s: unparseable model JSON',
        sanitizeForLog(stackName));
      return;
    }
    const model = parseEffectiveModel(parsed, stackName);
    const descriptor = deriveStackExposure(model, stackName, Date.now());
    DatabaseService.getInstance().upsertStackExposure(
      this.nodeId,
      stackName,
      JSON.stringify(descriptor),
      descriptor.computedAt,
    );
  }

  private captureCompose(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', ['compose', ...args], {
        cwd,
        env: {
          ...process.env,
          PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      child.on('error', (err: NodeJS.ErrnoException) => {
        const mapped = describeSpawnError(err, { command: 'docker compose' });
        if (mapped.isLowMemory) {
          console.warn('[ComposeService] captureCompose spawn failed under memory pressure:', mapped.message);
        }
        reject(new Error(mapped.message));
      });
      child.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `docker compose ${args.join(' ')} failed with code ${code}`));
      });
    });
  }

  /**
   * Render the effective compose model as YAML (the default `docker compose
   * config` output) with the exact authored invocation and NO mesh override.
   * Used by the Git source detach/export contract: the rendered model becomes
   * the stack's single compose.yaml. Throws when the render fails or times
   * out, so the detach transaction aborts before anything changes.
   */
  public async renderComposeYaml(stackName: string): Promise<string> {
    if (!isValidStackName(stackName)) {
      throw new Error('Invalid stack path');
    }
    const baseResolved = path.resolve(this.baseDir);
    const stackDir = path.resolve(baseResolved, stackName);
    if (!stackDir.startsWith(baseResolved + path.sep)) {
      throw new Error('Invalid stack path');
    }
    let filePrefix: string[];
    try {
      filePrefix = authoredComposeFileArgs(stackName, this.nodeId);
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    const envFileArgs = await authoredComposeEnvFileArgs(stackName, this.nodeId);
    const child = spawn('docker', ['compose', ...filePrefix, ...envFileArgs, 'config'], {
      cwd: stackDir,
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      },
    });
    return new Promise((resolve, reject) => {
      const MAX_OUTPUT = 5 * 1024 * 1024; // 5 MiB cap on each stream
      const TIMEOUT_MS = 30_000;
      // Accumulate Buffer chunks and decode ONCE at the end: chunk-wise
      // toString() can split a multi-byte UTF-8 sequence across a chunk
      // boundary and mangle non-ASCII values.
      const outChunks: Buffer[] = [];
      let outBytes = 0;
      let stderr = '';
      let capped = false;
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        clearTimeout(timer);
        try {
          child.kill('SIGKILL');
        } catch {
          // best effort
        }
        reject(new Error(`docker compose config timed out after ${TIMEOUT_MS / 1000}s`));
      }, TIMEOUT_MS);
      const finish = (error: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(Buffer.concat(outChunks).toString('utf8'));
      };
      child.stdout.on('data', (data: Buffer) => {
        if (capped) return;
        outBytes += data.length;
        if (outBytes > MAX_OUTPUT) {
          // A truncated model frequently still parses as YAML; overwriting a
          // working compose.yaml with it would be silent corruption. The cap is
          // an error, not a truncation.
          capped = true;
          settled = true;
          clearTimeout(timer);
          try {
            child.kill('SIGKILL');
          } catch {
            // best effort
          }
          reject(new Error(`docker compose config output exceeded ${MAX_OUTPUT} bytes`));
          return;
        }
        outChunks.push(data);
      });
      child.stderr.on('data', (data: Buffer) => {
        if (stderr.length < MAX_OUTPUT) stderr += data.toString();
      });
      child.on('close', (code) => {
        if (capped) return;
        if (code === 0) finish(null);
        else finish(new Error(stderr.trim() || `docker compose config exited with code ${code}`));
      });
      child.on('error', (err) => finish(err));
    });
  }

  /**
   * Render the fully-resolved effective Compose model via `docker compose
   * config --format json`. This is the AUTHORED model: it does NOT splice in
   * the Sencho Mesh override, so it stays read-only (the override is
   * write-generated) and reflects what the user actually edits. The override
   * would also add the managed `sencho_mesh` external network and per-service
   * mesh attachments, which would make preflight emit a false "external network
   * not found" finding, so rendering the authored model is both safer and more
   * accurate here.
   * Captures stderr (where Compose reports unset variables) and never rejects
   * on a non-zero exit, so the Compose Doctor can turn a failed render into a
   * finding rather than an exception. Bounded by a timeout and an output cap.
   * Rejects only when the docker binary cannot be spawned.
   *
   * `opts.stackDirOverride` renders the model the deployment it gates will
   * actually use: a GitOps decrypt overlay, whose env files are plaintext while
   * the live stack's stay ciphertext. The working directory, the authored
   * files, the env-file arguments, and the project-name pin are all selected
   * for that overlay, so the preflight and the Compose run that follows resolve
   * the same project, the same variables, and the same typed values (a
   * published port, an external network name).
   *
   * Such a render withholds its own diagnostics: `stderr` comes back empty and
   * `withheld` is set, because Compose quotes interpolated values back and those
   * are plaintext secrets. The rendered model is still returned, since the
   * caller reads it structurally (which external networks are declared) and
   * never hands it to the operator; a caller that has to explain a failed
   * render reports the withheld text instead of Compose's own words.
   *
   * `opts.composePrefix` renders a caller-assembled invocation (a rollback
   * rebuilt from a captured generation) instead of one derived from live
   * state. The prefix already carries the files, the env selection, the
   * project-name pin, and any generated layer, so it is used verbatim; only
   * the action is replaced with the render.
   */
  public async renderConfig(
    stackName: string,
    opts?: { stackDirOverride?: string; composePrefix?: string[] },
  ): Promise<{ rendered: string | null; stderr: string; code: number | null; timedOut: boolean; withheld?: boolean }> {
    if (!isValidStackName(stackName)) {
      throw new Error('Invalid stack path');
    }
    // Canonical inline js/path-injection barrier, kept in the same scope as the
    // spawn cwd sink below. CodeQL credits neither the wrapped isPathWithinBase
    // helper nor a barrier separated from the sink by the Promise-executor
    // closure, so the spawn is hoisted out of the executor. startsWith already
    // rejects the base dir itself, since base does not start with base + sep.
    const baseResolved = path.resolve(this.baseDir);
    const overlayDir = opts?.stackDirOverride ? path.resolve(opts.stackDirOverride) : null;
    let stackDir: string;
    if (overlayDir) {
      // The git-secrets root is the only tree a decrypt overlay lives in, so it
      // is the one base an overridden working directory may be contained by.
      // Checked here, at the sink, rather than trusted from the caller.
      const secretsRoot = path.resolve(gitSecretsAreaBase());
      if (!overlayDir.startsWith(secretsRoot + path.sep)) {
        throw new Error('Invalid stack path');
      }
      stackDir = overlayDir;
    } else {
      stackDir = path.resolve(baseResolved, stackName);
      if (!stackDir.startsWith(baseResolved + path.sep)) {
        throw new Error('Invalid stack path');
      }
    }
    const stackDirOverride = overlayDir ?? undefined;
    let composeArgs: string[];
    if (opts?.composePrefix) {
      composeArgs = [...opts.composePrefix];
    } else {
      // Render the authored multi-file model (no mesh override) so the Compose Doctor
      // sees every override file; single-file stacks get an empty prefix. The env-file
      // flag keeps render resolving the same root .env the validator and deploy use.
      let filePrefix: string[];
      try {
        filePrefix = authoredComposeFileArgs(stackName, this.nodeId, stackDirOverride);
      } catch (err) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      const envFileArgs = await authoredComposeEnvFileArgs(stackName, this.nodeId, stackDirOverride);
      composeArgs = ['compose', ...filePrefix, ...envFileArgs];
      // The overlay renames the working directory to the operation id, so the
      // render gets the same project-name pin the ensuing `up` gets. A no-op for
      // the live path, where the stack directory already names the project.
      // The bind remap is the same layer `up` loads, so the bind sources in this
      // model are the ones the deploy will mount.
      this.pinProjectNameForOverride(stackName, composeArgs, stackDirOverride);
      if (overlayDir) await this.appendPersistentBindRemap(stackName, composeArgs, overlayDir);
    }
    composeArgs.push('config', '--format', 'json');
    const withholdDiagnostics = overlayDir !== null;
    const child = spawn('docker', composeArgs, {
      cwd: stackDir,
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      },
    });
    return new Promise((resolve, reject) => {
      const MAX_OUTPUT = 5 * 1024 * 1024; // 5 MiB cap on each stream
      const TIMEOUT_MS = 20_000;
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let capped = false;
      let settled = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, TIMEOUT_MS);
      const finish = (result: { rendered: string | null; stderr: string; code: number | null; timedOut: boolean; withheld?: boolean }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
        if (stdout.length > MAX_OUTPUT && !capped) { capped = true; child.kill('SIGKILL'); }
      });
      child.stderr.on('data', (data: Buffer) => {
        if (withholdDiagnostics) return;
        if (stderr.length < MAX_OUTPUT) stderr += data.toString();
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(describeSpawnError(err, { command: 'docker compose' }).message));
      });
      child.on('close', (code) => {
        if (withholdDiagnostics) {
          // A decrypted render keeps the model, which the caller reads
          // structurally, and drops the diagnostic, which is where Compose
          // quotes interpolated values back. Every failure reason collapses
          // into that one withheld result.
          const rendered = code === 0 && !timedOut && !capped ? stdout : null;
          finish({ rendered, stderr: '', code, timedOut, withheld: true });
        } else if (timedOut) finish({ rendered: null, stderr: stderr.trim() || 'docker compose config timed out', code, timedOut: true });
        else if (capped) finish({ rendered: null, stderr: 'Rendered model exceeded the size limit', code, timedOut: false });
        else if (code === 0) finish({ rendered: stdout, stderr, code, timedOut: false });
        else finish({ rendered: null, stderr: stderr.trim() || `docker compose config failed with code ${code}`, code, timedOut: false });
      });
    });
  }
}
