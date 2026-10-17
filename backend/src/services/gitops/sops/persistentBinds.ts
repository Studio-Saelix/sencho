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

function relocate(source: string, ctx: RemapContext): Relocation {
  // Only paths Compose resolved inside this overlay's stack tree are ephemeral.
  // An absolute bind elsewhere under the secrets root is the path the file named.
  const overlayStackDir = path.dirname(path.resolve(ctx.overlayRoot));
  if (!isInside(source, overlayStackDir)) return { action: 'skip' };
  const relation = secretRelation(source, ctx.overlayRoot, ctx.decryptedRelPaths);
  if (relation === 'exact') return { action: 'skip' };
  if (relation === 'contains') return { action: 'refuse', reason: PERSISTENT_BIND_REFUSAL };
  const live = path.resolve(ctx.liveProjectDir, path.relative(ctx.overlayProjectDir, path.resolve(source)));
  if (isInside(live, ctx.secretsRoot)) return { action: 'refuse', reason: PERSISTENT_BIND_UNSAFE };
  if (path.resolve(live) === path.resolve(source)) return { action: 'skip' };
  return { action: 'move', live };
}

function bindSource(volume: unknown): string | null {
  const record = asRecord(volume);
  if (!record || record.type !== 'bind' || typeof record.source !== 'string') return null;
  return record.source;
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
    overlayProjectDir,
    liveProjectDir,
    secretsRoot,
    decryptedRelPaths,
  };
}

/** Pure decision: which host paths must move onto the live stack before Compose runs. */
export function remapPersistentBindModel(
  rendered: unknown,
  ctx: RemapContext,
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
  if (Object.keys(services).length === 0) return { ok: true, override: null };
  return { ok: true, override: { services } };
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

function readModel(overlayDir: string, secretsRoot: string, composeArgs: string[]): Promise<OverlayModelRead> {
  const overlay = path.resolve(overlayDir);
  const root = path.resolve(secretsRoot);
  if (!overlay.startsWith(root + path.sep)) return Promise.resolve({ status: 'unusable' });
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...composeArgs, 'config', '--format', 'json'], {
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
 * persistent mounts at the live stack. A failed render is skipped for a read,
 * so that command can report the real Compose failure. A command that would
 * start containers refuses instead: skipping there would let `up` mount the
 * overlay copies. A render we cannot trust always refuses.
 */
export async function planPersistentBindRemap(args: {
  overlayDir: string;
  liveRoot: string;
  secretsRoot: string;
  composeArgs: string[];
  refuseIfUnreadable?: boolean;
}): Promise<BindRemapPlan> {
  const read = await readModel(args.overlayDir, args.secretsRoot, args.composeArgs);
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
  const decryptedRelPaths = readDecryptedRelPaths(args.overlayDir, args.secretsRoot);
  const ctx = remapContext(
    args.composeArgs,
    path.resolve(args.overlayDir),
    path.resolve(args.liveRoot),
    path.resolve(args.secretsRoot),
    decryptedRelPaths,
  );
  if ('error' in ctx) return { action: 'refuse', reason: ctx.error };
  const decision = remapPersistentBindModel(rendered, ctx);
  if (!decision.ok) return { action: 'refuse', reason: decision.reason };
  if (!decision.override) return { action: 'skip' };
  const file = await writeRemapFile(args.overlayDir, args.secretsRoot, YAML.stringify(decision.override));
  return { action: 'rewrite', file };
}
