import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import * as YAML from 'yaml';
import { isValidRelativeStackPath } from '../../../utils/validation';

/** Compose layer written inside the overlay and removed with it. */
export const BIND_REMAP_FILENAME = '.sencho-bind-remap.yml';

export const PERSISTENT_BIND_REFUSAL =
  'Deploy blocked: a mount covers both a decrypted secret and persistent data, so Sencho cannot keep the secret decrypted without placing the data in a temporary directory. Move the secret file out of that mount, then retry.';

export const PERSISTENT_BIND_UNSAFE =
  'Deploy blocked: Sencho could not keep a persistent mount on the stack directory while decrypting repository secrets. The deploy was not started.';

export type BindRemapPlan =
  | { action: 'skip' }
  | { action: 'refuse'; reason: string }
  | { action: 'rewrite'; file: string };

type RemapContext = {
  overlayRoot: string;
  liveRoot: string;
  /** Compose directory the stack sits in; the tree a live deploy can read. */
  liveComposeRoot: string;
  overlayProjectDir: string;
  liveProjectDir: string;
  secretsRoot: string;
  decryptedRelPaths: string[];
};

type Relocation =
  | { action: 'skip' }
  | { action: 'move'; live: string }
  | { action: 'refuse'; reason: string };

type OverlayModelRead =
  | { status: 'ok'; json: string }
  | { status: 'failed' }
  | { status: 'unusable' };

function isInside(child: string, parent: string): boolean {
  const base = path.resolve(parent);
  const target = path.resolve(child);
  return target === base || target.startsWith(base + path.sep);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Relative paths decrypted into this overlay. A missing metadata file means
 * none were recorded. A file that omits the list is unusable: treating it as
 * empty would move a decrypted secret file onto the live tree.
 */
export function readDecryptedRelPaths(overlayDir: string, secretsRoot: string): string[] {
  const overlay = path.resolve(overlayDir);
  const root = path.resolve(secretsRoot);
  if (!overlay.startsWith(root + path.sep)) return [];
  const metaPath = path.resolve(overlay, '.sencho-overlay.json');
  if (!metaPath.startsWith(overlay + path.sep)) throw new Error(PERSISTENT_BIND_UNSAFE);
  if (!fs.existsSync(metaPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    throw new Error(PERSISTENT_BIND_UNSAFE);
  }
  const raw = asRecord(parsed)?.decryptedRelPaths;
  if (raw === undefined || !Array.isArray(raw)) throw new Error(PERSISTENT_BIND_UNSAFE);
  const paths: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !isValidRelativeStackPath(entry) || entry === '') {
      throw new Error(PERSISTENT_BIND_UNSAFE);
    }
    const secret = path.resolve(overlay, entry);
    if (!secret.startsWith(overlay + path.sep)) throw new Error(PERSISTENT_BIND_UNSAFE);
    paths.push(entry);
  }
  return paths;
}

function secretRelation(source: string, overlayRoot: string, decryptedRelPaths: string[]): 'exact' | 'contains' | 'none' {
  const resolved = path.resolve(source);
  const root = path.resolve(overlayRoot);
  for (const rel of decryptedRelPaths) {
    const secret = path.resolve(root, rel);
    if (!secret.startsWith(root + path.sep)) continue;
    if (resolved === secret) return 'exact';
    if (secret.startsWith(resolved + path.sep)) return 'contains';
  }
  return 'none';
}

/** Leading Windows drive (`C:\` or `C:/`), which Compose resolves on its own. */
const WIN_DRIVE = /^[A-Za-z]:[\\/]/;

/**
 * A source Compose resolves against the project directory, so the same source
 * resolves somewhere else when the project directory moves to an overlay.
 * Absolute paths, `~` paths, and Windows drive paths are resolved by Compose on
 * their own terms and mean the same thing in either tree.
 */
function isProjectRelativeSource(source: string): boolean {
  return !path.isAbsolute(source) && !source.startsWith('~') && !WIN_DRIVE.test(source);
}

