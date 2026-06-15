/**
 * Coverage for FileTree.
 *
 * Locks the expand/collapse behavior: root directory loaded on mount,
 * subdirectory fetched on first expand, collapsed on second click, and
 * re-expanded from cache (no second fetch) on third click.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FILE_ENTRY_DND_MIME, type FileEntry, type FileEntryDragPayload } from '@/lib/stackFilesApi';

vi.mock('@/components/ui/toast-store', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

// ScrollArea just renders children so the tree nodes are accessible in jsdom.
vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: () => <div data-testid="skeleton" />,
}));

import { FileTree } from '../FileTree';

function makeFile(name: string): FileEntry {
  return { name, type: 'file', size: 100, mtime: 0, isProtected: false };
}

function makeDir(name: string): FileEntry {
  return { name, type: 'directory', size: 0, mtime: 0, isProtected: false };
}

const ROOT_ENTRIES: FileEntry[] = [makeDir('src'), makeFile('README.md')];
const SRC_ENTRIES: FileEntry[] = [makeFile('index.ts'), makeFile('app.ts')];

function fakeOk(entries: FileEntry[]): Promise<FileEntry[]> {
  return Promise.resolve(entries);
}

let onSelectFile: ReturnType<typeof vi.fn> & ((relPath: string, entry: FileEntry) => void);
let mockLoadDir: ReturnType<typeof vi.fn> & ((relPath: string) => Promise<FileEntry[]>);

function defaultProps() {
  return {
    sourceKey: 'my-stack',
    loadDir: mockLoadDir,
    selectedPath: '',
    onSelectFile,
  };
}

beforeEach(() => {
  onSelectFile = vi.fn() as typeof onSelectFile;
  mockLoadDir = vi.fn() as typeof mockLoadDir;
});

afterEach(() => vi.clearAllMocks());

describe('FileTree', () => {
  it('fetches root entries on mount and renders them', async () => {
    mockLoadDir.mockReturnValue(fakeOk(ROOT_ENTRIES));

    render(<FileTree {...defaultProps()} />);

    await waitFor(() => expect(mockLoadDir).toHaveBeenCalledWith(''));
    expect(await screen.findByText('src')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('fetches subdirectory on first expand and shows children', async () => {
    mockLoadDir
      .mockReturnValueOnce(fakeOk(ROOT_ENTRIES))
      .mockReturnValueOnce(fakeOk(SRC_ENTRIES));

    const user = userEvent.setup();
    render(<FileTree {...defaultProps()} />);

    await screen.findByText('src');

    // One call so far: root fetch.
    expect(mockLoadDir).toHaveBeenCalledTimes(1);

    await user.click(screen.getByText('src'));

    await waitFor(() => expect(mockLoadDir).toHaveBeenCalledTimes(2));
    expect(mockLoadDir).toHaveBeenNthCalledWith(2, 'src');

    expect(await screen.findByText('index.ts')).toBeInTheDocument();
    expect(screen.getByText('app.ts')).toBeInTheDocument();
  });

  it('collapses on second click (no additional fetch)', async () => {
    mockLoadDir
      .mockReturnValueOnce(fakeOk(ROOT_ENTRIES))
      .mockReturnValueOnce(fakeOk(SRC_ENTRIES));

    const user = userEvent.setup();
    render(<FileTree {...defaultProps()} />);

    await screen.findByText('src');

    // Expand.
    await user.click(screen.getByText('src'));
    await screen.findByText('index.ts');

    const callsAfterExpand = mockLoadDir.mock.calls.length;

    // Collapse.
    await user.click(screen.getByText('src'));
    await waitFor(() => expect(screen.queryByText('index.ts')).not.toBeInTheDocument());

    // No extra fetch should have happened.
    expect(mockLoadDir).toHaveBeenCalledTimes(callsAfterExpand);
  });

  it('re-expands from cache on third click (no second fetch for that dir)', async () => {
    mockLoadDir
      .mockReturnValueOnce(fakeOk(ROOT_ENTRIES))
      .mockReturnValueOnce(fakeOk(SRC_ENTRIES));

    const user = userEvent.setup();
    render(<FileTree {...defaultProps()} />);

    await screen.findByText('src');

    // First click: expand (fetches subdirectory).
    await user.click(screen.getByText('src'));
    await screen.findByText('index.ts');

    // Second click: collapse.
    await user.click(screen.getByText('src'));
    await waitFor(() => expect(screen.queryByText('index.ts')).not.toBeInTheDocument());

    const callsAfterCollapse = mockLoadDir.mock.calls.length;

    // Third click: re-expand from cache.
    await user.click(screen.getByText('src'));
    await screen.findByText('index.ts');

    // Fetch count must not have increased.
    expect(mockLoadDir).toHaveBeenCalledTimes(callsAfterCollapse);
  });

  it('shows error message when root fetch fails', async () => {
    mockLoadDir.mockRejectedValue(new Error('Network error'));

    render(<FileTree {...defaultProps()} />);

    expect(await screen.findByText('Network error')).toBeInTheDocument();
  });

  it('shows empty state when root returns no entries', async () => {
    mockLoadDir.mockReturnValue(fakeOk([]));

    render(<FileTree {...defaultProps()} />);

    expect(await screen.findByText(/empty folder/i)).toBeInTheDocument();
  });

  it('filters visible entries by name as the user types', async () => {
    const entries = [makeDir('src'), makeFile('README.md'), makeFile('Notes.txt'), makeFile('config.yaml')];
    mockLoadDir.mockReturnValue(fakeOk(entries));
    const user = userEvent.setup();

    render(<FileTree {...defaultProps()} />);
    await screen.findByText('README.md');
    expect(screen.getByText('Notes.txt')).toBeInTheDocument();
    expect(screen.getByText('config.yaml')).toBeInTheDocument();

    const filter = screen.getByLabelText(/filter files/i);
    await user.type(filter, 'note');

    // Only Notes.txt survives (case-insensitive substring).
    expect(screen.getByText('Notes.txt')).toBeInTheDocument();
    expect(screen.queryByText('README.md')).not.toBeInTheDocument();
    expect(screen.queryByText('config.yaml')).not.toBeInTheDocument();

    // Clear button restores the full listing.
    await user.click(screen.getByLabelText(/clear filter/i));
    expect(screen.getByText('README.md')).toBeInTheDocument();
    expect(screen.getByText('Notes.txt')).toBeInTheDocument();
    expect(screen.getByText('config.yaml')).toBeInTheDocument();
  });

  it('shows an empty-match hint when the filter matches nothing', async () => {
    mockLoadDir.mockReturnValue(fakeOk([makeFile('README.md')]));
    const user = userEvent.setup();

    render(<FileTree {...defaultProps()} />);
    await screen.findByText('README.md');

    const filter = screen.getByLabelText(/filter files/i);
    await user.type(filter, 'xyzzy');

    expect(screen.queryByText('README.md')).not.toBeInTheDocument();
    expect(screen.getByText(/no entries match/i)).toBeInTheDocument();
  });

  it('keeps a parent directory visible when a loaded descendant matches and auto-expands it', async () => {
    // Root has `src` (dir) and `README.md`. The user expands `src` so its
    // contents are loaded. Then they filter on a child of `src` whose name
    // does not match the parent.
    mockLoadDir
      .mockReturnValueOnce(fakeOk([makeDir('src'), makeFile('README.md')]))
      .mockReturnValueOnce(fakeOk([makeFile('app.ts'), makeFile('lib.ts')]));
    const user = userEvent.setup();

    render(<FileTree {...defaultProps()} />);
    await screen.findByText('src');
    await user.click(screen.getByText('src'));
    await screen.findByText('app.ts');

    const filter = screen.getByLabelText(/filter files/i);
    await user.type(filter, 'app');

    // `src` survives because it has a matching loaded descendant.
    expect(screen.getByText('src')).toBeInTheDocument();
    // The match itself is visible (src auto-expands while filter is active).
    expect(screen.getByText('app.ts')).toBeInTheDocument();
    // Non-matching siblings at root and inside `src` are filtered out.
    expect(screen.queryByText('README.md')).not.toBeInTheDocument();
    expect(screen.queryByText('lib.ts')).not.toBeInTheDocument();
  });

  it('does not keep an unexpanded parent visible (filter only sees loaded entries)', async () => {
    // Root has `src` (never expanded) and `README.md`. The filter can only
    // judge directories by their loaded contents; an un-fetched subtree
    // contributes nothing to the ancestor-keep rule.
    mockLoadDir.mockReturnValue(fakeOk([makeDir('src'), makeFile('README.md')]));
    const user = userEvent.setup();

    render(<FileTree {...defaultProps()} />);
    await screen.findByText('src');

    const filter = screen.getByLabelText(/filter files/i);
    await user.type(filter, 'app');

    expect(screen.queryByText('src')).not.toBeInTheDocument();
    expect(screen.queryByText('README.md')).not.toBeInTheDocument();
    expect(screen.getByText(/no entries match/i)).toBeInTheDocument();
  });
});

// ── drag-and-drop move ──────────────────────────────────────────────────────

/** A minimal DataTransfer stand-in carrying our custom move payload (or an OS file drag). */
function makeDataTransfer(payload: FileEntryDragPayload | null): DataTransfer {
  const types = payload ? [FILE_ENTRY_DND_MIME] : ['Files'];
  return {
    types,
    getData: (type: string) => (payload && type === FILE_ENTRY_DND_MIME ? JSON.stringify(payload) : ''),
    setData: () => undefined,
    dropEffect: 'none',
    effectAllowed: 'all',
  } as unknown as DataTransfer;
}

