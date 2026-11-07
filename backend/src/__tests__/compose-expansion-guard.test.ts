/**
 * Unit tests for the compose alias-expansion guard. These run against the real
 * filesystem because the guard's contract is what it reads, not how a caller
 * mocks it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsPromises } from 'fs';
import os from 'os';
import path from 'path';
import {
  assertComposeInputsWithinExpansionLimits,
  assertComposeSourceWithinExpansionLimits,
  composeFileArgsFromInvocation,
  MAX_COMPOSE_INPUT_BYTES,
  ComposeExpansionRefusal,
} from '../helpers/composeExpansionGuard';

/**
 * The reported file shape: each level holds nine references to the previous
 * one, so the fully expanded node count grows by roughly 9^n.
 */
function nestedAliasBomb(levels: number): string {
  const lines = ['x0: &a0 [lol, lol, lol, lol, lol, lol, lol, lol, lol]'];
  for (let level = 1; level <= levels; level += 1) {
    const refs = Array.from({ length: 9 }, () => `*a${level - 1}`).join(', ');
    lines.push(`x${level}: &a${level} [${refs}]`);
  }
  lines.push('services:', '  web:', '    image: nginx:alpine');
  return `${lines.join('\n')}\n`;
}

let dir: string;

beforeEach(async () => {
  dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-compose-guard-'));
});

afterEach(async () => {
  await fsPromises.rm(dir, { recursive: true, force: true });
});

describe('assertComposeSourceWithinExpansionLimits', () => {
  it('accepts a compose file that reuses anchors across many services', () => {
    const services = Array.from({ length: 200 }, (_, i) =>
      `  svc${i}:\n    <<: *logging\n    image: nginx:alpine`);
    const source = [
      'x-logging: &logging',
      '  logging:',
      '    driver: json-file',
      '    options:',
      '      max-size: 10m',
      '      max-file: "3"',
      'services:',
      ...services,
    ].join('\n');
    expect(() => assertComposeSourceWithinExpansionLimits(source, 'compose.yaml')).not.toThrow();
  });

  it('refuses a nested alias bomb with a clear refusal', () => {
    let error: unknown;
    try {
      assertComposeSourceWithinExpansionLimits(nestedAliasBomb(12), 'compose.yaml');
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ComposeExpansionRefusal);
    const message = (error as Error).message;
    expect(message).toContain('compose.yaml');
    expect(message).toContain('nested YAML aliases');
    expect(message).toContain('host out of memory');
  });

  it('refuses at the budget boundary and accepts below it', () => {
    expect(() => assertComposeSourceWithinExpansionLimits(nestedAliasBomb(4), 'a.yaml')).not.toThrow();
    expect(() => assertComposeSourceWithinExpansionLimits(nestedAliasBomb(5), 'b.yaml')).toThrow(ComposeExpansionRefusal);
  });

  it('leaves an unresolved alias for Compose to report', () => {
    expect(() => assertComposeSourceWithinExpansionLimits('services:\n  web: *missing\n', 'compose.yaml'))
      .not.toThrow();
  });

  it('leaves a YAML syntax error for Compose to report', () => {
    expect(() => assertComposeSourceWithinExpansionLimits('services:\n  web: [1\n', 'compose.yaml'))
      .not.toThrow();
  });

  it('leaves a syntax error for Compose even when the same document also holds a bomb', () => {
    const source = `${nestedAliasBomb(12)}  broken: [\n`;
    expect(() => assertComposeSourceWithinExpansionLimits(source, 'compose.yaml')).not.toThrow();
  });

  it('accepts an empty document', () => {
    expect(() => assertComposeSourceWithinExpansionLimits('', 'compose.yaml')).not.toThrow();
  });
});

describe('assertComposeInputsWithinExpansionLimits', () => {
  it('refuses a bomb named by an explicit -f value', async () => {
    await fsPromises.writeFile(path.join(dir, 'custom.yaml'), nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      files: ['custom.yaml'],
    })).rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('discovers compose.yaml when the invocation names no file', async () => {
    await fsPromises.writeFile(path.join(dir, 'compose.yaml'), nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('does not read a default override beside an explicit -f, which Compose also skips', async () => {
    await fsPromises.writeFile(path.join(dir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:alpine\n');
    await fsPromises.writeFile(path.join(dir, 'compose.override.yaml'), nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      files: ['compose.yaml'],
    })).resolves.toBeUndefined();
  });

  it('does not read a default override beside an explicitly renamed file', async () => {
    await fsPromises.writeFile(path.join(dir, 'custom.yaml'), 'services:\n  web:\n    image: nginx:alpine\n');
    await fsPromises.writeFile(path.join(dir, 'compose.override.yaml'), nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      files: ['custom.yaml'],
    })).resolves.toBeUndefined();
  });

  it('reads only the file Compose selects, not a lower-priority name it ignores', async () => {
    await fsPromises.writeFile(path.join(dir, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx:alpine\n');
    await fsPromises.writeFile(path.join(dir, 'docker-compose.yaml'), nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir })).resolves.toBeUndefined();
  });

  it('reads only the override Compose selects', async () => {
    await fsPromises.writeFile(path.join(dir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:alpine\n');
    await fsPromises.writeFile(path.join(dir, 'compose.override.yml'), 'services:\n  extra:\n    image: nginx:alpine\n');
    await fsPromises.writeFile(path.join(dir, 'compose.override.yaml'), nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir })).resolves.toBeUndefined();
  });

  it('skips a file that does not exist and lets Compose report it', async () => {
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      files: ['missing.yaml'],
    })).resolves.toBeUndefined();
  });

  it('refuses a source larger than the read cap', async () => {
    await fsPromises.writeFile(
      path.join(dir, 'compose.yaml'),
      `# ${'x'.repeat(MAX_COMPOSE_INPUT_BYTES)}\n`,
    );
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir }))
      .rejects.toThrow(/larger than 16 MiB/);
  });
});

describe('composeFileArgsFromInvocation', () => {
  it('reads -f, --file and --file= forms in order', () => {
    expect(composeFileArgsFromInvocation([
      'compose', '-f', 'a.yaml', '--file', 'b.yaml', '--file=c.yaml', 'config', '--format', 'json',
    ])).toEqual(['a.yaml', 'b.yaml', 'c.yaml']);
  });

  it('returns nothing when the invocation lets Compose discover its files', () => {
    expect(composeFileArgsFromInvocation(['compose', 'config', '--format', 'json'])).toEqual([]);
  });
});