function relocate(source: string, ctx: RemapContext): Relocation {
  // The render is read with `--no-path-resolution`, so a relative source
  // arrives in its authored form and the depth it climbs is still visible.
  // Resolving it against the overlay's project directory gives the path this
  // run would use; the same source against the live project directory gives
  // the path the stack would use without the overlay, at every parent depth.
  const resolved = path.resolve(ctx.overlayProjectDir, source);
  const relation = secretRelation(resolved, ctx.overlayRoot, ctx.decryptedRelPaths);
  if (relation === 'exact') return { action: 'skip' };
  if (relation === 'contains') return { action: 'refuse', reason: PERSISTENT_BIND_REFUSAL };

  if (isProjectRelativeSource(source)) {
    // Two places a relative source can resolve to are decidable. Sencho's own
    // secrets area holds this run's temporary copy, so the source moves with
    // the project. The live compose tree holds a path the live deploy reads as
    // well, because Compose rebased it from an include that was already
    // absolute; that path is already the live one and stays where it is. A
    // relative source that lands anywhere else cannot be told apart from an
    // authored climb that escaped both, and mounting it would put the data
    // somewhere the stack never named, so it refuses instead.
    const inOverlayArea = isInside(resolved, ctx.secretsRoot);
    if (!inOverlayArea && isInside(resolved, ctx.liveComposeRoot)) return { action: 'skip' };
    if (!inOverlayArea) return { action: 'refuse', reason: PERSISTENT_BIND_UNSAFE };
    const live = path.resolve(ctx.liveProjectDir, source);
    if (isInside(live, ctx.secretsRoot)) return { action: 'refuse', reason: PERSISTENT_BIND_UNSAFE };
    return { action: 'move', live };
  }

  // A path Compose resolves on its own. Only a path inside this overlay's own
  // tree is temporary; anywhere else it names the path the file declared.
  const overlayStackDir = path.dirname(path.resolve(ctx.overlayRoot));
  if (!isInside(source, overlayStackDir)) return { action: 'skip' };
  const live = path.resolve(ctx.liveProjectDir, path.relative(ctx.overlayProjectDir, resolved));
  if (isInside(live, ctx.secretsRoot)) return { action: 'refuse', reason: PERSISTENT_BIND_UNSAFE };
  if (path.resolve(live) === resolved) return { action: 'skip' };
  return { action: 'move', live };
}

function bindSource(volume: unknown): string | null {
  const record = asRecord(volume);
  if (!record || record.type !== 'bind' || typeof record.source !== 'string') return null;
  return record.source;
}

/** Top-level volume devices, by volume key. Absent for anything else. */
function volumeDevices(volumes: unknown): Map<string, string> {
  const devices = new Map<string, string>();
  for (const [name, entry] of Object.entries(asRecord(volumes) ?? {})) {
    const device = asRecord(asRecord(entry)?.driver_opts)?.device;
    if (typeof device === 'string' && device !== '') devices.set(name, device);
  }
  return devices;
}

function rewriteServiceVolumes(
  volumes: unknown[],
  ctx: RemapContext,
): { volumes: unknown[] } | { error: string } {
  const rewritten: unknown[] = [];
  for (const volume of volumes) {
    const source = bindSource(volume);
    if (!source) continue;
    const decision = relocate(source, ctx);
    if (decision.action === 'refuse') return { error: decision.reason };
    if (decision.action === 'move') rewritten.push({ ...asRecord(volume), source: decision.live });
  }
  return { volumes: rewritten };
}

/**
 * Named volumes whose local driver binds a host directory carry that path in
 * top-level `volumes.*.driver_opts.device`, not in a service mount, so a
 * relative device follows the overlay exactly like a relative service mount
 * does and has to move with it.
 *
 * Which devices Compose treats as a host path is Compose's own question, and
 * its answer is narrow: only the local bind form is resolved against the
 * project directory, while every other driver form keeps the value as authored
 * (an `nfs` or `cifs` device is a remote export, never a host path). Rather
 * than restate that rule here, `resolvedDevices` carries what the same model
 * reports with path resolution on: a device that comes back absolute while the
 * authored one is project-relative is the one Compose moved with the project.
 * Everything else is passed through unchanged in both trees and stays as it is.
 *
 * The live path is written as an absolute device on the volume key: Compose
 * merges `driver_opts` per key, so the declared `type` and `o` survive the
 * override.
 *
 * A device that resolves into the decrypt area is refused rather than left
 * there. The backing files are removed with the overlay, so a volume created
 * against them keeps a deleted path. That covers a decrypted secret file in
 * the device path as well, which a service mount may still read directly.
 */
function rewriteVolumeDevices(
  volumes: unknown,
  resolvedDevices: Map<string, string>,
  ctx: RemapContext,
): { entries: Record<string, unknown> } | { error: string } {
  const entries: Record<string, unknown> = {};
  for (const [name, device] of volumeDevices(volumes)) {
    const resolved = resolvedDevices.get(name);
    if (!resolved || !path.isAbsolute(resolved) || !isProjectRelativeSource(device)) continue;
    const overlayDevice = path.resolve(ctx.overlayProjectDir, device);
    if (secretRelation(overlayDevice, ctx.overlayRoot, ctx.decryptedRelPaths) !== 'none') {
      return { error: PERSISTENT_BIND_REFUSAL };
    }
    const decision = relocate(device, ctx);
    if (decision.action === 'refuse') return { error: decision.reason };
    if (decision.action === 'move') entries[name] = { driver_opts: { device: decision.live } };
  }
  return { entries };
}

function flagValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) return args[i + 1];
  }
  return undefined;
}

export function resolveOverlayProjectDir(composeArgs: string[], overlayRoot: string): string {
  const explicit = flagValue(composeArgs, '--project-directory');
  if (explicit) return path.resolve(overlayRoot, explicit);
  const file = flagValue(composeArgs, '-f') ?? flagValue(composeArgs, '--file');
  if (file) return path.dirname(path.resolve(overlayRoot, file));
  return path.resolve(overlayRoot);
}

function remapContext(
  composeArgs: string[],
  overlayRoot: string,
  liveRoot: string,
  liveComposeRoot: string,
  secretsRoot: string,
  decryptedRelPaths: string[],
): RemapContext | { error: string } {
  const overlayProjectDir = resolveOverlayProjectDir(composeArgs, overlayRoot);
  if (!isInside(overlayProjectDir, overlayRoot)) return { error: PERSISTENT_BIND_UNSAFE };
  const liveProjectDir = path.resolve(liveRoot, path.relative(overlayRoot, overlayProjectDir));
  if (!isInside(liveProjectDir, liveRoot)) return { error: PERSISTENT_BIND_UNSAFE };
  return {
    overlayRoot,
    liveRoot,
    liveComposeRoot: path.resolve(liveComposeRoot),
    overlayProjectDir,
    liveProjectDir,
    secretsRoot,
    decryptedRelPaths,
  };
}

/**
 * Pure decision: which host paths must move onto the live stack before Compose
 * runs. `resolvedDevices` is the same model's volume devices with path
 * resolution on; the planner always supplies it, empty when the model declares
 * no device, so a caller cannot silently skip the device rewrite.
 */
export function remapPersistentBindModel(
  rendered: unknown,
  ctx: RemapContext,
  resolvedDevices: Map<string, string>,
): { ok: true; override: Record<string, unknown> | null } | { ok: false; reason: string } {
  const doc = asRecord(rendered);
  if (!doc) return { ok: false, reason: PERSISTENT_BIND_UNSAFE };
  const services: Record<string, unknown> = {};
  for (const [name, service] of Object.entries(asRecord(doc.services) ?? {})) {
    const volumes = asRecord(service)?.volumes;
    if (!Array.isArray(volumes)) continue;
    const rewritten = rewriteServiceVolumes(volumes, ctx);
    if ('error' in rewritten) return { ok: false, reason: rewritten.error };
    if (rewritten.volumes.length > 0) services[name] = { volumes: rewritten.volumes };
  }
  const devices = rewriteVolumeDevices(doc.volumes, resolvedDevices, ctx);
  if ('error' in devices) return { ok: false, reason: devices.error };
  const override: Record<string, unknown> = {};
  if (Object.keys(services).length > 0) override.services = services;
  if (Object.keys(devices.entries).length > 0) override.volumes = devices.entries;
  if (Object.keys(override).length === 0) return { ok: true, override: null };
  return { ok: true, override };
}

async function writeRemapFile(overlayDir: string, secretsRoot: string, yaml: string): Promise<string> {
  const overlay = path.resolve(overlayDir);
  const root = path.resolve(secretsRoot);
  if (!overlay.startsWith(root + path.sep)) throw new Error(PERSISTENT_BIND_UNSAFE);
  const target = path.resolve(overlay, BIND_REMAP_FILENAME);
  if (!target.startsWith(overlay + path.sep)) throw new Error(PERSISTENT_BIND_UNSAFE);
  await fs.promises.rm(target, { force: true });
  await fs.promises.writeFile(target, yaml, { mode: 0o600 });
  return target;
}

/**
 * Render the overlay's model for the remap.
 *
 * The authored read uses `--no-path-resolution` so the model stays in the form
 * the compose files declare: a relative source stays relative instead of
 * arriving as a Compose-resolved absolute path. That is what makes the bind
 * decision sound. A resolved render hides a `../..` climb behind an absolute
 * path that cannot be told apart from an authored absolute one, and it resolves
 * through the overlay's own symlinks, so a relocated data directory would
 * answer with a physical path the lexical comparison does not recognize as the
 * overlay's.
 *
 * The resolved read is asked only for volume devices, where the question is
 * not "where does this relative path point" but "did Compose move this value
 * at all". Answering it from Compose keeps the rule in one place instead of
 * restating which driver forms Compose resolves.
 */
