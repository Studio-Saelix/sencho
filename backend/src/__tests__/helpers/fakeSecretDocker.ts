import { PassThrough } from 'stream';
import type Docker from 'dockerode';

/** One file the fake writer container left in a volume. */
export interface FakeSecretFile {
  content: string;
  uid: number;
  gid: number;
  mode: string;
}

/**
 * A Docker double for the sealed secret store: volumes with labels, the
 * helper image, and writer containers that run the store's write or remove
 * op against an in-memory file map. It reads the secret from the attached
 * stdin stream exactly as the real container would, so a test can assert the
 * value landed and that it never travelled anywhere else.
 */
export interface FakeSecretDocker {
  docker: Docker;
  volumes: Map<string, Record<string, string>>;
  /** Keyed `<volume>/<file>`. */
  files: Map<string, FakeSecretFile>;
  /** Every writer container's create options, in order. */
  createOptions: Docker.ContainerCreateOptions[];
  /** Volumes a container mounts (answers `listContainers` filtered by volume). */
  mounted: Set<string>;
  /** Exit codes the next writer runs return, in order (default 0). */
  exitCodes: number[];
  /** Number of writer containers started. */
  writerRuns(): number;
  /** Fail the volume inspect with this status, once. */
  failInspect: number | null;
}

export function createFakeSecretDocker(): FakeSecretDocker {
  const state: FakeSecretDocker = {
    docker: undefined as unknown as Docker,
    volumes: new Map(),
    files: new Map(),
    createOptions: [],
    mounted: new Set(),
    exitCodes: [],
    writerRuns: () => started,
    failInspect: null,
  };
  let started = 0;

  const createContainer = async (opts: Docker.ContainerCreateOptions) => {
    state.createOptions.push(opts);
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    const ended = new Promise<void>((resolve) => stream.once('end', () => resolve()));
    const cmd = (opts.Cmd ?? []) as string[];
    const [op, file, uid, gid, mode, max] = cmd.slice(4);
    const volume = opts.HostConfig?.Mounts?.[0]?.Source ?? '';
    return {
      attach: async () => stream,
      start: async () => { started += 1; },
      wait: async () => {
        if (!opts.OpenStdin) stream.end();
        await ended;
        const forced = state.exitCodes.shift();
        if (forced !== undefined && forced !== 0) return { StatusCode: forced };
        const key = `${volume}/${file}`;
        if (op === 'remove') {
          state.files.delete(key);
          return { StatusCode: 0 };
        }
        const content = Buffer.concat(chunks).toString('utf8');
        if (content.length === 0) return { StatusCode: 3 };
        if (Buffer.byteLength(content, 'utf8') > Number(max)) return { StatusCode: 4 };
        state.files.set(key, { content, uid: Number(uid), gid: Number(gid), mode });
        return { StatusCode: 0 };
      },
      remove: async () => undefined,
    };
  };

  const docker = {
    getImage: () => ({ inspect: async () => ({ Id: 'sha256:alpine' }) }),
    pull: () => undefined,
    getVolume: (name: string) => ({
      inspect: async () => {
        if (state.failInspect !== null) {
          const statusCode = state.failInspect;
          state.failInspect = null;
          throw Object.assign(new Error('inspect failed'), { statusCode });
        }
        const labels = state.volumes.get(name);
        if (!labels) throw Object.assign(new Error('no such volume'), { statusCode: 404 });
        return { Name: name, Labels: labels };
      },
    }),
    createVolume: async ({ Name, Labels }: { Name: string; Labels: Record<string, string> }) => {
      if (!state.volumes.has(Name)) state.volumes.set(Name, { ...Labels });
      return { Name };
    },
    listContainers: async (opts?: { filters?: { volume?: string[] } }) => {
      const wanted = opts?.filters?.volume ?? [];
      return wanted.some((name) => state.mounted.has(name)) ? [{ Id: 'consumer' }] : [];
    },
    createContainer,
    modem: {
      demuxStream: () => undefined,
      followProgress: () => undefined,
    },
  };
  state.docker = docker as unknown as Docker;
  return state;
}
