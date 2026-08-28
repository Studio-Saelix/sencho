import crypto from 'crypto';
import { describe, it, expect } from 'vitest';
import { hashActionSet, hashProjectSource } from '../helpers/registryDeliveryHashes';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('registryDeliveryHashes', () => {
  it('hashActionSet is order-independent', () => {
    const a = hashActionSet(['stack:deploy', 'stack:edit']);
    const b = hashActionSet(['stack:edit', 'stack:deploy']);
    expect(a).toBe(b);
  });

  it('hashProjectSource is not raw compose bytes', () => {
    const content = 'services:\n  web:\n    image: nginx\n';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-hash-test-'));
    try {
      fs.writeFileSync(path.join(dir, 'compose.yaml'), content);
      const projectHash = hashProjectSource(dir);
      const rawHash = crypto.createHash('sha256').update(content).digest('hex');
      expect(projectHash).not.toBe(rawHash);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hashProjectSource changes when compose content changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-hash-test-'));
    try {
      fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
      const before = hashProjectSource(dir);
      fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:2\n');
      const after = hashProjectSource(dir);
      expect(before).not.toBe(after);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
