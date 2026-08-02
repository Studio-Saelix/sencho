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

      const isCmdKey = cmdOrCtrl && ['enter', '.', 'r', 'arrowup', 'arrowdown', 'backspace'].includes(key);
      const isSingleKey = !cmdOrCtrl && ['a', 'h', 'u', 'p'].includes(key);
      if (!isCmdKey && !isSingleKey) return;

      const ctx = buildMenuCtxRef.current(file);
      const { showDeploy, showStop, showRestart, showUpdate, showTakeDown } = ctx.menuVisibility;
      const canDeploy = (show: boolean) => ctx.canDeploy && show && !ctx.isBusy;

      if (cmdOrCtrl) {
        if (key === 'enter' && canDeploy(showDeploy)) {
          e.preventDefault();
          ctx.deploy();
        } else if (key === '.' && canDeploy(showStop)) {
          e.preventDefault();
          ctx.stop();
        } else if (key === 'r' && canDeploy(showRestart)) {
          e.preventDefault();
          ctx.restart();
        } else if (key === 'arrowup' && canDeploy(showUpdate)) {
          e.preventDefault();
          ctx.update();
        } else if (key === 'arrowdown' && canDeploy(showTakeDown)) {
          e.preventDefault();
          ctx.takeDown();
        } else if (key === 'backspace' && ctx.canDelete && !ctx.isBusy) {
          e.preventDefault();
          ctx.remove();
        }
        return;
      }

      if (key === 'a') {
        if (!ctx.canViewMonitor) return;
        e.preventDefault();
        ctx.openAlertSheet();
      } else if (key === 'h') {
        if (!ctx.canViewMonitor) return;
        e.preventDefault();
        ctx.openAutoHeal();
      } else if (key === 'u') {
        if (!ctx.canCheckUpdates) return;
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