function readModel(
  overlayDir: string,
  secretsRoot: string,
  composeArgs: string[],
  mode: 'authored' | 'resolved',
): Promise<OverlayModelRead> {
  const overlay = path.resolve(overlayDir);
  const root = path.resolve(secretsRoot);
  if (!overlay.startsWith(root + path.sep)) return Promise.resolve({ status: 'unusable' });
  const flags = mode === 'authored' ? ['--no-path-resolution'] : [];
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...composeArgs, 'config', '--format', 'json', ...flags], {
      cwd: overlay,
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      },
    });
    const MAX_OUTPUT = 5 * 1024 * 1024;
    let stdout = '';
    let capped = false;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 20_000);
    const finish = (result: OverlayModelRead) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (stdout.length > MAX_OUTPUT && !capped) {
        capped = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', () => {
      // Discarded. Compose quotes decrypted values into this stream.
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timedOut || capped) finish({ status: 'unusable' });
      else if (code === 0 && stdout.trim()) finish({ status: 'ok', json: stdout });
      else if (code === 0) finish({ status: 'unusable' });
      else finish({ status: 'failed' });
    });
  });
}

/**
 * Render the overlay once, then write a compose layer that points ordinary
 * persistent storage at the live stack: service bind mounts, and named volumes
 * whose local driver binds a host directory. A failed render is skipped for a
 * read, so that command can report the real Compose failure. A command that
 * would start containers refuses instead: skipping there would let `up` mount
 * the overlay copies. A render we cannot trust always refuses.
 */
export async function planPersistentBindRemap(args: {
  overlayDir: string;
  liveRoot: string;
  liveComposeRoot: string;
  secretsRoot: string;
  composeArgs: string[];
  refuseIfUnreadable?: boolean;
}): Promise<BindRemapPlan> {
  const read = await readModel(args.overlayDir, args.secretsRoot, args.composeArgs, 'authored');
  if (read.status === 'failed') {
    return args.refuseIfUnreadable
      ? { action: 'refuse', reason: PERSISTENT_BIND_UNSAFE }
      : { action: 'skip' };
  }
  if (read.status === 'unusable') return { action: 'refuse', reason: PERSISTENT_BIND_UNSAFE };
  let rendered: unknown;
  try {
    rendered = JSON.parse(read.json);
  } catch {
    return { action: 'refuse', reason: PERSISTENT_BIND_UNSAFE };
  }
  const resolvedDevices = await readResolvedVolumeDevices(args, rendered);
  if (resolvedDevices === null) {
    return args.refuseIfUnreadable
      ? { action: 'refuse', reason: PERSISTENT_BIND_UNSAFE }
      : { action: 'skip' };
  }
  const decryptedRelPaths = readDecryptedRelPaths(args.overlayDir, args.secretsRoot);
  const ctx = remapContext(
    args.composeArgs,
    path.resolve(args.overlayDir),
    path.resolve(args.liveRoot),
    path.resolve(args.liveComposeRoot),
    path.resolve(args.secretsRoot),
    decryptedRelPaths,
  );
  if ('error' in ctx) return { action: 'refuse', reason: ctx.error };
  const decision = remapPersistentBindModel(rendered, ctx, resolvedDevices);
  if (!decision.ok) return { action: 'refuse', reason: decision.reason };
  if (!decision.override) return { action: 'skip' };
  const file = await writeRemapFile(args.overlayDir, args.secretsRoot, YAML.stringify(decision.override));
  return { action: 'rewrite', file };
}

/**
 * What each top-level volume device looks like once Compose has resolved paths,
 * or `null` when that could not be read. The second render runs only for a
 * model that declares a device, which is what keeps the common case at one
 * Compose invocation. A model with no device has nothing to resolve.
 */
async function readResolvedVolumeDevices(
  args: { overlayDir: string; secretsRoot: string; composeArgs: string[] },
  authored: unknown,
): Promise<Map<string, string> | null> {
  if (volumeDevices(asRecord(authored)?.volumes).size === 0) return new Map();
  const read = await readModel(args.overlayDir, args.secretsRoot, args.composeArgs, 'resolved');
  if (read.status !== 'ok') return null;
  try {
    return volumeDevices(asRecord(JSON.parse(read.json))?.volumes);
  } catch {
    return null;
  }
}
