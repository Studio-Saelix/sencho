import { apiFetch } from '@/lib/api';
import type {
  BootstrapCapabilities,
  BootstrapHostKeyResult,
  BootstrapPreflightResult,
} from './types';

/**
 * Bootstrap preflight API. Every call is local-only: the hub owns the trust
 * pins and performs the SSH probes, so a request must never be proxied to a
 * remote node.
 */

export const FALLBACK_CAPABILITIES: BootstrapCapabilities = {
  supported: { os: ['ubuntu-22.04', 'ubuntu-24.04'], arch: ['x86_64'] },
  defaults: { composeDir: '/opt/docker/sencho', agentDir: '/opt/sencho-agent' },
  fixed: {
    projectName: 'sencho-agent',
    containerName: 'sencho-agent',
    dataVolume: 'sencho-agent-data',
    dataMount: '/app/data',
    image: 'saelix/sencho:latest',
  },
  limits: {
    maxPathLength: 200,
    blockBelowComposeFreeBytes: 2 * 1024 ** 3,
    warnBelowComposeFreeBytes: 5 * 1024 ** 3,
    blockBelowAgentFreeBytes: 512 * 1024 ** 2,
    warnBelowAgentFreeBytes: 1024 ** 3,
    blockBelowDockerRootFreeBytes: 2 * 1024 ** 3,
    warnBelowDockerRootFreeBytes: 5 * 1024 ** 3,
  },
  pathPolicy: {
    reservedPrefixes: [
      '/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/proc', '/root', '/run',
      '/sbin', '/sys', '/usr', '/var/run', '/var/lib/docker', '/var/lib/containerd', '/app',
      '/tmp', '/var/tmp', '/snap', '/nix',
    ],
    exactRoots: ['/home', '/opt', '/srv', '/mnt', '/media'],
    deniedFilesystems: ['tmpfs', 'ramfs', 'overlay', 'aufs', 'nfs', 'nfs4', 'cifs', 'smb3', 'sshfs', 'fuse.*', '9p'],
  },
};

export class BootstrapApiError extends Error {
  public readonly code: string;
  public readonly field: string | null;
  public readonly details: Record<string, unknown>;

  public constructor(message: string, code: string, field: string | null, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'BootstrapApiError';
    this.code = code;
    this.field = field;
    this.details = details;
  }
}

async function toError(res: Response): Promise<BootstrapApiError> {
  let body: Record<string, unknown> = {};
  try {
    body = await res.json() as Record<string, unknown>;
  } catch {
    // Keep the generic message when the body is not JSON.
  }
  const message = typeof body.error === 'string' ? body.error : 'The request failed.';
  const code = typeof body.code === 'string' ? body.code : `HTTP_${res.status}`;
  const field = typeof body.field === 'string' ? body.field : null;
  return new BootstrapApiError(message, code, field, body);
}

export async function fetchBootstrapCapabilities(signal?: AbortSignal): Promise<BootstrapCapabilities> {
  try {
    const res = await apiFetch('/nodes/bootstrap/capabilities', { localOnly: true, signal });
    if (!res.ok) throw await toError(res);
    return await res.json() as BootstrapCapabilities;
  } catch (error) {
    if (error instanceof BootstrapApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    // The fallback keeps the form usable while the request is retried on the
    // next open; the server remains authoritative for every value it returns.
    return FALLBACK_CAPABILITIES;
  }
}

export async function checkBootstrapHostKey(
  input: { host: string; port: number },
  signal?: AbortSignal,
): Promise<BootstrapHostKeyResult> {
  const res = await apiFetch('/nodes/bootstrap/host-key', {
    method: 'POST',
    localOnly: true,
    signal,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await toError(res);
  return await res.json() as BootstrapHostKeyResult;
}

export interface PreflightInput {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  passphrase: string | null;
  expectedFingerprint: string;
  replacePinnedFingerprint: string | null;
  targetName: string;
  composeDir: string;
  agentDir: string;
}

export async function runBootstrapPreflight(
  input: PreflightInput,
  signal?: AbortSignal,
): Promise<BootstrapPreflightResult> {
  const res = await apiFetch('/nodes/bootstrap/preflight', {
    method: 'POST',
    localOnly: true,
    signal,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await toError(res);
  return await res.json() as BootstrapPreflightResult;
}
