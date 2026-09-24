import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { attachTerminalClipboard, canReadClipboard, isPasteShortcut, type ClipboardTerminal } from './terminalClipboard';
import { copyToClipboard } from './clipboard';
import { toast } from '@/components/ui/toast-store';

vi.mock('./clipboard', () => ({
  copyToClipboard: vi.fn(async () => undefined),
}));

vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn() },
}));

const originalIsSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function setSecureContext(value: boolean): void {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value });
}

function setReadText(readText: (() => Promise<string>) | undefined): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: readText ? { readText } : undefined,
  });
}

function makeTerm(selection = ''): ClipboardTerminal & {
  keyHandler: ((e: KeyboardEvent) => boolean) | null;
  paste: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  clearSelection: ReturnType<typeof vi.fn>;
} {
  const term = {
    keyHandler: null as ((e: KeyboardEvent) => boolean) | null,
    hasSelection: vi.fn(() => selection.length > 0),
    getSelection: vi.fn(() => selection),
    clearSelection: vi.fn(),
    paste: vi.fn(),
    focus: vi.fn(),
    attachCustomKeyEventHandler: vi.fn((h: (e: KeyboardEvent) => boolean) => { term.keyHandler = h; }),
  };
  return term;
}

function rightClick(el: HTMLElement): MouseEvent {
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
  el.dispatchEvent(ev);
  return ev;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('terminalClipboard', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.mocked(copyToClipboard).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  afterEach(() => {
    container.remove();
    if (originalIsSecureContext) Object.defineProperty(window, 'isSecureContext', originalIsSecureContext);
    else delete (window as { isSecureContext?: boolean }).isSecureContext;
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else delete (navigator as { clipboard?: Clipboard }).clipboard;
  });

  describe('canReadClipboard', () => {
    it('is true in a secure context with readText', () => {
      setSecureContext(true);
      setReadText(async () => '');
      expect(canReadClipboard()).toBe(true);
    });

    it('is false over plain HTTP', () => {
      setSecureContext(false);
      setReadText(async () => '');
      expect(canReadClipboard()).toBe(false);
    });

    it('is false when the Clipboard API is missing', () => {
      setSecureContext(true);
      setReadText(undefined);
      expect(canReadClipboard()).toBe(false);
    });
  });

  describe('isPasteShortcut', () => {
    const key = (init: KeyboardEventInit, type = 'keydown') => new KeyboardEvent(type, init);

    it('matches Ctrl+V, Ctrl+Shift+V and Shift+Insert', () => {
      expect(isPasteShortcut(key({ key: 'v', ctrlKey: true }))).toBe(true);
      expect(isPasteShortcut(key({ key: 'V', ctrlKey: true, shiftKey: true }))).toBe(true);
      expect(isPasteShortcut(key({ key: 'Insert', shiftKey: true }))).toBe(true);
    });

    it('ignores other keys and keyup events', () => {
      expect(isPasteShortcut(key({ key: 'v' }))).toBe(false);
      expect(isPasteShortcut(key({ key: 'c', ctrlKey: true }))).toBe(false);
      expect(isPasteShortcut(key({ key: 'v', ctrlKey: true, altKey: true }))).toBe(false);
      expect(isPasteShortcut(key({ key: 'v', ctrlKey: true }, 'keyup'))).toBe(false);
    });
  });

  it('lets paste shortcuts bypass xterm key processing', () => {
    const term = makeTerm();
    attachTerminalClipboard(term, container);
    expect(term.keyHandler).not.toBeNull();
    expect(term.keyHandler!(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true }))).toBe(false);
    expect(term.keyHandler!(new KeyboardEvent('keydown', { key: 'a' }))).toBe(true);
  });

  it('pastes clipboard text on right-click in a secure context', async () => {
    setSecureContext(true);
    const readText = vi.fn(async () => 'echo hello');
    setReadText(readText);
    const term = makeTerm();
    attachTerminalClipboard(term, container);

    const ev = rightClick(container);
    await flush();

    expect(ev.defaultPrevented).toBe(true);
    expect(readText).toHaveBeenCalledTimes(1);
    expect(term.paste).toHaveBeenCalledWith('echo hello');
  });

  it('does not paste when the clipboard read is denied', async () => {
    setSecureContext(true);
    setReadText(vi.fn(async () => { throw new Error('denied'); }));
    const term = makeTerm();
    attachTerminalClipboard(term, container);

    rightClick(container);
    await flush();

    expect(term.paste).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('keeps the selection and reports when the copy fails', async () => {
    vi.mocked(copyToClipboard).mockRejectedValueOnce(new Error('blocked'));
    const term = makeTerm('selected text');
    attachTerminalClipboard(term, container);

    rightClick(container);
    await flush();

    expect(term.clearSelection).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('keeps the native menu and focuses the terminal over plain HTTP', () => {
    setSecureContext(false);
    const readText = vi.fn(async () => 'x');
    setReadText(readText);
    const term = makeTerm();
    attachTerminalClipboard(term, container);

    const ev = rightClick(container);

    expect(ev.defaultPrevented).toBe(false);
    expect(readText).not.toHaveBeenCalled();
    expect(term.focus).toHaveBeenCalled();
  });

  it('copies the selection on right-click instead of pasting', async () => {
    setSecureContext(true);
    const readText = vi.fn(async () => 'x');
    setReadText(readText);
    const term = makeTerm('selected text');
    attachTerminalClipboard(term, container);

    const ev = rightClick(container);
    await flush();

    expect(ev.defaultPrevented).toBe(true);
    expect(copyToClipboard).toHaveBeenCalledWith('selected text');
    expect(term.clearSelection).toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
    expect(term.paste).not.toHaveBeenCalled();
  });

  it('removes the listener on cleanup', async () => {
    setSecureContext(true);
    const readText = vi.fn(async () => 'x');
    setReadText(readText);
    const term = makeTerm();
    const detach = attachTerminalClipboard(term, container);
    detach();

    const ev = rightClick(container);
    await flush();

    expect(ev.defaultPrevented).toBe(false);
    expect(readText).not.toHaveBeenCalled();
  });
});
