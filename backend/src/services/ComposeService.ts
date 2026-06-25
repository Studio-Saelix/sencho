import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';
import DockerController from './DockerController';
import { DatabaseService } from './DatabaseService';
import { FileSystemService } from './FileSystemService';
import { MeshService } from './MeshService';
import { LogFormatter } from './LogFormatter';
import { NodeRegistry } from './NodeRegistry';
import { RegistryService } from './RegistryService';
import { DriftLedgerService } from './DriftLedgerService';
import { parseEffectiveModel } from './preflight/effectiveModel';
import { deriveStackExposure } from './preflight/exposure';

import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';
import { describeSpawnError } from '../utils/spawnErrors';
import { isPathWithinBase, isValidStackName } from '../utils/validation';
import { authoredComposeFileArgs, authoredComposeEnvFileArgs } from '../utils/authoredComposeArgs';
import { parseMissingRequiredVars } from '../helpers/envVarParse';
import { redactSensitiveText, sanitizeForLog } from '../utils/safeLog';

export class ComposeRollbackError extends Error {
  public readonly rollbackAttempted: boolean;
  public readonly rolledBack: boolean;
  public readonly originalError: unknown;

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

const DEFAULT_COMPOSE_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

function getComposeCommandTimeoutMs(): number {
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
 * ComposeService - local docker compose CLI execution.
 *
 * In the Distributed API model, remote node compose operations are handled
 * by the remote Sencho instance. This service only executes commands locally.
 */
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
  private async authoredComposeArgs(stackName: string, action: string[]): Promise<string[]> {
    const args: string[] = ['compose'];
    const filePrefix = authoredComposeFileArgs(stackName, this.nodeId);
    args.push(...filePrefix);
    // Pin env resolution to the root .env when a context dir shifts the project
    // directory, so deploy/update resolve the same effective config the validator did.
    args.push(...await authoredComposeEnvFileArgs(stackName, this.nodeId));

    let overridePath: string | null = null;
    try {
      overridePath = await MeshService.getInstance().ensureStackOverride(this.nodeId, stackName);
    } catch (err) {
      console.warn('[ComposeService] mesh override skipped:', sanitizeForLog((err as Error).message));
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
    args.push(...action);
    return args;
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
    idleTimeoutMs?: number
  ): Promise<void> {
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

      const sendOutput = (text: string) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(text);
        }
      };

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
      };

      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        complete();
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

