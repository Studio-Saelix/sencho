import { apiFetch } from './api';

/** The id of the stack source directory root (mirrors the backend constant). */
export const STACK_SOURCE_ROOT_ID = 'stack-source';

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

/**
 * Mirrors backend/src/services/FileSystemService.ts::isProtectedRelPath. Only the
 * compose and .env files at the stack ROOT are protected; an entry with the same
 * basename nested in a subdirectory is an ordinary file. FileEntry.isProtected is
 * basename-only, so callers that care about position (move source gating, root
 * destination gating) use this instead.
 */
const PROTECTED_ROOT_NAMES = new Set([
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
  '.env',
]);

export function isProtectedRootRelPath(rel: string): boolean {
  if (!rel || rel.includes('/')) return false;
  return PROTECTED_ROOT_NAMES.has(rel);
}

/** True when `candidateRel` is `ancestorRel` itself or sits inside it. */
export function isSameOrDescendantPath(ancestorRel: string, candidateRel: string): boolean {
  return candidateRel === ancestorRel || candidateRel.startsWith(`${ancestorRel}/`);
}

/** The directory portion of a relative path; '' for a root-level entry. */
export function relPathParentDir(rel: string): string {
  return rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
}

/**
 * Pick a non-colliding "<name> copy" sibling name for Duplicate. A leading-dot
 * file (e.g. .env) is treated as having no extension, so the suffix lands before
 * any real extension (`app copy.conf`) but as a plain suffix for dotfiles
 * (`.env copy`).
 */
export function nextDuplicateName(original: string, existing: Set<string>): string {
  const dot = original.lastIndexOf('.');
  const hasExt = dot > 0;
  const base = hasExt ? original.slice(0, dot) : original;
  const ext = hasExt ? original.slice(dot) : '';
  let candidate = `${base} copy${ext}`;
  let n = 2;
  while (existing.has(candidate)) {
    candidate = `${base} copy ${n}${ext}`;
    n += 1;
  }
  return candidate;
}

/** Custom drag MIME so move drops are told apart from OS file drags (`Files`). */
export const FILE_ENTRY_DND_MIME = 'application/x-sencho-file-entry';

export interface FileEntryDragPayload {
  relPath: string;
  name: string;
  type: FileEntry['type'];
}

const ENTRY_TYPES: ReadonlySet<FileEntry['type']> = new Set(['file', 'directory', 'symlink']);

/**
 * Reads a tree-move drag payload from a DataTransfer, or null when this is not
 * one of our entry drags (e.g. an OS file drag carries `Files`, handled by the
 * upload dropzone). The parsed JSON is shape-validated rather than blindly cast,
 * so a malformed or foreign payload becomes an ignored no-op instead of flowing
 * downstream with undefined fields.
 */
export function readFileEntryDragPayload(dt: DataTransfer): FileEntryDragPayload | null {
  if (!dt.types.includes(FILE_ENTRY_DND_MIME)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dt.getData(FILE_ENTRY_DND_MIME));
  } catch (err) {
    console.warn('Ignored malformed file-entry drag payload', err);
    return null;
  }
  if (
    typeof parsed === 'object' && parsed !== null &&
    typeof (parsed as FileEntryDragPayload).relPath === 'string' &&
    typeof (parsed as FileEntryDragPayload).name === 'string' &&
    ENTRY_TYPES.has((parsed as FileEntryDragPayload).type)
  ) {
    return parsed as FileEntryDragPayload;
  }
  console.warn('Ignored file-entry drag payload with an unexpected shape');
  return null;
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
  mtimeMs: number;
  /**
   * Opaque optimistic-concurrency token, round-tripped verbatim as If-Match on
   * save. For stack-source/bind roots it is the weak ETag over the mtime; for
   * named-volume roots it is a composite token. Optional for back-compat with a
   * server that has not yet been upgraded (falls back to the mtime ETag).
   */
  version?: string;
}

/**
 * A browsable/editable file root for a stack: the stack source, a bind mount, or
 * a named volume. Wire mirror of the backend `StackFileRoot`
 * (backend/src/services/StackFileRootsService.ts); keep the two shapes in sync.
 */
export interface FileRootMount {
  service: string;
  containerPath: string;
  readOnly: boolean;
}

