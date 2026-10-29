import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { copyToClipboard } from './clipboard';

const originalIsSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');

function setSecureContext(value: boolean): void {
  Object.defineProperty(window, 'isSecureContext', {
    configurable: true,
    value,
  });
}

function setNavigatorClipboard(clipboard: Clipboard | undefined): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: clipboard,
  });
}

function setExecCommand(impl: () => boolean): ReturnType<typeof vi.fn> {
  const fn = vi.fn(impl);
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    writable: true,
    value: fn,
  });
  return fn;
}

describe('copyToClipboard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalIsSecureContext) Object.defineProperty(window, 'isSecureContext', originalIsSecureContext);
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else delete (navigator as { clipboard?: unknown }).clipboard;
    if (originalExecCommand) Object.defineProperty(document, 'execCommand', originalExecCommand);
    else delete (document as { execCommand?: unknown }).execCommand;
  });

  it('uses navigator.clipboard in a secure context', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setSecureContext(true);
    setNavigatorClipboard({ writeText } as unknown as Clipboard);

    await copyToClipboard('hello');

    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand when not in a secure context', async () => {
    setSecureContext(false);
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigatorClipboard({ writeText } as unknown as Clipboard);
    const execCommand = setExecCommand(() => true);

    await copyToClipboard('lan-host');

    expect(writeText).not.toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('falls back to execCommand when clipboard API rejects', async () => {
    setSecureContext(true);
    const writeText = vi.fn().mockRejectedValue(new Error('blocked'));
    setNavigatorClipboard({ writeText } as unknown as Clipboard);
    const execCommand = setExecCommand(() => true);

    await copyToClipboard('rejected');

    expect(writeText).toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('rejects when both modern API and execCommand fail and removes the textarea', async () => {
    setSecureContext(false);
    setNavigatorClipboard(undefined);
    setExecCommand(() => false);

    await expect(copyToClipboard('nope')).rejects.toThrow();
    expect(document.querySelectorAll('textarea').length).toBe(0);
  });

  it('removes the textarea after using the fallback', async () => {
    setSecureContext(false);
    setNavigatorClipboard(undefined);
    setExecCommand(() => true);

    await copyToClipboard('cleanup');

    expect(document.querySelectorAll('textarea').length).toBe(0);
  });

  describe('inside a focus-trapping dialog', () => {
    function mountTrappedDialog(role = 'dialog'): { dialog: HTMLElement; button: HTMLButtonElement; release: () => void } {
      const dialog = document.createElement('div');
      dialog.setAttribute('role', role);
      const button = document.createElement('button');
      dialog.appendChild(button);
      document.body.appendChild(dialog);
      button.focus();
      // What a modal's focus trap does: focus that lands outside it is handed back.
      const onFocusIn = (event: FocusEvent): void => {
        if (!dialog.contains(event.target as Node)) button.focus();
      };
      document.addEventListener('focusin', onFocusIn);
      return {
        dialog,
        button,
        release: () => {
          document.removeEventListener('focusin', onFocusIn);
          dialog.remove();
        },
      };
    }

    it.each(['dialog', 'alertdialog', 'menu'])('selects the text from a textarea mounted inside a %s, then returns focus to the control', async (role) => {
      setSecureContext(false);
      setNavigatorClipboard(undefined);
      const { dialog, button, release } = mountTrappedDialog(role);
      let copiedFrom: { active: Element | null; parent: Element | null; selected: string } | null = null;
      setExecCommand(() => {
        const ta = document.activeElement as HTMLTextAreaElement | null;
        copiedFrom = {
          active: ta,
          parent: ta?.parentElement ?? null,
          selected: ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : '',
        };
        return true;
      });

      try {
        await copyToClipboard('host.sencho:8080');

        expect(copiedFrom).not.toBeNull();
        expect(copiedFrom!.active?.tagName).toBe('TEXTAREA');
        expect(copiedFrom!.parent).toBe(dialog);
        expect(copiedFrom!.selected).toBe('host.sencho:8080');
        expect(document.activeElement).toBe(button);
        expect(document.querySelectorAll('textarea').length).toBe(0);
      } finally {
        release();
      }
    });

    it('rejects instead of reporting success when the textarea cannot take focus', async () => {
      setSecureContext(false);
      setNavigatorClipboard(undefined);
      const { button, release } = mountTrappedDialog();
      const execCommand = setExecCommand(() => true);
      vi.spyOn(HTMLTextAreaElement.prototype, 'focus').mockImplementation(() => {});

      try {
        await expect(copyToClipboard('nothing selected')).rejects.toThrow(/focus/);
        expect(execCommand).not.toHaveBeenCalled();
        expect(document.querySelectorAll('textarea').length).toBe(0);
        expect(document.activeElement).toBe(button);
      } finally {
        release();
      }
    });

    it('returns focus to the control when the copy command itself fails', async () => {
      setSecureContext(false);
      setNavigatorClipboard(undefined);
      const { button, release } = mountTrappedDialog();
      setExecCommand(() => false);
      try {
        await expect(copyToClipboard('x')).rejects.toThrow();
        expect(document.activeElement).toBe(button);
      } finally {
        release();
      }
    });

    it('uses the open dialog when focus is on the page body, as after a click in browsers that do not focus buttons', async () => {
      setSecureContext(false);
      setNavigatorClipboard(undefined);
      const { dialog, release } = mountTrappedDialog();
      (document.activeElement as HTMLElement).blur();
      expect(document.activeElement).toBe(document.body);
      let parent: Element | null = null;
      setExecCommand(() => {
        parent = document.activeElement?.parentElement ?? null;
        return true;
      });
      try {
        await copyToClipboard('from the body');
        expect(parent).toBe(dialog);
      } finally {
        release();
      }
    });
  });
});
