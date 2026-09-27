import { copyToClipboard } from './clipboard';
import { toast } from '@/components/ui/toast-store';

/** The subset of the xterm `Terminal` API the clipboard wiring relies on. */
export interface ClipboardTerminal {
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  paste(data: string): void;
  focus(): void;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
}

/**
 * True when the async Clipboard API can read text. Browsers only expose
 * `navigator.clipboard.readText` in secure contexts (HTTPS, localhost,
 * 127.0.0.1); plain-HTTP LAN access does not get it.
 */
export function canReadClipboard(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext === true &&
    typeof navigator !== 'undefined' &&
    !!navigator.clipboard &&
    typeof navigator.clipboard.readText === 'function'
  );
}

/**
 * Keys that should reach the browser's native paste handling instead of
 * being translated into control characters by xterm. The native `paste`
 * event lands on xterm's hidden textarea and is forwarded through
 * `onData`, which works in both secure and non-secure contexts.
 */
export function isPasteShortcut(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown') return false;
  const key = event.key.toLowerCase();
  if (event.shiftKey && key === 'insert' && !event.ctrlKey && !event.metaKey && !event.altKey) return true;
  return key === 'v' && event.ctrlKey && !event.metaKey && !event.altKey;
}

/**
 * Wire copy/paste into an interactive xterm instance.
 *
 * - Right-click with a selection copies it (and clears the selection).
 * - Right-click without a selection pastes. In secure contexts the text is
 *   read via the Clipboard API; otherwise the terminal's textarea is focused
 *   so the browser's own context menu "Paste" targets it.
 * - Ctrl+V, Ctrl+Shift+V and Shift+Insert fall through to the native paste
 *   event instead of being sent as control characters.
 *
 * Returns a cleanup function that removes the contextmenu listener. The key
 * handler stays until the terminal is disposed (xterm has no detach for it).
 */
export function attachTerminalClipboard(term: ClipboardTerminal, container: HTMLElement): () => void {
  term.attachCustomKeyEventHandler((event) => !isPasteShortcut(event));

  const onContextMenu = (event: MouseEvent) => {
    if (term.hasSelection()) {
      event.preventDefault();
      const selection = term.getSelection();
      if (selection) {
        copyToClipboard(selection)
          .then(() => term.clearSelection())
          .catch((err) => {
            console.warn('Terminal copy failed:', err);
            toast.error('Could not copy the selection to the clipboard.');
          });
      }
      term.focus();
      return;
    }

    if (canReadClipboard()) {
      event.preventDefault();
      term.focus();
      navigator.clipboard.readText()
        .then((text) => { if (text) term.paste(text); })
        .catch((err) => {
          // Usually a denied permission; keyboard paste does not need it.
          console.warn('Terminal clipboard read failed:', err);
          toast.error('Clipboard access was blocked. Paste with Ctrl+V, or allow clipboard access for this site.');
        });
      return;
    }

    // Non-secure context: keep the native menu, but make sure the terminal's
    // textarea is the focused editable so its "Paste" entry reaches xterm.
    term.focus();
  };

  container.addEventListener('contextmenu', onContextMenu);
  return () => container.removeEventListener('contextmenu', onContextMenu);
}
