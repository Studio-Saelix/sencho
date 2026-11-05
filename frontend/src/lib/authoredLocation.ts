/**
 * One rendering of an authored location, shared by the Doctor and Compose
 * Labels panels. The decision (which surface to open, and whether the location
 * is usable at all) is pure and unit-testable; Monaco is applied through a
 * structural interface so tests never load it.
 */

export interface AuthoredLocation {
  /** Stack-relative POSIX path. */
  file: string;
  path?: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export type AuthoredLocationSurface = 'compose' | 'files';

export interface AuthoredLocationTarget {
  surface: AuthoredLocationSurface;
  /** The file to open; for the compose surface this is the loaded primary file. */
  file: string;
}

export interface PendingAuthoredReveal {
  target: AuthoredLocationTarget;
  location: AuthoredLocation;
}

export interface MonacoRangeLike {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface RevealEditorLike {
  revealRangeInCenter(range: MonacoRangeLike): void;
  setSelection(range: MonacoRangeLike): void;
  focus?(): void;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** Normalize a stack-relative path, or null when it is absolute or escaping. */
export function normalizeStackPath(file: string): string | null {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized === '' || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
  const parts = normalized.split('/');
  if (parts.includes('..')) return null;
  return normalized;
}

export function isUsableAuthoredLocation(value: unknown): value is AuthoredLocation {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.file !== 'string' || normalizeStackPath(entry.file) === null) return false;
  if (!isPositiveInt(entry.line) || !isPositiveInt(entry.column)
    || !isPositiveInt(entry.endLine) || !isPositiveInt(entry.endColumn)) return false;
  if (entry.endLine < entry.line) return false;
  if (entry.endLine === entry.line && entry.endColumn < entry.column) return false;
  if (entry.path !== undefined && typeof entry.path !== 'string') return false;
  return true;
}

/**
 * Which surface a location opens. The compose tab owns exactly one file (the
 * loaded primary compose file); every other file lives in the Files tab. A
 * location that cannot be validated produces no navigation at all.
 */
export function planAuthoredLocation(
  location: unknown,
  composeFilename: string | null,
): AuthoredLocationTarget | null {
  if (!isUsableAuthoredLocation(location)) return null;
  const file = normalizeStackPath(location.file);
  if (file === null) return null;
  const primary = composeFilename === null ? null : normalizeStackPath(composeFilename);
  if (primary !== null && file === primary) return { surface: 'compose', file };
  return { surface: 'files', file };
}

export function rangeForLocation(location: AuthoredLocation): MonacoRangeLike {
  return {
    startLineNumber: location.line,
    startColumn: location.column,
    endLineNumber: location.endLine,
    endColumn: location.endColumn,
  };
}

/** Reveal and select a range once, then leave later manual navigation alone. */
export function revealLocation(editor: RevealEditorLike, location: AuthoredLocation): void {
  const range = rangeForLocation(location);
  editor.revealRangeInCenter(range);
  editor.setSelection(range);
  editor.focus?.();
}
