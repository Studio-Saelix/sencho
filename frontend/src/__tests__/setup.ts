import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? MockResizeObserver;

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
  cleanup();
});