function rowFor(name: string): HTMLElement {
  const el = screen.getByText(name).closest('[role="button"]');
  if (!el) throw new Error(`no row for ${name}`);
  return el as HTMLElement;
}

describe('FileTree drag-and-drop move', () => {
  it('calls onMove when an entry is dropped on a folder node', async () => {
    mockLoadDir.mockReturnValue(fakeOk(ROOT_ENTRIES));
    const onMove = vi.fn();

    render(<FileTree {...defaultProps()} canEdit onMove={onMove} />);
    await screen.findByText('src');

    const payload: FileEntryDragPayload = { relPath: 'README.md', name: 'README.md', type: 'file' };
    fireEvent.drop(rowFor('src'), { dataTransfer: makeDataTransfer(payload) });

    expect(onMove).toHaveBeenCalledWith('README.md', 'README.md', 'src');
  });

  it('ignores an OS file drag (dataTransfer carries Files, not our payload)', async () => {
    mockLoadDir.mockReturnValue(fakeOk(ROOT_ENTRIES));
    const onMove = vi.fn();

    render(<FileTree {...defaultProps()} canEdit onMove={onMove} />);
    await screen.findByText('src');

    fireEvent.drop(rowFor('src'), { dataTransfer: makeDataTransfer(null) });

    expect(onMove).not.toHaveBeenCalled();
  });

  it('moves a nested entry to the stack root when dropped on the root area', async () => {
    mockLoadDir
      .mockReturnValueOnce(fakeOk(ROOT_ENTRIES))
      .mockReturnValueOnce(fakeOk(SRC_ENTRIES));
    const onMove = vi.fn();
    const user = userEvent.setup();

    render(<FileTree {...defaultProps()} canEdit onMove={onMove} />);
    await screen.findByText('src');
    await user.click(screen.getByText('src'));
    await screen.findByText('index.ts');

    const rootZone = screen.getByTestId('file-tree-root-dropzone');
    const payload: FileEntryDragPayload = { relPath: 'src/index.ts', name: 'index.ts', type: 'file' };
    fireEvent.dragOver(rootZone, { dataTransfer: makeDataTransfer(payload) });
    fireEvent.drop(rootZone, { dataTransfer: makeDataTransfer(payload) });

    expect(onMove).toHaveBeenCalledWith('src/index.ts', 'index.ts', '');
  });

  it('ignores a drop of a folder onto one of its own descendants', async () => {
    mockLoadDir
      .mockReturnValueOnce(fakeOk([makeDir('src'), makeFile('README.md')]))
      .mockReturnValueOnce(fakeOk([makeDir('lib'), makeFile('index.ts')]));
    const onMove = vi.fn();
    const user = userEvent.setup();

    render(<FileTree {...defaultProps()} canEdit onMove={onMove} />);
    await screen.findByText('src');
    await user.click(screen.getByText('src'));
    await screen.findByText('lib');

    // Drop the `src` folder onto `src/lib`, its own descendant.
    const payload: FileEntryDragPayload = { relPath: 'src', name: 'src', type: 'directory' };
    fireEvent.drop(rowFor('lib'), { dataTransfer: makeDataTransfer(payload) });

    expect(onMove).not.toHaveBeenCalled();
  });

  it('ignores a drop onto the entry\'s current parent (no-op)', async () => {
    mockLoadDir
      .mockReturnValueOnce(fakeOk([makeDir('src'), makeFile('README.md')]))
      .mockReturnValueOnce(fakeOk([makeFile('index.ts')]));
    const onMove = vi.fn();
    const user = userEvent.setup();

    render(<FileTree {...defaultProps()} canEdit onMove={onMove} />);
    await screen.findByText('src');
    await user.click(screen.getByText('src'));
    await screen.findByText('index.ts');

    // Drop `src/index.ts` back onto `src`, where it already lives.
    const payload: FileEntryDragPayload = { relPath: 'src/index.ts', name: 'index.ts', type: 'file' };
    fireEvent.drop(rowFor('src'), { dataTransfer: makeDataTransfer(payload) });

    expect(onMove).not.toHaveBeenCalled();
  });

  it('makes ordinary entries draggable but not protected root files', async () => {
    mockLoadDir.mockReturnValue(fakeOk([makeFile('compose.yaml'), makeFile('README.md')]));

    render(<FileTree {...defaultProps()} canEdit onMove={vi.fn()} />);
    await screen.findByText('README.md');

    expect(rowFor('README.md').draggable).toBe(true);
    expect(rowFor('compose.yaml').draggable).toBe(false);
  });
});
