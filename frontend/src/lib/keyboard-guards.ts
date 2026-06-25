export function isInputFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return true;
  // Monaco's EditContext surface (Chromium) is a plain focusable <div>, not a textarea or
  // contentEditable element, so the checks above miss it. Treat any focus inside the editor
  // container as input focus, matching the textarea fallback other browsers already get.
  return !!el.closest('.monaco-editor');
}

export function isPaletteOpen(): boolean {
  return !!document.querySelector('[role="dialog"] [cmdk-root]');
}
