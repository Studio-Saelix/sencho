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
  /** Writer containers a crashed run left behind (answer the helper-label list). */
  leftoverWriters: Array<{ Id: string; volume: string }>;
  /** Ids of containers removed through `getContainer(id).remove`. */
  removedContainers: string[];
  /** Number of writer containers removed after their run. */
  writerRemovals(): number;
  /** When set, the next writer's `wait` waits on this promise first (a slow or hung helper). */
  holdNextWait: Promise<void> | null;
  /** When set, the next writer's attach stream emits this error after start. */
  streamErrorNext: Error | null;
  /** Called after every `listVolumes` answer is taken, before it is returned: a concurrent operation landing right after a listing. */
  afterListVolumes: (() => Promise<void>) | null;
  /** Names of volumes removed through `getVolume(name).remove` or `pruneVolumes`. */
  removedVolumes: string[];
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
    leftoverWriters: [],
    removedContainers: [],
    writerRemovals: () => removals,
    holdNextWait: null,
    streamErrorNext: null,
    afterListVolumes: null,
    removedVolumes: [],
  };
  // A volume is unused when no container mounts it, as the daemon's `dangling` filter and prune read it.
  const unusedVolumes = () => [...state.volumes.entries()]
    .filter(([name]) => !state.mounted.has(name))
    .map(([Name, Labels]) => ({ Name, Labels, Driver: 'local', Options: null }));
  let started = 0;
  let removals = 0;

  const createContainer = async (opts: Docker.ContainerCreateOptions) => {
    state.createOptions.push(opts);
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    const ended = new Promise<void>((resolve) => {
      stream.once('end', () => resolve());
      stream.once('close', () => resolve());
    });
    const cmd = (opts.Cmd ?? []) as string[];
    const [op, file, uid, gid, mode, max] = cmd.slice(4);
    const mount = opts.HostConfig?.Mounts?.[0];
    const volume = mount?.Source ?? '';
    // Docker creates a missing named volume on container create, with the
    // mount's volume labels.
    if (volume && !state.volumes.has(volume)) state.volumes.set(volume, { ...(mount?.VolumeOptions?.Labels ?? {}) });
    const hold = state.holdNextWait;
    state.holdNextWait = null;
    const streamError = state.streamErrorNext;
    state.streamErrorNext = null;
    return {
      attach: async () => stream,
      start: async () => {
        started += 1;
        if (streamError) stream.destroy(streamError);
      },
      wait: async () => {
        if (hold) await hold;
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
      remove: async () => { removals += 1; },
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
      remove: async () => {
        if (!state.volumes.has(name)) throw Object.assign(new Error('no such volume'), { statusCode: 404 });
        if (state.mounted.has(name)) throw Object.assign(new Error('volume is in use'), { statusCode: 409 });
        state.volumes.delete(name);
        for (const key of [...state.files.keys()]) if (key.startsWith(`${name}/`)) state.files.delete(key);
        state.removedVolumes.push(name);
      },
    }),
    listVolumes: async (opts?: { filters?: { dangling?: string[]; label?: string[] } }) => {
      let volumes = opts?.filters?.dangling?.includes('true')
        ? unusedVolumes()
        : [...state.volumes.entries()].map(([Name, Labels]) => ({ Name, Labels, Driver: 'local', Options: null }));
      const label = opts?.filters?.label ?? [];
      if (label.length > 0) volumes = volumes.filter((volume) => label.every((key) => Object.prototype.hasOwnProperty.call(volume.Labels, key)));
      const answer = { Volumes: volumes };
      if (state.afterListVolumes) await state.afterListVolumes();
      return answer;
    },
    // The daemon prune: every unused volume, kept only when it carries every `label!` key.
    pruneVolumes: async (opts?: { filters?: { 'label!'?: string[] } }) => {
      const keep = opts?.filters?.['label!'] ?? [];
      for (const { Name, Labels } of unusedVolumes()) {
        if (keep.length > 0 && keep.every((key) => Object.prototype.hasOwnProperty.call(Labels, key))) continue;
        state.volumes.delete(Name);
        for (const key of [...state.files.keys()]) if (key.startsWith(`${Name}/`)) state.files.delete(key);
        state.removedVolumes.push(Name);
      }
      return { SpaceReclaimed: 0 };
    },
    createVolume: async ({ Name, Labels }: { Name: string; Labels: Record<string, string> }) => {
      if (!state.volumes.has(Name)) state.volumes.set(Name, { ...Labels });
      return { Name };
    },
    listContainers: async (opts?: { filters?: { volume?: string[]; label?: string[] } }) => {
      const wanted = opts?.filters?.volume ?? [];
      if (opts?.filters?.label?.includes('io.sencho.helper=secret-writer')) {
        return state.leftoverWriters.filter((writer) => wanted.length === 0 || wanted.includes(writer.volume)).map(({ Id }) => ({ Id }));
      }
      const consumers = wanted.some((name) => state.mounted.has(name)) ? [{ Id: 'consumer' }] : [];
      // A leftover writer mounts its volume too, exactly as Docker would report it.
      const leftovers = state.leftoverWriters.filter((writer) => wanted.includes(writer.volume)).map(({ Id }) => ({ Id }));
      return [...consumers, ...leftovers];
    },
    getContainer: (id: string) => ({
      remove: async () => {
        state.removedContainers.push(id);
        state.leftoverWriters = state.leftoverWriters.filter((writer) => writer.Id !== id);
      },
    }),
    createContainer,
    modem: {
      demuxStream: () => undefined,
      followProgress: () => undefined,
    },
  };
  state.docker = docker as unknown as Docker;
  return state;
}
