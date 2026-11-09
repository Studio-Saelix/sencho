/**
 * Reveal lifecycle: a reported location may only be applied to the editor
 * mounted for the file whose content is loaded, and the request is consumed
 * exactly once. A slow file read must not leave the previous file's editor
 * holding the new request.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { FileContentResult } from '@/lib/stackFilesApi';
import type { AuthoredLocation } from '@/lib/authoredLocation';

const h = vi.hoisted(() => ({
  editors: [] as Array<{
    id: number;
    revealRangeInCenter: ReturnType<typeof vi.fn>;
    setSelection: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  }>,
  reveals: [] as Array<{ id: number; range: unknown }>,
  nextId: 0,
}));

vi.mock('@/lib/monacoLoader', async () => {
  const React = await import('react');
  function MockEditor({ onMount }: { onMount?: (editor: unknown) => void }) {
    const mountRef = React.useRef(onMount);
    mountRef.current = onMount;
    React.useEffect(() => {
      // Monaco reports its instance from an asynchronous mount callback. Defer
      // it a macrotask so the test exercises the window between "content
      // loaded" and "replacement editor mounted" that the bug lived in.
      const timer = setTimeout(() => {
        const id = h.nextId++;
        const editor = {
          id,
          revealRangeInCenter: vi.fn((range: unknown) => h.reveals.push({ id, range })),
          setSelection: vi.fn(),
          focus: vi.fn(),
        };
        h.editors.push(editor);
        mountRef.current?.(editor);
      }, 0);
      return () => clearTimeout(timer);
    }, []);
    return <div data-testid="monaco-editor" />;
  }
  return { Editor: MockEditor, DiffEditor: () => <div data-testid="monaco-diff-editor" /> };
});

vi.mock('@/lib/stackFilesApi', () => {
  class MockFileConflictError extends Error {}
  return {
    readStackFile: vi.fn(),
    writeStackFile: vi.fn(),
    downloadStackFile: vi.fn(),
    FileConflictError: MockFileConflictError,
  };
});

vi.mock('@/components/ui/toast-store', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(() => 'loading-id'),
    dismiss: vi.fn(),
  },
}));

vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: () => <div data-testid="skeleton" />,
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, disabled, onClick }: { children: React.ReactNode; disabled?: boolean; onClick?: () => void }) => (
    <button disabled={disabled} onClick={onClick}>{children}</button>
  ),
}));

vi.mock('@/lib/utils', () => ({
  formatBytes: (n: number) => `${n}B`,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

vi.mock('@/lib/monacoLanguages', () => ({
  extensionToLanguage: () => 'plaintext',
}));

import { readStackFile } from '@/lib/stackFilesApi';
import { sha256Hex } from '@/lib/sha256';
import { toast } from '@/components/ui/toast-store';
import { FileViewer } from '../FileViewer';

const mockReadFile = readStackFile as unknown as ReturnType<typeof vi.fn>;

function textResult(content: string): FileContentResult {
  return {
    content, binary: false, oversized: false, size: content.length, mime: 'text/plain',
    mtimeMs: 1_700_000_000_000, version: 'W/"1700000000000"',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const revealB: AuthoredLocation = {
  file: 'b.txt',
  line: 3,
  column: 2,
  endLine: 4,
  endColumn: 9,
  fileHash: sha256Hex('B content'),
};

const expectedRange = { startLineNumber: 3, startColumn: 2, endLineNumber: 4, endColumn: 9 };

const defaultProps = {
  stackName: 'my-stack',
  canEdit: true,
  isDarkMode: false,
};

beforeEach(() => {
  h.editors.length = 0;
  h.reveals.length = 0;
  h.nextId = 0;
  mockReadFile.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe('FileViewer reveal lifecycle', () => {
  it('applies a deferred file navigation only to the mounted editor for that file', async () => {
    const b = deferred<FileContentResult>();
    mockReadFile.mockImplementation((_stack: string, path: string) =>
      path === 'a.txt' ? Promise.resolve(textResult('A content')) : b.promise);
    const onRevealApplied = vi.fn();

    const { rerender } = render(
      <FileViewer {...defaultProps} selectedPath="a.txt" />,
    );
    await waitFor(() => expect(h.editors).toHaveLength(1));
    const editorA = h.editors[0];

    rerender(
      <FileViewer
        {...defaultProps}
        selectedPath="b.txt"
        reveal={revealB}
        onRevealApplied={onRevealApplied}
      />,
    );
    expect(editorA.revealRangeInCenter).not.toHaveBeenCalled();
    expect(onRevealApplied).not.toHaveBeenCalled();

    b.resolve(textResult('B content'));
    await waitFor(() => expect(onRevealApplied).toHaveBeenCalledTimes(1));
    const finalEditor = h.editors[h.editors.length - 1];
    expect(finalEditor).not.toBe(editorA);
    expect(editorA.revealRangeInCenter).not.toHaveBeenCalled();
    expect(finalEditor.revealRangeInCenter).toHaveBeenCalledWith(expectedRange);
    expect(finalEditor.setSelection).toHaveBeenCalledWith(expectedRange);
    expect(h.reveals).toEqual([{ id: finalEditor.id, range: expectedRange }]);
  });

  it('permits repeating the same location after the request is cleared', async () => {
    mockReadFile.mockResolvedValue(textResult('B content'));
    const onRevealApplied = vi.fn();

    const { rerender } = render(
      <FileViewer
        {...defaultProps}
        selectedPath="b.txt"
        reveal={revealB}
        onRevealApplied={onRevealApplied}
      />,
    );
    await waitFor(() => expect(onRevealApplied).toHaveBeenCalledTimes(1));

    rerender(<FileViewer {...defaultProps} selectedPath="b.txt" reveal={null} onRevealApplied={onRevealApplied} />);
    rerender(<FileViewer {...defaultProps} selectedPath="b.txt" reveal={revealB} onRevealApplied={onRevealApplied} />);

    await waitFor(() => expect(onRevealApplied).toHaveBeenCalledTimes(2));
    expect(h.reveals).toHaveLength(2);
  });

  it('rereads an already-loaded path before applying a reveal', async () => {
    const fresh = deferred<FileContentResult>();
    mockReadFile
      .mockResolvedValueOnce(textResult('stale content'))
      .mockImplementationOnce(() => fresh.promise);
    const onRevealApplied = vi.fn();
    const freshContent = 'fresh\ncontent with one inserted line\nmore';
    const freshReveal: AuthoredLocation = { ...revealB, fileHash: sha256Hex(freshContent) };

    const { rerender } = render(
      <FileViewer {...defaultProps} selectedPath="b.txt" reveal={null} />,
    );
    await waitFor(() => expect(mockReadFile).toHaveBeenCalledTimes(1));

    rerender(
      <FileViewer
        {...defaultProps}
        selectedPath="b.txt"
        reloadKey={1}
        reveal={freshReveal}
        onRevealApplied={onRevealApplied}
      />,
    );

    // The viewer must not reuse the buffer loaded before the reveal; it waits
    // for the reread and applies the range only after that read completes.
    await waitFor(() => expect(mockReadFile).toHaveBeenCalledTimes(2));
    expect(onRevealApplied).not.toHaveBeenCalled();
    expect(h.reveals).toHaveLength(0);

    fresh.resolve(textResult(freshContent));
    await waitFor(() => expect(onRevealApplied).toHaveBeenCalledTimes(1));
    expect(h.editors[h.editors.length - 1].revealRangeInCenter).toHaveBeenCalledWith(expectedRange);
  });

  it('refuses a range whose file changed after the location was computed', async () => {
    mockReadFile.mockResolvedValue(textResult('new content with an inserted line\nmore'));
    const onRevealApplied = vi.fn();

    render(
      <FileViewer
        {...defaultProps}
        selectedPath="b.txt"
        reveal={revealB}
        onRevealApplied={onRevealApplied}
      />,
    );

    await waitFor(() => expect(onRevealApplied).toHaveBeenCalledTimes(1));
    // The buffer is newer than the range, so the old coordinates are not applied.
    expect(h.reveals).toHaveLength(0);
    expect(toast.info).toHaveBeenCalledWith(expect.stringMatching(/no longer current/i));
  });

  it('applies a repeat click after the file is reread at the located revision', async () => {
    mockReadFile
      .mockResolvedValueOnce(textResult('changed content with a new line\n'))
      .mockResolvedValueOnce(textResult('B content'));
    const onRevealApplied = vi.fn();
    const { rerender } = render(
      <FileViewer
        {...defaultProps}
        selectedPath="b.txt"
        reveal={revealB}
        onRevealApplied={onRevealApplied}
      />,
    );

    await waitFor(() => expect(onRevealApplied).toHaveBeenCalledTimes(1));
    expect(h.reveals).toHaveLength(0);
    expect(toast.info).toHaveBeenCalledTimes(1);

    // The parent clears the refused request; a new click carries a new reveal
    // object and rereads the file, which now matches the located revision.
    rerender(<FileViewer {...defaultProps} selectedPath="b.txt" reveal={null} onRevealApplied={onRevealApplied} />);
    rerender(
      <FileViewer
        {...defaultProps}
        selectedPath="b.txt"
        reloadKey={1}
        reveal={{ ...revealB }}
        onRevealApplied={onRevealApplied}
      />,
    );

    await waitFor(() => expect(onRevealApplied).toHaveBeenCalledTimes(2));
    expect(h.reveals).toHaveLength(1);
    expect(h.editors[h.editors.length - 1].revealRangeInCenter).toHaveBeenCalledWith(expectedRange);
  });

  it('refuses a range that carries no source revision', async () => {
    mockReadFile.mockResolvedValue(textResult('B content'));
    const onRevealApplied = vi.fn();
    const unbound: AuthoredLocation = {
      file: 'b.txt',
      line: 3,
      column: 2,
      endLine: 4,
      endColumn: 9,
    };

    render(
      <FileViewer
        {...defaultProps}
        selectedPath="b.txt"
        reveal={unbound}
        onRevealApplied={onRevealApplied}
      />,
    );

    await waitFor(() => expect(onRevealApplied).toHaveBeenCalledTimes(1));
    expect(h.reveals).toHaveLength(0);
  });
});
