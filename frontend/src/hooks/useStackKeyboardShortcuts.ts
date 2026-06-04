import { useEffect, useRef } from 'react';
import type { StackMenuCtx } from '@/components/sidebar/sidebar-types';
import { isInputFocused, isPaletteOpen } from '@/lib/keyboard-guards';

export function useStackKeyboardShortcuts(
  selectedFile: string | null,
  buildMenuCtx: (file: string) => StackMenuCtx,
) {
  const selectedFileRef = useRef(selectedFile);
  const buildMenuCtxRef = useRef(buildMenuCtx);

  useEffect(() => { selectedFileRef.current = selectedFile; }, [selectedFile]);
  useEffect(() => { buildMenuCtxRef.current = buildMenuCtx; }, [buildMenuCtx]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const file = selectedFileRef.current;
      if (!file) return;
      if (isInputFocused()) return;
      if (isPaletteOpen()) return;

      const cmdOrCtrl = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      const isCmdKey = cmdOrCtrl && ['enter', '.', 'r', 'arrowup', 'backspace'].includes(key);
      const isSingleKey = !cmdOrCtrl && ['a', 'h', 'u', 'p'].includes(key);
      if (!isCmdKey && !isSingleKey) return;

      const ctx = buildMenuCtxRef.current(file);
      const { showDeploy, showStop, showRestart, showUpdate } = ctx.menuVisibility;

      if (cmdOrCtrl) {
        if (key === 'enter' && showDeploy && !ctx.isBusy) {
          e.preventDefault();
          ctx.deploy();
        } else if (key === '.' && showStop && !ctx.isBusy) {
          e.preventDefault();
          ctx.stop();
        } else if (key === 'r' && showRestart && !ctx.isBusy) {
          e.preventDefault();
          ctx.restart();
        } else if (key === 'arrowup' && showUpdate && !ctx.isBusy) {
          e.preventDefault();
          ctx.update();
        } else if (key === 'backspace' && ctx.canDelete && !ctx.isBusy) {
          e.preventDefault();
          ctx.remove();
        }
        return;
      }

      if (key === 'a') {
        e.preventDefault();
        ctx.openAlertSheet();
      } else if (key === 'h') {
        e.preventDefault();
        ctx.openAutoHeal();
      } else if (key === 'u') {
        e.preventDefault();
        ctx.checkUpdates();
      } else if (key === 'p') {
        e.preventDefault();
        if (ctx.isPinned) ctx.unpin();
        else ctx.pin();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