      const onData = (data: Buffer) => {
        const text = data.toString();
        errorLog += text;
        sendOutput(text);
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
          else if (throwOnError) reject(new Error(redactSensitiveText(errorLog.trim()) || `Command failed with code ${code}`));
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
    const registries = DatabaseService.getInstance().getRegistries();
    if (registries.length === 0) {
      return fn({
        ...process.env,
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      });
    }

    const { config, warnings } = await RegistryService.getInstance().resolveDockerConfig();
    if (warnings.length > 0 && sendOutput) {
      for (const warning of warnings) {
        sendOutput(`[Sencho] Warning: ${warning}\n`);
      }
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-docker-'));
    const configPath = path.join(tmpDir, 'config.json');

    try {
      fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
      return await fn({
        ...process.env,
        DOCKER_CONFIG: tmpDir,
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      });
    } finally {
      // Best-effort cleanup; each step runs independently so a file that was never
      // written (e.g., writeFileSync threw) does not prevent the directory removal.
      try { fs.unlinkSync(configPath); } catch { /* file may not exist */ }
      try { fs.rmdirSync(tmpDir); } catch (e) {
        console.warn('[ComposeService] Could not remove temp Docker config dir:', (e as Error).message);
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
    await this.execute('docker', await this.authoredComposeArgs(stackName, [action]), stackDir, ws);
  }

  /**
   * Opt-in guard: when `env_block_deploy_on_missing_required` is enabled, refuse a
   * deploy whose required `${VAR:?err}` variables are unset OR empty, before any
   * backup, cleanup, pull, or `up` runs. Compose's own resolution is authoritative
   * (it passes process.env), and on the failing path it emits no rendered model, so
   * no env value is materialized. Default off and any settings-read failure both
   * fall through without blocking.
   */
  private async assertRequiredEnvPresent(stackName: string): Promise<void> {
    let enabled = false;
    try {
      enabled = DatabaseService.getInstance().getGlobalSettings()['env_block_deploy_on_missing_required'] === '1';
    } catch {
      return; // safe default: a settings-read failure never blocks a deploy
    }
    if (!enabled) return;
    const result = await this.renderConfig(stackName);
    const missing = parseMissingRequiredVars(result.stderr);
    if (missing.length === 0) return;
    const plural = missing.length > 1;
    throw new Error(
      `Deploy blocked: required environment variable${plural ? 's' : ''} ${missing.join(', ')} ` +
      `${plural ? 'are' : 'is'} missing. Define ${plural ? 'them' : 'it'} in a .env or env_file, then deploy again.`,
    );
  }

  async deployStack(stackName: string, ws?: WebSocket, atomic?: boolean): Promise<void> {
    await this.assertRequiredEnvPresent(stackName);
    const stackDir = path.join(this.baseDir, stackName);
    const debug = isDebugEnabled();
    const t0 = Date.now();
    if (debug) console.debug('[ComposeService:debug] deployStack', { stackName, stackDir, atomic });
    const sendOutput = (data: string) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    };

    if (atomic) {
      await this.createAtomicBackup(stackName, 'deployment', sendOutput);
    }

    try {
      try {
        const dockerController = DockerController.getInstance(this.nodeId);
        const legacyContainers = await dockerController.getContainersByStack(stackName);
        if (legacyContainers && legacyContainers.length > 0) {
          sendOutput(`=== Cleaning up existing containers for clean deployment ===\n`);
          await dockerController.removeContainers(legacyContainers.map((c: any) => c.Id));
        }
      } catch (e) {
        console.warn('Failed to clean up legacy containers for %s:', sanitizeForLog(stackName), e);
      }

      await this.withRegistryAuth(async (env) => {
        await this.execute('docker', await this.authoredComposeArgs(stackName, ['up', '-d', '--remove-orphans']), stackDir, ws, true, env, getComposeStallTimeoutMs());
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
      if (debug) console.debug(`[ComposeService:debug] deployStack completed in ${Date.now() - t0}ms`, { stackName });
    } catch (deployError) {
      if (atomic) {
        sendOutput('\n=== Deployment failed - restoring previous compose and env files ===\n');
        const rolledBack = await this.restoreAtomicBackup(stackName, stackDir, ws, sendOutput);
        throw new ComposeRollbackError(deployError, true, rolledBack);
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
  }

  streamLogs(stackName: string, ws: WebSocket) {
    let isClosed = false;
    let isFirstRun = true;
    let isWaitingForActivity = false;

    ws.on('close', () => { isClosed = true; });

    const startStream = async () => {
      if (isClosed || ws.readyState !== WebSocket.OPEN) return;

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
          const containerName = container.Names?.[0]?.replace(/^\//, '') || container.Id;
          activeProcesses++;
          let lineBuffer = '';

          const sendOutput = (data: Buffer) => {
            if (ws.readyState === WebSocket.OPEN) {
              lineBuffer += data.toString();
              const lines = lineBuffer.split(/\r?\n/);
              lineBuffer = lines.pop() || '';
              for (const line of lines) {
                ws.send(LogFormatter.process(line) + '\r\n');
              }
            }
          };

          const flushBuffer = () => {
            if (lineBuffer && ws.readyState === WebSocket.OPEN) {
              ws.send(LogFormatter.process(lineBuffer) + '\r\n');
              lineBuffer = '';
            }
          };

          const child = spawn('docker', ['logs', '-f', '-t', '--tail', '100', containerName], {
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

  async updateStack(stackName: string, ws?: WebSocket, atomic?: boolean): Promise<void> {
    await this.assertRequiredEnvPresent(stackName);
    const stackDir = path.join(this.baseDir, stackName);
    const debug = isDebugEnabled();
    const t0 = Date.now();
    if (debug) console.debug('[ComposeService:debug] updateStack', { stackName, stackDir, atomic });
    const sendOutput = (data: string) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    };

    if (atomic) {
      await this.createAtomicBackup(stackName, 'update', sendOutput);
    }

    try {
      try {
        const dockerController = DockerController.getInstance(this.nodeId);
        const legacyContainers = await dockerController.getContainersByStack(stackName);
        if (legacyContainers && legacyContainers.length > 0) {
          sendOutput(`=== Cleaning up existing containers for clean update ===\n`);
          await dockerController.removeContainers(legacyContainers.map((c: any) => c.Id));
        }
      } catch (e) {
        console.warn('Failed to clean up legacy containers for %s:', sanitizeForLog(stackName), e);
      }

      await this.withRegistryAuth(async (env) => {
        sendOutput('=== Pulling latest images ===\n');
        await this.execute('docker', await this.authoredComposeArgs(stackName, ['pull']), stackDir, ws, true, env, getComposeStallTimeoutMs());

        sendOutput('=== Recreating containers ===\n');
        await this.execute('docker', await this.authoredComposeArgs(stackName, ['up', '-d', '--remove-orphans']), stackDir, ws, true, env, getComposeStallTimeoutMs());
      }, sendOutput);

      // Post-Update Health Probe
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

      sendOutput('=== Stack updated successfully ===\n');
      // Opt-out (default ON): after a clean update, prune the node's dangling
      // (untagged) image layers, including the one this pull just orphaned. Read
      // fresh each run so a remote node honors its own setting. Wrapped so a
      // prune failure can never reach the atomic-rollback catch below.
      try {
        const pruneOnUpdate = DatabaseService.getInstance().getGlobalSettings()['prune_on_update'] === '1';
        if (pruneOnUpdate) {
          const result = await DockerController.getInstance(this.nodeId).pruneDanglingImages();
          // The Docker prune API does not report SpaceReclaimed on the containerd
          // image store, so only show the figure when the daemon actually returns one.
          const reclaimed = result.reclaimedBytes > 0
            ? ` · reclaimed ${(result.reclaimedBytes / (1024 * 1024)).toFixed(1)} MB`
            : '';
          sendOutput(`=== Pruned dangling images${reclaimed} ===\n`);
        }
      } catch (pruneError) {
        console.warn('Failed to prune dangling images after update for %s:', sanitizeForLog(stackName), pruneError);
      }
      if (debug) console.debug(`[ComposeService:debug] updateStack completed in ${Date.now() - t0}ms`, { stackName });
    } catch (updateError) {
      if (atomic) {
        sendOutput('\n=== Update failed - restoring previous compose and env files ===\n');
        const rolledBack = await this.restoreAtomicBackup(stackName, stackDir, ws, sendOutput);
        throw new ComposeRollbackError(updateError, true, rolledBack);
      }
      throw updateError;
    }
    // Reached only on a successful update; re-baseline so temporal drift compares
    // against what is now deployed (see deployStack for why this lives here), then
    // reconcile the ledger against the updated runtime.
    await DriftLedgerService.getInstance().recordBaseline(this.nodeId, stackName);
    await DriftLedgerService.getInstance().reconcileStack(this.nodeId, stackName);
    try {
      await this.refreshExposureCache(stackName);
    } catch (err) {
      console.warn('[ComposeService] Exposure refresh failed after update for %s:',
        sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(err, 'unknown')));
    }
  }

  public async downStack(stackName: string): Promise<void> {
    const stackPath = path.join(this.baseDir, stackName);
    try {
      await this.execute('docker', await this.authoredComposeArgs(stackName, ['down', '--volumes', '--remove-orphans']), stackPath, undefined, false);
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
  public async listStackImages(stackName: string): Promise<string[]> {
    if (!isValidStackName(stackName)) {
      throw new Error('Invalid stack path');
    }
    const stackDir = path.resolve(this.baseDir, stackName);
    if (!isPathWithinBase(stackDir, this.baseDir) || path.resolve(this.baseDir) === stackDir) {
      throw new Error('Invalid stack path');
    }
    // Use the authored multi-file model (no mesh override) so override-only image
    // refs are scanned by the policy gate; single-file stacks get an empty prefix.
    const filePrefix = authoredComposeFileArgs(stackName, this.nodeId);
    const envFileArgs = await authoredComposeEnvFileArgs(stackName, this.nodeId);
    const stdout = await this.captureCompose([...filePrefix, ...envFileArgs, 'config', '--images'], stackDir);
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
   */
  public async renderConfig(
    stackName: string,
  ): Promise<{ rendered: string | null; stderr: string; code: number | null; timedOut: boolean }> {
    if (!isValidStackName(stackName)) {
      throw new Error('Invalid stack path');
    }
    // Canonical inline js/path-injection barrier, kept in the same scope as the
    // spawn cwd sink below. CodeQL credits neither the wrapped isPathWithinBase
    // helper nor a barrier separated from the sink by the Promise-executor
    // closure, so the spawn is hoisted out of the executor. startsWith already
    // rejects the base dir itself, since base does not start with base + sep.
    const baseResolved = path.resolve(this.baseDir);
    const stackDir = path.resolve(baseResolved, stackName);
    if (!stackDir.startsWith(baseResolved + path.sep)) {
      throw new Error('Invalid stack path');
    }
    // Render the authored multi-file model (no mesh override) so the Compose Doctor
    // sees every override file; single-file stacks get an empty prefix. The env-file
    // flag keeps render resolving the same root .env the validator and deploy use.
    let filePrefix: string[];
    try {
      filePrefix = authoredComposeFileArgs(stackName, this.nodeId);
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    const envFileArgs = await authoredComposeEnvFileArgs(stackName, this.nodeId);
    const child = spawn('docker', ['compose', ...filePrefix, ...envFileArgs, 'config', '--format', 'json'], {
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
      const finish = (result: { rendered: string | null; stderr: string; code: number | null; timedOut: boolean }) => {
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
        if (stderr.length < MAX_OUTPUT) stderr += data.toString();
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(describeSpawnError(err, { command: 'docker compose' }).message));
      });
      child.on('close', (code) => {
        if (timedOut) finish({ rendered: null, stderr: stderr.trim() || 'docker compose config timed out', code, timedOut: true });
        else if (capped) finish({ rendered: null, stderr: 'Rendered model exceeded the size limit', code, timedOut: false });
        else if (code === 0) finish({ rendered: stdout, stderr, code, timedOut: false });
        else finish({ rendered: null, stderr: stderr.trim() || `docker compose config failed with code ${code}`, code, timedOut: false });
      });
    });
  }
}
