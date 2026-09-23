import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? MockResizeObserver;

// jsdom does not implement these, but Radix Select's trigger reads them on
// pointerdown/keyboard open, so without a stub the click crashes before the
// listbox ever renders.
if (typeof Element !== 'undefined') {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}

type StorageName = 'localStorage' | 'sessionStorage';

class TestStorage {
  private readonly store = new Map<string, string>();

  get length() {
    return this.store.size;
  }

  clear() {
    this.store.clear();
  }

  getItem(key: string) {
    return this.store.get(String(key)) ?? null;
  }

  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.store.delete(String(key));
  }

  setItem(key: string, value: string) {
    this.store.set(String(key), String(value));
  }
}

function getUsableStorage(name: StorageName): Storage {
  try {
    const storage = window[name];
    storage.setItem('__sencho_storage_probe__', '1');
    storage.removeItem('__sencho_storage_probe__');
    return storage;
  } catch {
    return new TestStorage() as Storage;
  }
}

function defineStorage(name: StorageName, storage: Storage) {
  for (const target of [window, globalThis]) {
    try {
      Object.defineProperty(target, name, {
        value: storage,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    } catch {
      Reflect.set(target, name, storage);
    }
  }
}

if (typeof window !== 'undefined') {
  defineStorage('localStorage', getUsableStorage('localStorage'));
  defineStorage('sessionStorage', getUsableStorage('sessionStorage'));
}

if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

afterEach(() => {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  cleanup();
  // jsdom 30.1 drops a removed focused element without firing blur; the next
  // focus() call then synchronously fires a blur retargeted at the window,
  // which would land mid-click in the next test and trip Radix's
  // close-menu-on-window-blur handler. Force a focus change on a scratch
  // element here so the stale blur fires before the next test starts.
  const scratch = document.createElement('button');
  document.body.appendChild(scratch);
  scratch.focus();
  scratch.blur();
  scratch.remove();
});
