import { lazy } from 'react';

/**
 * Lazy-loaded Monaco. Replaces the eager imports that used to live in
 * `main.tsx`. The 3 MB monaco-editor + @monaco-editor/react chunk no longer
 * loads on cold app start; it loads the first time any consumer renders an
 * editor, and subsequent editor mounts reuse the already-loaded module.
 *
 * `setupMonaco` registers the locally bundled Monaco with @monaco-editor/react
 * (so it does not fetch from the CDN, which the CSP `script-src 'self'` blocks)
 * and wires the editor worker. The setup runs at most once per process; the
 * shared promise dedupes concurrent first mounts.
 */

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker: (workerId: string, label: string) => Worker };
  }
}

let setupPromise: Promise<void> | null = null;

function setupMonaco(): Promise<void> {
  if (!setupPromise) {
    setupPromise = (async () => {
      const [monacoMod, reactMonaco, editorWorkerMod] = await Promise.all([
        import('monaco-editor'),
        import('@monaco-editor/react'),
        import('monaco-editor/editor/editor.worker?worker'),
      ]);
      window.MonacoEnvironment = {
        getWorker(): Worker {
          return new editorWorkerMod.default();
        },
      };
      reactMonaco.loader.config({ monaco: monacoMod });
    })();
  }
  return setupPromise;
}

export const Editor = lazy(async () => {
  await setupMonaco();
  const mod = await import('@monaco-editor/react');
  return { default: mod.default };
});

export const DiffEditor = lazy(async () => {
  await setupMonaco();
  const mod = await import('@monaco-editor/react');
  return { default: mod.DiffEditor };
});
