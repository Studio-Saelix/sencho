/**
 * Entry point of the Docker endpoint replacement helper container:
 * `node dist/endpointProviderHelper.js <stage|replace> <operationId>`.
 * It loads only Dockerode and the helper module, never the Sencho app.
 * See helpers/endpointProviderReplace.ts for the sequence.
 */
import { execFile } from 'child_process';
import fs from 'fs/promises';
import Docker from 'dockerode';
import {
  HELPER_DATA_DIR,
  HELPER_SOCKET_PATH,
  errorText,
  helperFiles,
  replaceProvider,
  stageProviderReplacement,
  type ContainerSnapshot,
  type HelperDeps,
  type ProviderReplacePlan,
} from './helpers/endpointProviderReplace';

const OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function buildDeps(plan: ProviderReplacePlan, logFile: string | null): HelperDeps {
  const docker = new Docker({ socketPath: HELPER_SOCKET_PATH });
  const fFlags = plan.configFiles.flatMap(file => ['-f', file]);
  return {
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
      execFile('docker', ['compose', ...fFlags, ...args], {
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
    writeJson: async (path, value) => {
      const temporary = `${path}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await fs.rename(temporary, path);
    },
    copyFile: (from, to) => fs.copyFile(from, to),
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: (message) => {
      const line = `${new Date().toISOString()} ${message}\n`;
      process.stderr.write(line);
      if (logFile) void fs.appendFile(logFile, line).catch(() => undefined);
    },
  };
}

async function main(): Promise<number> {
  const [mode, operationId] = process.argv.slice(2);
  if ((mode !== 'stage' && mode !== 'replace') || !operationId || !OPERATION_ID_RE.test(operationId)) {
    process.stdout.write(JSON.stringify({ ok: false, message: 'Usage: endpointProviderHelper <stage|replace> <operationId>' }));
    return 2;
  }
  const plan = JSON.parse(await fs.readFile(helperFiles.plan(HELPER_DATA_DIR, operationId), 'utf8')) as ProviderReplacePlan;
  if (mode === 'stage') {
    const result = await stageProviderReplacement(plan, buildDeps(plan, null));
    process.stdout.write(JSON.stringify(result));
    return result.ok ? 0 : 1;
  }
  const deps = buildDeps(plan, helperFiles.log(HELPER_DATA_DIR, operationId));
  try {
    const outcome = await replaceProvider(plan, deps);
    return outcome.ok ? 0 : 1;
  } catch (error) {
    // An unexpected throw leaves the endpoint in an unknown state: record that
    // instead of letting Sencho wait out its deadline for a verdict.
    deps.log(`helper failed: ${errorText(error)}`);
    await deps.writeJson(helperFiles.outcome(HELPER_DATA_DIR, operationId), {
      operationId,
      ok: false,
      phase: 'provider',
      error: `The replacement helper stopped unexpectedly: ${errorText(error)}`,
      rollback: { restored: false, error: 'not attempted' },
    });
    return 1;
  }
}

main().then(code => process.exit(code)).catch(error => {
  process.stdout.write(JSON.stringify({ ok: false, message: errorText(error) }));
  process.exit(1);
});
