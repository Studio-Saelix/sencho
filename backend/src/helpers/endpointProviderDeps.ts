/**
 * The real dependencies of the Docker endpoint replacement helper: Dockerode
 * through the provider's host socket, the Compose CLI, and the handoff files.
 * Kept separate from the entrypoint so the wiring (including handoff ownership)
 * is unit-testable without starting the helper process.
 */
import { execFile } from 'child_process';
import fs from 'fs/promises';
import Docker from 'dockerode';
import {
  HELPER_SOCKET_PATH,
  errorText,
  type ContainerSnapshot,
  type HelperDeps,
  type ProviderReplacePlan,
} from './endpointProviderReplace';
import { createHandoffWriter, handoffOwner, type HandoffFileSystem } from './handoffFile';

export function buildDeps(
  plan: ProviderReplacePlan,
  logFile: string | null,
  handoffFs: HandoffFileSystem = fs,
  helperUid: number | null = typeof process.getuid === 'function' ? process.getuid() : null,
): HelperDeps {
  const docker = new Docker({ socketPath: HELPER_SOCKET_PATH });
  // The project name is passed explicitly: a project deployed under a name
  // other than its directory would otherwise be rendered as a new project and
  // get a second proxy instead of the replacement.
  const projectFlags = ['-p', plan.project, ...plan.configFiles.flatMap(file => ['-f', file])];
  // The helper runs as root; hand the files it publishes to the application
  // uid so a Sencho running as SENCHO_USER can read the phase marker and
  // outcome. Every handoff JSON file, including the rollback snapshot, stays
  // 0600 and is owned by that user.
  const writeJson = createHandoffWriter(process.env, helperUid, handoffFs);
  const deps: HelperDeps = {
    docker: {
      ping: async () => { await docker.ping(); },
      inspect: async (id) => {
        try {
          return await docker.getContainer(id).inspect() as unknown as ContainerSnapshot;
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode === 404) return null;
          throw error;
        }
      },
      serviceContainers: async (project, service) => {
        const found = await docker.listContainers({
          all: true,
          filters: { label: [`com.docker.compose.project=${project}`, `com.docker.compose.service=${service}`] },
        });
        return found.map(container => container.Id);
      },
      remove: async (id) => { await docker.getContainer(id).remove({ force: true }); },
      create: async (options) => (await docker.createContainer(options as Docker.ContainerCreateOptions)).id,
      connect: async (network, id, endpoint) => {
        await docker.getNetwork(network).connect({ Container: id, EndpointConfig: endpoint });
      },
      start: async (id) => { await docker.getContainer(id).start(); },
      pruneDanglingImages: async () => { await docker.pruneImages({ filters: { dangling: ['true'] } }); },
    },
    compose: (args) => new Promise(resolve => {
      execFile('docker', ['compose', ...projectFlags, ...args], {
        cwd: plan.workingDir,
        env: { ...process.env, DOCKER_HOST: `unix://${HELPER_SOCKET_PATH}` },
        timeout: 10 * 60_000,
        maxBuffer: 20 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        resolve({ ok: !error, output: error ? `${stderr}`.trim() || errorText(error) : `${stdout}` });
      });
    }),
    readJson: async (path) => {
      try {
        return JSON.parse(await fs.readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    writeJson,
    removeFile: (path) => fs.rm(path, { force: true }),
    copyFile: (from, to) => fs.copyFile(from, to),
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: (message) => {
      const line = `${new Date().toISOString()} ${message}\n`;
      process.stderr.write(line);
      if (logFile) void fs.appendFile(logFile, line).catch(() => undefined);
    },
  };
  if (!handoffOwner(process.env, helperUid) && helperUid === 0) {
    deps.log('handoff files will be root-owned: no usable SENCHO_HANDOFF_UID/GID was passed, so a non-root Sencho cannot read them');
  }
  return deps;
}
