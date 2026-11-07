/**
 * Production-caller regressions for the compose alias-expansion guard.
 *
 * These run the real guard (nothing is mocked except the Docker child) so a
 * caller cannot pass its own mocked checker and still hand Compose a file the
 * guard would have refused. Each case covers one audited bypass: an
 * environment-selected file, an include/extends dependency, and a UTF-16
 * encoding.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { promises as fsPromises } from 'fs';
import os from 'os';
import path from 'path';

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

import { planPersistentBindRemap, PERSISTENT_BIND_UNSAFE } from '../services/gitops/sops/persistentBinds';

function nestedAliasBomb(levels: number): string {
  const lines = ['x0: &a0 [lol, lol, lol, lol, lol, lol, lol, lol, lol]'];
  for (let level = 1; level <= levels; level += 1) {
    const refs = Array.from({ length: 9 }, () => `*a${level - 1}`).join(', ');
    lines.push(`x${level}: &a${level} [${refs}]`);
  }
  lines.push('services:', '  web:', '    image: nginx:alpine');
  return `${lines.join('\n')}\n`;
}

const SAFE_COMPOSE = 'services:\n  web:\n    image: nginx:alpine\n';

function encodeUtf16(text: string, endianness: 'le' | 'be'): Buffer {
  const body = Buffer.from(text, 'utf16le');
  if (endianness === 'le') return Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
  const swapped = Buffer.from(body);
  swapped.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), swapped]);
}

let root: string;
let overlay: string;

beforeEach(async () => {
  mockSpawn.mockReset();
  root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-compose-caller-'));
  overlay = path.join(root, 'overlay');
  await fsPromises.mkdir(overlay, { recursive: true });
});

afterEach(async () => {
  await fsPromises.rm(root, { recursive: true, force: true });
});

async function writeOverlay(name: string, content: string | Buffer): Promise<void> {
  const target = path.join(overlay, name);
  await fsPromises.mkdir(path.dirname(target), { recursive: true });
  await fsPromises.writeFile(target, content);
}

function remap(composeArgs: string[]) {
  return planPersistentBindRemap({
    overlayDir: overlay,
    liveRoot: path.join(root, 'live'),
    liveComposeRoot: path.join(root, 'compose'),
    secretsRoot: root,
    composeArgs,
    refuseIfUnreadable: true,
  });
}

describe('persistent bind remap caller uses the real guard', () => {
  it('does not start Compose when the project .env selects a bomb', async () => {
    await writeOverlay('.env', 'COMPOSE_FILE=selected.yaml\n');
    await writeOverlay('selected.yaml', nestedAliasBomb(12));
    await writeOverlay('compose.yaml', SAFE_COMPOSE);

    await expect(remap(['compose', 'config', '--format', 'json']))
      .resolves.toEqual({ action: 'refuse', reason: PERSISTENT_BIND_UNSAFE });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('does not start Compose when an include dependency is a bomb', async () => {
    await writeOverlay('compose.yaml', 'include:\n  - shared/bomb.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await writeOverlay('shared/bomb.yaml', nestedAliasBomb(12));

    await expect(remap(['compose', '-f', 'compose.yaml', 'config', '--format', 'json']))
      .resolves.toEqual({ action: 'refuse', reason: PERSISTENT_BIND_UNSAFE });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('does not start Compose when an extends dependency is a UTF-16 bomb', async () => {
    await writeOverlay('compose.yaml', [
      'services:',
      '  web:',
      '    extends:',
      '      file: base.yaml',
      '      service: base',
    ].join('\n'));
    await writeOverlay('base.yaml', encodeUtf16(nestedAliasBomb(12), 'be'));

    await expect(remap(['compose', '-f', 'compose.yaml', 'config', '--format', 'json']))
      .resolves.toEqual({ action: 'refuse', reason: PERSISTENT_BIND_UNSAFE });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('still starts Compose for an ordinary project', async () => {
    await writeOverlay('compose.yaml', SAFE_COMPOSE);
    // The child is mocked, so a spawn here proves only that the guard let the
    // input through; it is not a Compose execution.
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from('{}'));
        child.emit('close', 0);
      });
      return child;
    });

    await remap(['compose', '-f', 'compose.yaml', 'config', '--format', 'json']);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});
