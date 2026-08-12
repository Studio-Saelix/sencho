import { useEffect, useRef } from 'react';
import type { DiffEditorProps } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { DiffEditor } from './monacoLoader';

/**
 * DiffEditor wrapper that owns model disposal. keepCurrentOriginalModel and
 * keepCurrentModifiedModel stop @monaco-editor/react from disposing first.
 * On unmount this resets the widget (setModel(null)) then disposes the models.
 * Monaco 0.56 throws "TextModel got disposed before DiffEditorWidget model
 * got reset" if the library disposes models while the widget still holds them.
 */
export function SafeDiffEditor({ onMount, ...props }: DiffEditorProps) {
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<editor.IDiffEditorModel | null>(null);

  useEffect(() => {
    return () => {
      const diffEditor = editorRef.current;
      const models = modelsRef.current;
      modelsRef.current = null;
      try {
        diffEditor?.setModel(null);
        diffEditor?.dispose();
      } catch {
        // Widget already torn down by monaco-react.
      }
      try {
        models?.original.dispose();
        models?.modified.dispose();
      } catch {
        // Models already disposed.
      }
    };
  }, []);

  return (
    <DiffEditor
      {...props}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={(ed, monaco) => {
        editorRef.current = ed;
        modelsRef.current = ed.getModel();
        onMount?.(ed, monaco);
      }}
    />
  );
}
