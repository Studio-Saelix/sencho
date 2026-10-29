/**
 * Copy text to the clipboard with a fallback for non-secure contexts.
 *
 * The Clipboard API (`navigator.clipboard`) is only available in secure
 * contexts (HTTPS, localhost, or 127.0.0.1). Self-hosted Sencho is commonly
 * accessed over plain HTTP on LAN IPs, so we fall back to the legacy
 * `document.execCommand('copy')` path when the modern API is unavailable
 * or rejects.
 *
 * Rejects only when both paths fail.
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof window !== 'undefined' &&
    window.isSecureContext
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to legacy fallback
    }
  }

  // A modal dialog traps focus, so a textarea appended to <body> never takes
  // focus: the trap hands focus back, nothing is selected, and
  // `execCommand('copy')` still returns true. Mount the textarea inside the
  // dialog the copy control lives in, and refuse to report success unless it
  // really holds focus.
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const host = previous?.closest('[role="dialog"], [role="alertdialog"]') ?? document.body;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  host.appendChild(ta);
  ta.focus({ preventScroll: true });
  ta.select();
  try {
    if (document.activeElement !== ta) throw new Error('clipboard fallback could not take focus');
    const ok = document.execCommand('copy');
    if (!ok) throw new Error('execCommand copy returned false');
  } finally {
    host.removeChild(ta);
    // Removing the focused textarea would otherwise drop focus to <body>,
    // which a focus trap answers by jumping to its first control.
    previous?.focus({ preventScroll: true });
  }
}
