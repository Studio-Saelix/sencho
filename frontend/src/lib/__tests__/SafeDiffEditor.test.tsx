import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { DiffEditorProps } from '@monaco-editor/react';

let lastDiffProps: DiffEditorProps | null = null;
let disposeCalls: string[] = [];

vi.mock('@/lib/monacoLoader', () => ({
  DiffEditor: (props: DiffEditorProps) => {
    lastDiffProps = props;
    if (props.onMount) {
      const original = { dispose: () => disposeCalls.push('original.dispose') };
      const modified = { dispose: () => disposeCalls.push('modified.dispose') };
      let attached: { original: typeof original; modified: typeof modified } | null = {
        original,
        modified,
      };
      props.onMount({
        getModel: () => attached,
        setModel: (next: typeof attached) => {
          disposeCalls.push('setModel');
          attached = next;
        },
        dispose: () => {
          if (attached) {
            throw new Error('TextModel got disposed before DiffEditorWidget model got reset');
          }
          disposeCalls.push('editor.dispose');
        },
      } as never, {} as never);
    }
    return <div data-testid="diff-editor" />;
  },
}));

import { SafeDiffEditor } from '../SafeDiffEditor';

describe('SafeDiffEditor', () => {
  it('keeps current models and resets the widget before disposing them', () => {
    disposeCalls = [];
    const { unmount } = render(
      <SafeDiffEditor
        height="100%"
        language="yaml"
        original="a"
        modified="b"
      />,
    );
    expect(lastDiffProps?.keepCurrentOriginalModel).toBe(true);
    expect(lastDiffProps?.keepCurrentModifiedModel).toBe(true);
    unmount();
    expect(disposeCalls.indexOf('setModel')).toBeGreaterThanOrEqual(0);
    expect(disposeCalls.indexOf('setModel')).toBeLessThan(disposeCalls.indexOf('original.dispose'));
    expect(disposeCalls.indexOf('setModel')).toBeLessThan(disposeCalls.indexOf('modified.dispose'));
    expect(disposeCalls.indexOf('editor.dispose')).toBeGreaterThan(disposeCalls.indexOf('setModel'));
  });
});
