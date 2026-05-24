import { apiFetch } from './api';

/**
 * Mirrors backend/src/utils/validation.ts::isValidRelativeStackPath. Client
 * defense-in-depth: the backend rejects path-traversal attempts, but catching
 * them client-side avoids a wasted round trip and surfaces a clearer error
 * to the user. Also guards against a future regression on the server side.
 *
 * Allow: the empty string (means the stack root) and POSIX-style relative
 * paths with no traversal segments. Reject: absolute paths, drive letters,
 * backslashes, double slashes, NUL bytes, and any segment that is `.` or `..`.
 */
export function isClientSafeRelPath(rel: string): boolean {
  if (typeof rel !== 'string') return false;
  if (rel === '') return true;
  if (rel.includes('\0')) return false;
  if (rel.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(rel) || rel.startsWith('/')) return false;
  if (rel.includes('//')) return false;
  const segments = rel.split('/');
  return !segments.some(seg => seg === '..' || seg === '.');
}

function assertSafeRelPath(rel: string, label = 'path'): void {
  if (!isClientSafeRelPath(rel)) {
    throw new Error(`Invalid ${label}: must be a relative path inside the stack directory`);
  }
}

export interface FileEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  mtime: number;
  isProtected: boolean;
}

export interface FileContentResult {
  content?: string;
  binary: boolean;
  oversized: boolean;
  size: number;
  mime: string;
}

export async function parseApiError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return (data as { error?: string }).error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function stackFilesUrl(stackName: string, suffix: string): string {
  return `/stacks/${encodeURIComponent(stackName)}/files${suffix}`;
}

export async function listStackDirectory(
  stackName: string,
  relPath: string
): Promise<FileEntry[]> {
  assertSafeRelPath(relPath);
  const res = await apiFetch(stackFilesUrl(stackName, `?path=${encodeURIComponent(relPath)}`));
  if (!res.ok) throw new Error(await parseApiError(res));
  return res.json() as Promise<FileEntry[]>;
}

export async function readStackFile(
  stackName: string,
  relPath: string
): Promise<FileContentResult> {
  assertSafeRelPath(relPath);
  const res = await apiFetch(stackFilesUrl(stackName, `/content?path=${encodeURIComponent(relPath)}`));
  if (!res.ok) throw new Error(await parseApiError(res));
  return res.json() as Promise<FileContentResult>;
}

export async function downloadStackFile(
  stackName: string,
  relPath: string
): Promise<Response> {
  assertSafeRelPath(relPath);
  return apiFetch(stackFilesUrl(stackName, `/download?path=${encodeURIComponent(relPath)}`));
}

export async function uploadStackFile(
  stackName: string,
  targetDir: string,
  file: File,
  options?: { localOnly?: boolean }
): Promise<void> {
  assertSafeRelPath(targetDir, 'target directory');
  const fd = new FormData();
  fd.append('file', file, file.name);

  const activeNodeId = options?.localOnly ? null : localStorage.getItem('sencho-active-node');
  const headers: Record<string, string> = {};
  if (activeNodeId) {
    headers['x-node-id'] = activeNodeId;
  }

  // Use fetch directly: apiFetch always sets Content-Type: application/json,
  // which breaks multipart boundary negotiation. The 401 side-effects are
  // replicated manually below.
  const res = await fetch(
    `/api${stackFilesUrl(stackName, `/upload?path=${encodeURIComponent(targetDir)}`)}`,
    { method: 'POST', credentials: 'include', headers, body: fd }
  );

  if (res.status === 401) {
    if (!res.headers.get('x-sencho-proxy')) {
      window.dispatchEvent(new Event('sencho-unauthorized'));
    }
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    if (res.status === 404) {
      try {
        const clone = res.clone();
        const errData = await clone.json();
        if (errData.error?.includes('not found') && errData.error?.includes('Node')) {
          window.dispatchEvent(new Event('node-not-found'));
        }
      } catch { /* ignore */ }
    }
    throw new Error(await parseApiError(res));
  }
}

export async function writeStackFile(
  stackName: string,
  relPath: string,
  content: string
): Promise<void> {
  assertSafeRelPath(relPath);
  const res = await apiFetch(
    stackFilesUrl(stackName, `/content?path=${encodeURIComponent(relPath)}`),
    { method: 'PUT', body: JSON.stringify({ content }) }
  );
  if (!res.ok) throw new Error(await parseApiError(res));
}

export async function deleteStackPath(
  stackName: string,
  relPath: string,
  recursive?: boolean
): Promise<void> {
  assertSafeRelPath(relPath);
  const qs = recursive
    ? `path=${encodeURIComponent(relPath)}&recursive=1`
    : `path=${encodeURIComponent(relPath)}`;
  const res = await apiFetch(stackFilesUrl(stackName, `?${qs}`), { method: 'DELETE' });
  if (!res.ok) throw new Error(await parseApiError(res));
}

export async function mkdirStackPath(
  stackName: string,
  relPath: string
): Promise<void> {
  assertSafeRelPath(relPath);
  const res = await apiFetch(
    stackFilesUrl(stackName, `/folder?path=${encodeURIComponent(relPath)}`),
    { method: 'POST', body: JSON.stringify({}) }
  );
  if (!res.ok) throw new Error(await parseApiError(res));
}

export async function renameStackPath(
  stackName: string,
  fromRel: string,
  toRel: string
): Promise<void> {
  assertSafeRelPath(fromRel, 'source path');
  assertSafeRelPath(toRel, 'destination path');
  const res = await apiFetch(
    stackFilesUrl(stackName, '/rename'),
    { method: 'PATCH', body: JSON.stringify({ from: fromRel, to: toRel }) }
  );
  if (!res.ok) throw new Error(await parseApiError(res));
}

export interface EntryPermissions {
  mode: number;
  octal: string;
}

export async function getStackEntryPermissions(
  stackName: string,
  relPath: string
): Promise<EntryPermissions> {
  assertSafeRelPath(relPath);
  const res = await apiFetch(stackFilesUrl(stackName, `/permissions?path=${encodeURIComponent(relPath)}`));
  if (!res.ok) throw new Error(await parseApiError(res));
  return res.json() as Promise<EntryPermissions>;
}

export async function setStackEntryPermissions(
  stackName: string,
  relPath: string,
  mode: number
): Promise<void> {
  assertSafeRelPath(relPath);
  const res = await apiFetch(
    stackFilesUrl(stackName, `/permissions?path=${encodeURIComponent(relPath)}`),
    { method: 'PUT', body: JSON.stringify({ mode }) }
  );
  if (!res.ok) throw new Error(await parseApiError(res));
}

