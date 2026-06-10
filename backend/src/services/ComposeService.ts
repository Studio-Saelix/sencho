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

import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';
import { describeSpawnError } from '../utils/spawnErrors';
import { isPathWithinBase, isValidStackName } from '../utils/validation';
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
   * Build the `docker compose` argument prefix for a stack, splicing in the
   * Sencho Mesh override file if the stack is opted into the mesh. When no
   * override applies, returns args without `-f` so docker compose's built-in
   * file discovery resolves the stack's actual compose filename. The user's
   * source compose file is never mutated.
   */
  private async composeArgs(stackName: string, action: string[]): Promise<string[]> {
    const args: string[] = ['compose'];
    let overridePath: string | null = null;
    try {
      overridePath = await MeshService.getInstance().ensureStackOverride(this.nodeId, stackName);
    } catch (err) {
      console.warn('[ComposeService] mesh override skipped:', sanitizeForLog((err as Error).message));
    }
    if (overridePath) {
      const baseFilename = await FileSystemService.getInstance(this.nodeId).getComposeFilename(stackName);
      args.push('-f', baseFilename, '-f', overridePath);
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
    env?: Record<string, string | undefined>
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

      // The progress socket is output-only: a deploy/update/down is owned by the
      // HTTP request that started it, so closing or losing the socket (the user
      // minimizes the panel, navigates away, or the connection blips) must not
      // terminate the compose process. Termination is driven solely by the
      // command timeout below.
      timeout = setTimeout(() => {
        const message = `Command timed out after ${Math.round(timeoutMs / 1000)}s`;
        sendOutput(`${message}\n`);
        terminateChild(new Error(message));
      }, timeoutMs);

      const onData = (data: Buffer) => {
        const text = data.toString();
        errorLog += text;
        sendOutput(text);
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
        await this.execute('docker', await this.composeArgs(stackName, ['up', '-d', '--remove-orphans']), stackDir, ws, true, env);
      }, sendOutput);
      sendOutput('=== Rolled back successfully ===\n');
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
    await this.execute('docker', ['compose', action], stackDir, ws);
  }

  async deployStack(stackName: string, ws?: WebSocket, atomic?: boolean): Promise<void> {
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
        await this.execute('docker', await this.composeArgs(stackName, ['up', '-d', '--remove-orphans']), stackDir, ws, true, env);
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
        sendOutput('\n=== Deployment failed - rolling back to previous version ===\n');
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
        await this.execute('docker', ['compose', 'pull'], stackDir, ws, true, env);

        sendOutput('=== Recreating containers ===\n');
        await this.execute('docker', await this.composeArgs(stackName, ['up', '-d', '--remove-orphans']), stackDir, ws, true, env);
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
        sendOutput('\n=== Update failed - rolling back to previous version ===\n');
        const rolledBack = await this.restoreAtomicBackup(stackName, stackDir, ws, sendOutput);
        throw new ComposeRollbackError(updateError, true, rolledBack);
      }
      throw updateError;
    }
    // Reached only on a successful update; re-baseline so temporal drift compares
    // against what is now deployed (see deployStack for why this lives here).
    await DriftLedgerService.getInstance().recordBaseline(this.nodeId, stackName);
  }

  public async downStack(stackName: string): Promise<void> {
    const stackPath = path.join(this.baseDir, stackName);
    try {
      await this.execute('docker', ['compose', 'down', '--volumes', '--remove-orphans'], stackPath, undefined, false);
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
    const stdout = await this.captureCompose(['config', '--images'], stackDir);
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
  public renderConfig(
    stackName: string,
  ): Promise<{ rendered: string | null; stderr: string; code: number | null; timedOut: boolean }> {
    if (!isValidStackName(stackName)) {
      return Promise.reject(new Error('Invalid stack path'));
    }
    const stackDir = path.resolve(this.baseDir, stackName);
    if (!isPathWithinBase(stackDir, this.baseDir) || path.resolve(this.baseDir) === stackDir) {
      return Promise.reject(new Error('Invalid stack path'));
    }
    return new Promise((resolve, reject) => {
      const child = spawn('docker', ['compose', 'config', '--format', 'json'], {
        cwd: stackDir,
        env: {
          ...process.env,
          PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        },
      });
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
