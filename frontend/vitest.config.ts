import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    // jsdom only instantiates window.localStorage / sessionStorage when the
    // document has a real same-origin URL. The default about:blank origin is
    // opaque and can leave both APIs undefined depending on the jsdom build,
    // causing any test that touches localStorage in beforeEach to throw.
    // Setting an explicit URL is the documented jsdom workaround and changes
    // no test or app code.
    environmentOptions: {
      jsdom: { url: 'http://localhost' },
    },
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: false,
  },
});