export interface FileRoot {
  id: string;
  kind: 'stack-source' | 'bind' | 'volume';
  label: string;
  hostPathOrName: string;
  mounts: FileRootMount[];
  readonly: boolean;
  accessible: boolean;
  browsable: boolean;
  writable: boolean;
  chmodable: boolean;
  dangerous: boolean;
  managedSourceOverlap: boolean;
  warning: string | null;
  backend: 'fs' | 'helper';
}

/**
 * Thrown by writeStackFile when the server reports the target file has been
 * modified since the caller's last read (HTTP 412). The current server-side
 * content, mtime, and version token are attached so callers can prompt the user
 * to reconcile and retry with the fresh token.
 */
export class FileConflictError extends Error {
  readonly code = 'PRECONDITION_FAILED' as const;
  readonly currentContent: string;
  readonly currentMtimeMs: number;
  readonly currentVersion: string | null;
  constructor(message: string, currentContent: string, currentMtimeMs: number, currentVersion: string | null) {
    super(message);
    this.name = 'FileConflictError';
    this.currentContent = currentContent;
    this.currentMtimeMs = currentMtimeMs;
    this.currentVersion = currentVersion;
  }
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

/** `&rootId=...` to append onto an existing query string, or '' for the default stack-source root. */
function rootParam(rootId?: string): string {
  return rootId ? `&rootId=${encodeURIComponent(rootId)}` : '';
}

/** Discover the browsable/editable file roots for a stack (Volumes + Stack source). */
export async function listFileRoots(stackName: string): Promise<FileRoot[]> {
  const res = await apiFetch(`/stacks/${encodeURIComponent(stackName)}/file-roots`);
  if (!res.ok) throw new Error(await parseApiError(res));
  return res.json() as Promise<FileRoot[]>;
}

export async function listStackDirectory(
  stackName: string,
  relPath: string,
  rootId?: string,
): Promise<FileEntry[]> {
  assertSafeRelPath(relPath);
  const res = await apiFetch(stackFilesUrl(stackName, `?path=${encodeURIComponent(relPath)}${rootParam(rootId)}`));
  if (!res.ok) throw new Error(await parseApiError(res));
  return res.json() as Promise<FileEntry[]>;
}

export async function readStackFile(
  stackName: string,
  relPath: string,
  options?: { forceText?: boolean; rootId?: string }
): Promise<FileContentResult> {
  assertSafeRelPath(relPath);
  const forceSuffix = options?.forceText ? '&force=text' : '';
  const res = await apiFetch(
    stackFilesUrl(stackName, `/content?path=${encodeURIComponent(relPath)}${forceSuffix}${rootParam(options?.rootId)}`)
  );
  if (!res.ok) throw new Error(await parseApiError(res));
  return res.json() as Promise<FileContentResult>;
}

export async function downloadStackFile(
  stackName: string,
  relPath: string,
  rootId?: string,
): Promise<Response> {
  assertSafeRelPath(relPath);
  return apiFetch(stackFilesUrl(stackName, `/download?path=${encodeURIComponent(relPath)}${rootParam(rootId)}`));
}

/**
 * Thrown by uploadStackFile when the target filename already exists in the
 * directory and the caller did not opt into overwrite. The FileUploadDropzone
 * surfaces a confirm dialog on this signal and retries with overwrite=true.
 */
export class UploadConflictError extends Error {
  readonly code = 'FILE_EXISTS' as const;
  constructor(message: string) {
    super(message);
    this.name = 'UploadConflictError';
  }
}

export async function uploadStackFile(
  stackName: string,
  targetDir: string,
  file: File,
  options?: { localOnly?: boolean; overwrite?: boolean; rootId?: string }
): Promise<void> {
  assertSafeRelPath(targetDir, 'target directory');
  const fd = new FormData();
  fd.append('file', file, file.name);

  const activeNodeId = options?.localOnly ? null : localStorage.getItem('sencho-active-node');
  const headers: Record<string, string> = {};
  if (activeNodeId) {
    headers['x-node-id'] = activeNodeId;
  }

  const overwriteSuffix = options?.overwrite ? '&overwrite=1' : '';
  // Use fetch directly: apiFetch always sets Content-Type: application/json,
  // which breaks multipart boundary negotiation. The 401 side-effects are
  // replicated manually below.
  const res = await fetch(
    `/api${stackFilesUrl(stackName, `/upload?path=${encodeURIComponent(targetDir)}${overwriteSuffix}${rootParam(options?.rootId)}`)}`,
    { method: 'POST', credentials: 'include', headers, body: fd }
  );

  if (res.status === 401) {
    if (!res.headers.get('x-sencho-proxy')) {
      window.dispatchEvent(new Event('sencho-unauthorized'));
    }
    throw new Error('Unauthorized');
  }

  if (res.status === 409) {
    let body: { code?: string; error?: string } = {};
    try { body = await res.clone().json(); } catch { /* ignore */ }
    if (body.code === 'FILE_EXISTS') {
      throw new UploadConflictError(body.error ?? `${file.name} already exists.`);
    }
    // DIR_EXISTS and any other 409 fall through to the generic Error path so the
    // dropzone surfaces the server message as a toast and does NOT offer a Replace
    // confirmation (a directory cannot be replaced by a file upload).
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

/**
 * Create a new empty file at `dirRelPath/fileName`. Routes through the upload
 * endpoint with a zero-byte file and no overwrite, so the server's exclusive
 * create path is authoritative and an existing entry is never clobbered: an
 * existing file of that name is rejected as FILE_EXISTS (thrown as
 * UploadConflictError), and an existing folder is rejected as DIR_EXISTS (a
 * generic Error). Works on both the filesystem and named-volume backends.
 */
export async function createEmptyStackFile(
  stackName: string,
  dirRelPath: string,
  fileName: string,
  options?: { rootId?: string }
): Promise<void> {
  const blank = new File([new Uint8Array(0)], fileName, { type: 'text/plain' });
  await uploadStackFile(stackName, dirRelPath, blank, { rootId: options?.rootId, overwrite: false });
}

export async function writeStackFile(
  stackName: string,
  relPath: string,
  content: string,
  options?: { ifMatchVersion?: string; rootId?: string }
): Promise<{ version: string | null; mtimeMs: number | null }> {
  assertSafeRelPath(relPath);
  const headers: Record<string, string> = {};
  if (options?.ifMatchVersion) {
    // Send the opaque version token verbatim (it is already a valid quoted
    // If-Match value for both fs and helper roots).
    headers['If-Match'] = options.ifMatchVersion;
  }
  const res = await apiFetch(
    stackFilesUrl(stackName, `/content?path=${encodeURIComponent(relPath)}${rootParam(options?.rootId)}`),
    { method: 'PUT', headers, body: JSON.stringify({ content }) }
  );
  if (res.status === 412) {
    let body: { currentContent?: string; currentMtimeMs?: number; currentVersion?: string; error?: string } = {};
    try { body = await res.clone().json(); } catch { /* ignore */ }
    throw new FileConflictError(
      body.error ?? 'File has been modified since you last read it.',
      typeof body.currentContent === 'string' ? body.currentContent : '',
      typeof body.currentMtimeMs === 'number' ? body.currentMtimeMs : 0,
      typeof body.currentVersion === 'string'
        ? body.currentVersion
        : res.headers.get('ETag'),
    );
  }
  if (!res.ok) throw new Error(await parseApiError(res));
  // The ETag is the opaque version token for the new content; round-trip it
  // verbatim on the next save. mtimeMs is parsed for display only.
  const version = res.headers.get('ETag');
  let mtimeMs: number | null = null;
  if (version) {
    const stripped = version.replace(/^W\//i, '').trim().replace(/^"(.*)"$/, '$1');
    const parsed = Number(stripped);
    if (Number.isFinite(parsed)) mtimeMs = parsed;
  }
  return { version, mtimeMs };
}

export async function deleteStackPath(
  stackName: string,
  relPath: string,
  recursive?: boolean,
  rootId?: string,
): Promise<void> {
  assertSafeRelPath(relPath);
  const recursiveSuffix = recursive ? '&recursive=1' : '';
  const res = await apiFetch(
    stackFilesUrl(stackName, `?path=${encodeURIComponent(relPath)}${recursiveSuffix}${rootParam(rootId)}`),
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(await parseApiError(res));
}

export async function mkdirStackPath(
  stackName: string,
  relPath: string,
  rootId?: string,
): Promise<void> {
  assertSafeRelPath(relPath);
  const res = await apiFetch(
    stackFilesUrl(stackName, `/folder?path=${encodeURIComponent(relPath)}${rootParam(rootId)}`),
    { method: 'POST', body: JSON.stringify({}) }
  );
  if (!res.ok) throw new Error(await parseApiError(res));
}

export async function renameStackPath(
  stackName: string,
  fromRel: string,
  toRel: string,
  rootId?: string,
): Promise<void> {
  assertSafeRelPath(fromRel, 'source path');
  assertSafeRelPath(toRel, 'destination path');
  const res = await apiFetch(
    stackFilesUrl(stackName, `/rename${rootId ? `?rootId=${encodeURIComponent(rootId)}` : ''}`),
    { method: 'PATCH', body: JSON.stringify({ from: fromRel, to: toRel }) }
  );
  if (!res.ok) throw new Error(await parseApiError(res));
}

export async function copyStackFile(
  stackName: string,
  fromRel: string,
  toRel: string,
  rootId?: string,
): Promise<void> {
  assertSafeRelPath(fromRel, 'source path');
  assertSafeRelPath(toRel, 'destination path');
  const res = await apiFetch(
    stackFilesUrl(stackName, `/copy${rootId ? `?rootId=${encodeURIComponent(rootId)}` : ''}`),
    { method: 'POST', body: JSON.stringify({ from: fromRel, to: toRel }) }
  );
  if (!res.ok) throw new Error(await parseApiError(res));
}

/** A failed item in a partial-success bulk operation. */
export interface BulkFailure {
  path: string;
  error: string;
}
export interface BulkDeleteResult {
  deleted: string[];
  failed: BulkFailure[];
}
export interface BulkMoveResult {
  moved: string[];
  failed: BulkFailure[];
}

export async function bulkDeleteStackPaths(stackName: string, paths: string[], rootId?: string): Promise<BulkDeleteResult> {
  const res = await apiFetch(
    stackFilesUrl(stackName, `/bulk-delete${rootId ? `?rootId=${encodeURIComponent(rootId)}` : ''}`),
    { method: 'POST', body: JSON.stringify({ paths }) }
  );
  if (!res.ok) throw new Error(await parseApiError(res));
  return res.json() as Promise<BulkDeleteResult>;
}

export async function bulkMoveStackPaths(stackName: string, from: string[], toDir: string, rootId?: string): Promise<BulkMoveResult> {
  const res = await apiFetch(
    stackFilesUrl(stackName, `/bulk-move${rootId ? `?rootId=${encodeURIComponent(rootId)}` : ''}`),
    { method: 'POST', body: JSON.stringify({ from, toDir }) }
  );
  if (!res.ok) throw new Error(await parseApiError(res));
  return res.json() as Promise<BulkMoveResult>;
}

/** GET the bulk-download archive (repeated ?path= so read-only API tokens work). */
export async function bulkDownloadStackFiles(stackName: string, paths: string[], rootId?: string): Promise<Response> {
  const query = paths.map((p) => `path=${encodeURIComponent(p)}`).join('&');
  const suffix = rootId ? `&rootId=${encodeURIComponent(rootId)}` : '';
  return apiFetch(stackFilesUrl(stackName, `/bulk-download?${query}${suffix}`));
}

/**
 * Drop any selected path whose ancestor is also selected (so a folder and a file
 * inside it are not both acted on). A UX convenience; the backend re-normalizes
 * authoritatively (with per-root case-awareness), so this is not the boundary.
 */
export function normalizeSelection(paths: string[]): string[] {
  const set = new Set(paths);
  return [...set].filter((p) => {
    const segments = p.split('/');
    for (let i = 1; i < segments.length; i++) {
      if (set.has(segments.slice(0, i).join('/'))) return false;
    }
    return true;
  });
}

export interface EntryPermissions {
  mode: number;
  octal: string;
}

export async function getStackEntryPermissions(
  stackName: string,
  relPath: string,
  rootId?: string,
): Promise<EntryPermissions> {
  assertSafeRelPath(relPath);
  const res = await apiFetch(stackFilesUrl(stackName, `/permissions?path=${encodeURIComponent(relPath)}${rootParam(rootId)}`));
  if (!res.ok) throw new Error(await parseApiError(res));
  return res.json() as Promise<EntryPermissions>;
}

export async function setStackEntryPermissions(
  stackName: string,
  relPath: string,
  mode: number,
  rootId?: string,
): Promise<void> {
  assertSafeRelPath(relPath);
  const res = await apiFetch(
    stackFilesUrl(stackName, `/permissions?path=${encodeURIComponent(relPath)}${rootParam(rootId)}`),
    { method: 'PUT', body: JSON.stringify({ mode }) }
  );
  if (!res.ok) throw new Error(await parseApiError(res));
}

