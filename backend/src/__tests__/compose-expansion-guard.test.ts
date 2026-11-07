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

const SAFE_COMPOSE = 'services:\n  web:\n    image: nginx:alpine\n';

/** Encode text the way a BOM-marked UTF-16 Compose file stores it. */
function encodeUtf16(text: string, endianness: 'le' | 'be'): Buffer {
  const body = Buffer.from(text, 'utf16le');
  if (endianness === 'le') return Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
  const swapped = Buffer.from(body);
  swapped.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), swapped]);
}

const ENV_KEYS = [
  'COMPOSE_FILE',
  'COMPOSE_PATH_SEPARATOR',
  'COMPOSE_ENV_FILES',
  'COMPOSE_DISABLE_ENV_FILE',
] as const;

let dir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-compose-guard-'));
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await fsPromises.rm(dir, { recursive: true, force: true });
});

async function write(name: string, content: string | Buffer): Promise<string> {
  const target = path.join(dir, name);
  await fsPromises.mkdir(path.dirname(target), { recursive: true });
  await fsPromises.writeFile(target, content);
  return target;
}

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

  it('measures every document of a safe YAML stream', () => {
    const source = `${SAFE_COMPOSE}---\nservices:\n  db:\n    image: postgres:16\n`;
    expect(() => assertComposeSourceWithinExpansionLimits(source, 'compose.yaml')).not.toThrow();
  });

  it('refuses a bomb in the first document of a stream', () => {
    const source = `${nestedAliasBomb(12)}---\n${SAFE_COMPOSE}`;
    expect(() => assertComposeSourceWithinExpansionLimits(source, 'compose.yaml'))
      .toThrow(ComposeExpansionRefusal);
  });

  it('refuses a bomb in a later document of a stream', () => {
    const source = `${SAFE_COMPOSE}---\n${nestedAliasBomb(12)}`;
    expect(() => assertComposeSourceWithinExpansionLimits(source, 'compose.yaml'))
      .toThrow(ComposeExpansionRefusal);
  });

  it('applies one budget to the whole stream, not one per document', () => {
    const document = nestedAliasBomb(4);
    // Each document is below the budget; their sum is not.
    expect(() => assertComposeSourceWithinExpansionLimits(document, 'one.yaml')).not.toThrow();
    const stream = Array.from({ length: 4 }, () => document).join('---\n');
    expect(() => assertComposeSourceWithinExpansionLimits(stream, 'stream.yaml'))
      .toThrow(ComposeExpansionRefusal);
  });

  it('refuses a bomb in a document before a later syntax error', () => {
    // Compose expands the valid first document before it reports the second
    // document's parse error, so the first document still has to be measured.
    const source = `${nestedAliasBomb(12)}---\nservices: [\n`;
    expect(() => assertComposeSourceWithinExpansionLimits(source, 'stream.yaml'))
      .toThrow(ComposeExpansionRefusal);
  });

  it('leaves a bomb after an earlier syntax error to Compose', () => {
    // Compose stops at the first document it cannot parse, so the later
    // document is never expanded and the guard does not need to refuse it.
    const source = `services: [\n---\n${nestedAliasBomb(12)}`;
    expect(() => assertComposeSourceWithinExpansionLimits(source, 'stream.yaml')).not.toThrow();
  });
});

describe('assertComposeInputsWithinExpansionLimits', () => {
  it('refuses a bomb named by an explicit -f value', async () => {
    await write('custom.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', '-f', 'custom.yaml', 'config'],
    })).rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('discovers compose.yaml when the invocation names no file', async () => {
    await write('compose.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('does not read a default override beside an explicit -f, which Compose also skips', async () => {
    await write('compose.yaml', SAFE_COMPOSE);
    await write('compose.override.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', '-f', 'compose.yaml', 'config'],
    })).resolves.toBeUndefined();
  });

  it('does not read a default override beside an explicitly renamed file', async () => {
    await write('custom.yaml', SAFE_COMPOSE);
    await write('compose.override.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', '-f', 'custom.yaml', 'config'],
    })).resolves.toBeUndefined();
  });

  it('reads only the file Compose selects, not a lower-priority name it ignores', async () => {
    await write('docker-compose.yml', SAFE_COMPOSE);
    await write('docker-compose.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .resolves.toBeUndefined();
  });

  it('reads only the override Compose selects', async () => {
    await write('compose.yaml', SAFE_COMPOSE);
    await write('compose.override.yml', SAFE_COMPOSE);
    await write('compose.override.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .resolves.toBeUndefined();
  });

  it('skips a file that does not exist and lets Compose report it', async () => {
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', '-f', 'missing.yaml', 'config'],
    })).resolves.toBeUndefined();
  });

  it('refuses a source larger than the read cap', async () => {
    await write('compose.yaml', `# ${'x'.repeat(MAX_COMPOSE_INPUT_BYTES)}\n`);
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toThrow(/larger than 16 MiB/);
  });
});

describe('assertComposeInputsWithinExpansionLimits - COMPOSE_FILE selection', () => {
  it('refuses a bomb selected by the process environment', async () => {
    await write('selected.yaml', nestedAliasBomb(12));
    await write('compose.yaml', SAFE_COMPOSE);
    process.env.COMPOSE_FILE = 'selected.yaml';
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('refuses a bomb selected by the project .env', async () => {
    await write('selected.yaml', nestedAliasBomb(12));
    await write('compose.yaml', SAFE_COMPOSE);
    await write('.env', 'COMPOSE_FILE=selected.yaml\n');
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('refuses a bomb selected by an explicit --env-file', async () => {
    await write('selected.yaml', nestedAliasBomb(12));
    await write('compose.yaml', SAFE_COMPOSE);
    await write('vars.env', 'COMPOSE_FILE=selected.yaml\n');
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', '--env-file', 'vars.env', 'config'],
    })).rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('reads an --env-file= value', async () => {
    await write('selected.yaml', nestedAliasBomb(12));
    await write('compose.yaml', SAFE_COMPOSE);
    await write('vars.env', 'COMPOSE_FILE=selected.yaml\n');
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', '--env-file=vars.env', 'config'],
    })).rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('lets a later --env-file win over an earlier one', async () => {
    await write('safe.yaml', SAFE_COMPOSE);
    await write('selected.yaml', nestedAliasBomb(12));
    await write('one.env', 'COMPOSE_FILE=safe.yaml\n');
    await write('two.env', 'COMPOSE_FILE=selected.yaml\n');
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', '--env-file', 'one.env', '--env-file', 'two.env', 'config'],
    })).rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('reads a --project-directory= value', async () => {
    await write('selected.yaml', nestedAliasBomb(12));
    await write('project/.env', 'COMPOSE_FILE=selected.yaml\n');
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', '--project-directory=project', 'config'],
    })).rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('refuses a bomb selected by COMPOSE_ENV_FILES', async () => {
    await write('selected.yaml', nestedAliasBomb(12));
    await write('compose.yaml', SAFE_COMPOSE);
    await write('vars.env', 'COMPOSE_FILE=selected.yaml\n');
    process.env.COMPOSE_ENV_FILES = 'vars.env';
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('measures every file of a multi-file selection, with a custom separator', async () => {
    await write('a.yaml', SAFE_COMPOSE);
    await write('b.yaml', nestedAliasBomb(12));
    await write('.env', 'COMPOSE_FILE=a.yaml;b.yaml\nCOMPOSE_PATH_SEPARATOR=;\n');
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('lets an explicit -f list replace COMPOSE_FILE', async () => {
    await write('safe.yaml', SAFE_COMPOSE);
    await write('selected.yaml', nestedAliasBomb(12));
    await write('.env', 'COMPOSE_FILE=selected.yaml\n');
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', '-f', 'safe.yaml', 'config'],
    })).resolves.toBeUndefined();
  });

  it('reads a safe selection and ignores a bomb in the default file Compose never loads', async () => {
    await write('selected.yaml', SAFE_COMPOSE);
    await write('compose.yaml', nestedAliasBomb(12));
    await write('.env', 'COMPOSE_FILE=selected.yaml\n');
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .resolves.toBeUndefined();
  });

  it('lets the process environment win over the project .env', async () => {
    await write('safe.yaml', SAFE_COMPOSE);
    await write('selected.yaml', nestedAliasBomb(12));
    await write('.env', 'COMPOSE_FILE=safe.yaml\n');
    process.env.COMPOSE_FILE = 'selected.yaml';
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('lets an explicit --env-file win over the project .env', async () => {
    await write('safe.yaml', SAFE_COMPOSE);
    await write('selected.yaml', nestedAliasBomb(12));
    await write('.env', 'COMPOSE_FILE=safe.yaml\n');
    await write('vars.env', 'COMPOSE_FILE=selected.yaml\n');
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', '--env-file', 'vars.env', 'config'],
    })).rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('reads the selection from --project-directory, resolving entries against the working directory', async () => {
    await write('project/selected.yaml', nestedAliasBomb(12));
    await write('project/.env', 'COMPOSE_FILE=project/selected.yaml\n');
    await write('compose.yaml', SAFE_COMPOSE);
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', '--project-directory', 'project', 'config'],
    })).rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('resolves COMPOSE_FILE entries against the working directory', async () => {
    await write('bomb.yaml', nestedAliasBomb(12));
    await write('sub/.env', 'COMPOSE_FILE=../bomb.yaml\n');
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: path.join(dir, 'sub'),
      invocation: ['compose', 'config'],
    })).rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('does not fall back to discovery for an empty COMPOSE_FILE, which Compose refuses', async () => {
    await write('compose.yaml', nestedAliasBomb(12));
    await write('.env', 'COMPOSE_FILE=\n');
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .resolves.toBeUndefined();
  });

  it('honours a process COMPOSE_DISABLE_ENV_FILE, so the file cannot select a bomb', async () => {
    await write('selected.yaml', nestedAliasBomb(12));
    await write('compose.yaml', SAFE_COMPOSE);
    await write('.env', 'COMPOSE_FILE=selected.yaml\n');
    process.env.COMPOSE_DISABLE_ENV_FILE = 'true';
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .resolves.toBeUndefined();
  });

  it('still measures a discovered input when the process disables the env file', async () => {
    await write('compose.yaml', nestedAliasBomb(12));
    process.env.COMPOSE_DISABLE_ENV_FILE = 'true';
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('still measures a process COMPOSE_FILE selection when the process disables the env file', async () => {
    await write('selected.yaml', nestedAliasBomb(12));
    await write('compose.yaml', SAFE_COMPOSE);
    process.env.COMPOSE_DISABLE_ENV_FILE = 'true';
    process.env.COMPOSE_FILE = 'selected.yaml';
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('still loads an included project env file when the process disables the env file', async () => {
    process.env.COMPOSE_DISABLE_ENV_FILE = 'true';
    await write('compose.yaml', 'include:\n  - app/main.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await write('app/main.yaml', 'include:\n  - ${DIR}/bomb.yaml\nservices:\n  inner:\n    image: nginx:alpine\n');
    await write('app/.env', 'DIR=deep\n');
    await write('app/deep/bomb.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('still measures a COMPOSE_FILE selected by a project .env that disables itself', async () => {
    await write('.env', 'COMPOSE_DISABLE_ENV_FILE=true\nCOMPOSE_FILE=selected.yaml\n');
    await write('selected.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('drops a self-disabling .env from dependency interpolation, as Compose does', async () => {
    await write('.env', 'COMPOSE_DISABLE_ENV_FILE=true\nCOMPOSE_FILE=selected.yaml\nDIR=shared\n');
    await write('selected.yaml', 'include:\n  - ${DIR}/bomb.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await write('shared/bomb.yaml', nestedAliasBomb(12));
    // Compose ignores DIR from a file that disabled itself, resolves the
    // include to /bomb.yaml, and fails on the missing file instead of loading
    // the bomb. The guard measures the same path.
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .resolves.toBeUndefined();
  });

  it('keeps an explicit env file in interpolation when it sets COMPOSE_DISABLE_ENV_FILE', async () => {
    await write('vars.env', 'COMPOSE_DISABLE_ENV_FILE=true\nDIR=shared\n');
    await write('compose.yaml', 'include:\n  - ${DIR}/bomb.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await write('shared/bomb.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', '--env-file', 'vars.env', 'config'],
    })).rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('leaves an invalid COMPOSE_DISABLE_ENV_FILE to Compose, which stops before reading a compose file', async () => {
    await write('.env', 'COMPOSE_DISABLE_ENV_FILE=maybe\nCOMPOSE_FILE=selected.yaml\n');
    await write('selected.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .resolves.toBeUndefined();
  });

  it('refuses when an env file cannot be read the way Compose reads it', async () => {
    await write('.env', 'COMPOSE_FILE=${1BAD}\n');
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toThrow(/env file/);
  });

  it('leaves a missing explicit env file to Compose, which fails before reading a compose file', async () => {
    await write('compose.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', '--env-file', 'missing.env', 'config'],
    })).resolves.toBeUndefined();
  });

  it('reads the project .env from the first -f file directory', async () => {
    await write('sub/compose.yaml', 'include:\n  - ${DIR}/bomb.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await write('sub/.env', 'DIR=deep\n');
    await write('sub/deep/bomb.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', '-f', 'sub/compose.yaml', 'config'],
    })).rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('adds the selected project .env when COMPOSE_FILE points into a subdirectory', async () => {
    await write('.env', 'COMPOSE_FILE=sub/selected.yaml\n');
    await write('sub/.env', 'DIR=deep\n');
    await write('sub/selected.yaml', 'include:\n  - ${DIR}/bomb.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await write('sub/deep/bomb.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('reads a COMPOSE_FILE value supplied by the child environment', async () => {
    await write('selected.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', 'config'],
      env: (name) => (name === 'COMPOSE_FILE' ? 'selected.yaml' : undefined),
    })).rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('layers a child environment override above the process environment', async () => {
    await write('selected.yaml', nestedAliasBomb(12));
    await write('compose.yaml', SAFE_COMPOSE);
    process.env.COMPOSE_FILE = 'selected.yaml';
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', 'config'],
      env: (name) => (name === 'SOMETHING_ELSE' ? 'x' : undefined),
    })).rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('lets a child environment override win over the process environment', async () => {
    await write('safe.yaml', SAFE_COMPOSE);
    await write('selected.yaml', nestedAliasBomb(12));
    process.env.COMPOSE_FILE = 'safe.yaml';
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', 'config'],
      env: (name) => (name === 'COMPOSE_FILE' ? 'selected.yaml' : undefined),
    })).rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });
});

describe('assertComposeInputsWithinExpansionLimits - include and extends dependencies', () => {
  it('refuses a bomb in a string include', async () => {
    await write('compose.yaml', 'include:\n  - bomb.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await write('bomb.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('refuses a bomb in a long-form include path list', async () => {
    await write('compose.yaml', [
      'include:',
      '  - path:',
      '      - safe.yaml',
      '      - bomb.yaml',
      'services:',
      '  web:',
      '    image: nginx:alpine',
    ].join('\n'));
    await write('safe.yaml', SAFE_COMPOSE);
    await write('bomb.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('follows a nested include relative to the included project directory', async () => {
    await write('compose.yaml', 'include:\n  - app/base.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await write('app/base.yaml', 'include:\n  - deep/bomb.yaml\nservices:\n  inner:\n    image: nginx:alpine\n');
    await write('app/deep/bomb.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('refuses a bomb named by extends.file', async () => {
    await write('compose.yaml', [
      'services:',
      '  web:',
      '    extends:',
      '      file: sub/base.yaml',
      '      service: base',
    ].join('\n'));
    await write('sub/base.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('follows an extends chain relative to each declaring file', async () => {
    await write('compose.yaml', [
      'services:',
      '  web:',
      '    extends:',
      '      file: sub/a.yaml',
      '      service: base',
    ].join('\n'));
    await write('sub/a.yaml', [
      'services:',
      '  base:',
      '    extends:',
      '      file: b.yaml',
      '      service: deeper',
    ].join('\n'));
    await write('sub/b.yaml', 'services:\n  deeper: *missing\n');
    // The unresolved alias makes Compose fail before it expands anything, so
    // the guard leaves it alone; this proves the chain was followed without
    // treating the file as a bomb.
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .resolves.toBeUndefined();
    await write('sub/b.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('interpolates an include path from the project .env', async () => {
    await write('.env', 'COMMON_DIR=shared\n');
    await write('compose.yaml', 'include:\n  - ${COMMON_DIR}/bomb.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await write('shared/bomb.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('uses an include project_directory to resolve nested declarations', async () => {
    await write('compose.yaml', [
      'include:',
      '  - path: app/main.yaml',
      '    project_directory: project',
      'services:',
      '  web:',
      '    image: nginx:alpine',
    ].join('\n'));
    await write('app/main.yaml', 'include:\n  - bomb.yaml\nservices:\n  inner:\n    image: nginx:alpine\n');
    await write('project/bomb.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('interpolates an include project_directory from the project .env', async () => {
    await write('.env', 'PROJDIR=project\n');
    await write('compose.yaml', [
      'include:',
      '  - path: app/main.yaml',
      '    project_directory: ${PROJDIR}',
      'services:',
      '  web:',
      '    image: nginx:alpine',
    ].join('\n'));
    await write('app/main.yaml', 'include:\n  - bomb.yaml\nservices:\n  inner:\n    image: nginx:alpine\n');
    await write('project/bomb.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('interpolates an include env_file path from the project .env', async () => {
    await write('.env', 'ENVDIR=app\n');
    await write('compose.yaml', [
      'include:',
      '  - path: app/main.yaml',
      '    env_file: ${ENVDIR}/vars.env',
      'services:',
      '  web:',
      '    image: nginx:alpine',
    ].join('\n'));
    await write('app/main.yaml', 'include:\n  - ${DIR}/bomb.yaml\nservices:\n  inner:\n    image: nginx:alpine\n');
    await write('app/vars.env', 'DIR=deep\n');
    await write('app/deep/bomb.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('interpolates an extends file path from the project .env', async () => {
    await write('.env', 'BASEDIR=sub\n');
    await write('compose.yaml', [
      'services:',
      '  web:',
      '    extends:',
      '      file: ${BASEDIR}/base.yaml',
      '      service: base',
    ].join('\n'));
    await write('sub/base.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('uses an include env_file for interpolation inside the included project', async () => {
    await write('compose.yaml', [
      'include:',
      '  - path: app/main.yaml',
      '    env_file: app/vars.env',
      'services:',
      '  web:',
      '    image: nginx:alpine',
    ].join('\n'));
    await write('app/main.yaml', 'include:\n  - ${DIR}/bomb.yaml\nservices:\n  inner:\n    image: nginx:alpine\n');
    await write('app/vars.env', 'DIR=deep\n');
    await write('app/deep/bomb.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('loads an included project env file even when the include disables interpolation', async () => {
    await write('compose.yaml', [
      'include:',
      '  - path: app/main.yaml',
      '    interpolation: false',
      'services:',
      '  web:',
      '    image: nginx:alpine',
    ].join('\n'));
    await write('app/main.yaml', 'include:\n  - ${DIR}/bomb.yaml\nservices:\n  inner:\n    image: nginx:alpine\n');
    await write('app/.env', 'DIR=deep\n');
    await write('app/deep/bomb.yaml', nestedAliasBomb(12));
    // Compose still reads the included project's .env for an entry with
    // interpolation: false, so a path it resolves must still be measured.
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('accepts an include that disables interpolation with a safe dependency', async () => {
    await write('compose.yaml', [
      'include:',
      '  - path: app/main.yaml',
      '    interpolation: false',
      'services:',
      '  web:',
      '    image: nginx:alpine',
    ].join('\n'));
    await write('app/main.yaml', 'include:\n  - ${DIR}/dep.yaml\nservices:\n  inner:\n    image: nginx:alpine\n');
    await write('app/.env', 'DIR=deep\n');
    await write('app/deep/dep.yaml', SAFE_COMPOSE);
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .resolves.toBeUndefined();
  });

  it('accepts include and extends cycles without spinning', async () => {
    await write('compose.yaml', 'include:\n  - a.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await write('a.yaml', 'include:\n  - compose.yaml\nservices:\n  inner:\n    image: nginx:alpine\n');
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .resolves.toBeUndefined();
  });

  it('traverses the same file again when a second include gives it a different env', async () => {
    await write('compose.yaml', [
      'include:',
      '  - path: app/main.yaml',
      '    env_file: app/safe.env',
      '  - path: app/main.yaml',
      '    env_file: app/deep.env',
      'services:',
      '  web:',
      '    image: nginx:alpine',
    ].join('\n'));
    await write('app/main.yaml', 'include:\n  - ${DIR}/dep.yaml\nservices:\n  inner:\n    image: nginx:alpine\n');
    await write('app/safe.env', 'DIR=safe\n');
    await write('app/deep.env', 'DIR=deep\n');
    await write('app/safe/dep.yaml', SAFE_COMPOSE);
    await write('app/deep/dep.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('applies one aggregate budget across a multi-file project', async () => {
    const includes = Array.from({ length: 16 }, (_, i) => `  - dep${i}.yaml`).join('\n');
    await write('compose.yaml', `include:\n${includes}\nservices:\n  web:\n    image: nginx:alpine\n`);
    for (let i = 0; i < 16; i += 1) {
      // Each file is under the per-file budget; together they are not.
      await write(`dep${i}.yaml`, nestedAliasBomb(4));
    }
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toThrow(/expand to more than 1,000,000 nodes in total/);
  });

  it('accepts an ordinary shared dependency reached twice', async () => {
    await write('compose.yaml', [
      'include:',
      '  - a.yaml',
      '  - b.yaml',
      'services:',
      '  web:',
      '    image: nginx:alpine',
    ].join('\n'));
    await write('a.yaml', 'include:\n  - shared.yaml\nservices:\n  a:\n    image: nginx:alpine\n');
    await write('b.yaml', 'include:\n  - shared.yaml\nservices:\n  b:\n    image: nginx:alpine\n');
    await write('shared.yaml', SAFE_COMPOSE);
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .resolves.toBeUndefined();
  });

  it('refuses an oversized dependency', async () => {
    await write('compose.yaml', 'include:\n  - huge.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await write('huge.yaml', `# ${'x'.repeat(MAX_COMPOSE_INPUT_BYTES)}\n`);
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toThrow(/larger than 16 MiB/);
  });

  it('refuses a remote include it cannot inspect, without echoing the URL', async () => {
    await write('compose.yaml', [
      'include:',
      '  - https://user:secret@example.com/base.yaml',
      'services:',
      '  web:',
      '    image: nginx:alpine',
    ].join('\n'));
    let message = '';
    try {
      await assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('remote include');
    expect(message).not.toContain('secret');
  });

  it('refuses a bomb in an absolute include path', async () => {
    const bomb = await write('bomb.yaml', nestedAliasBomb(12));
    await write('compose.yaml', `include:\n  - ${bomb}\nservices:\n  web:\n    image: nginx:alpine\n`);
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('treats a `~` dependency prefix as a literal directory, as Compose does', async () => {
    await write('compose.yaml', 'include:\n  - ~/bomb.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await write('~/bomb.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('refuses a bomb in a parent-relative include path', async () => {
    await write('bomb.yaml', nestedAliasBomb(12));
    await write('stack/compose.yaml', 'include:\n  - ../bomb.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: path.join(dir, 'stack'),
      invocation: ['compose', 'config'],
    })).rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('refuses an include chain deeper than the traversal bound', async () => {
    const depth = 34;
    await write('compose.yaml', 'include:\n  - dep0.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    for (let i = 0; i < depth; i += 1) {
      const next = i + 1 < depth ? `include:\n  - dep${i + 1}.yaml\n` : '';
      await write(`dep${i}.yaml`, `${next}services:\n  svc${i}:\n    image: nginx:alpine\n`);
    }
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toThrow(/deeper than 32/);
  });

  it('refuses a dependency graph with more files than the traversal bound', async () => {
    const count = 513;
    const includes = Array.from({ length: count }, (_, i) => `  - dep${i}.yaml`).join('\n');
    await write('compose.yaml', `include:\n${includes}\nservices:\n  web:\n    image: nginx:alpine\n`);
    for (let i = 0; i < count; i += 1) {
      await write(`dep${i}.yaml`, SAFE_COMPOSE);
    }
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toThrow(/more than 512 resolved compose inputs/);
  });

  it('follows an include declared in a later document of a stream', async () => {
    await write('compose.yaml', `${SAFE_COMPOSE}---\ninclude:\n  - bomb.yaml\nservices:\n  second:\n    image: nginx:alpine\n`);
    await write('bomb.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('follows an extends declared in an included project', async () => {
    await write('compose.yaml', 'include:\n  - app/main.yaml\nservices:\n  main:\n    image: nginx:alpine\n');
    await write('app/main.yaml', 'services:\n  inner:\n    extends:\n      file: base.yaml\n      service: base\n');
    await write('app/base.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('resolves an extends file in a merged -f file against the project directory', async () => {
    await write('main/compose.yaml', SAFE_COMPOSE);
    await write('main/base.yaml', nestedAliasBomb(12));
    await write('over/override.yaml', 'services:\n  web:\n    extends:\n      file: base.yaml\n      service: base\n');
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', '-f', 'main/compose.yaml', '-f', 'over/override.yaml', 'config'],
    })).rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('resolves an extends file against an include project_directory', async () => {
    await write('compose.yaml', [
      'include:',
      '  - path: app/main.yaml',
      '    project_directory: project',
      'services:',
      '  main:',
      '    image: nginx:alpine',
    ].join('\n'));
    await write('app/main.yaml', 'services:\n  inner:\n    extends:\n      file: base.yaml\n      service: base\n');
    await write('project/base.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('reads every include env_file in order', async () => {
    await write('compose.yaml', [
      'include:',
      '  - path: app/main.yaml',
      '    env_file:',
      '      - app/safe.env',
      '      - app/deep.env',
      'services:',
      '  web:',
      '    image: nginx:alpine',
    ].join('\n'));
    await write('app/main.yaml', 'include:\n  - ${DIR}/bomb.yaml\nservices:\n  inner:\n    image: nginx:alpine\n');
    await write('app/safe.env', 'DIR=safe\n');
    await write('app/deep.env', 'DIR=deep\n');
    await write('app/deep/bomb.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('refuses a remote extends dependency it cannot inspect, without echoing the URL', async () => {
    await write('compose.yaml', [
      'services:',
      '  web:',
      '    extends:',
      '      file: https://user:secret@example.com/base.yaml',
      '      service: base',
    ].join('\n'));
    let message = '';
    try {
      await assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('remote extends');
    expect(message).not.toContain('secret');
  });

  it('leaves a missing include for Compose to report', async () => {
    await write('compose.yaml', 'include:\n  - missing.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .resolves.toBeUndefined();
  });

  it('leaves an unparseable dependency for Compose to report', async () => {
    await write('compose.yaml', 'include:\n  - broken.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await write('broken.yaml', 'services: [\n');
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .resolves.toBeUndefined();
  });
});

describe('assertComposeInputsWithinExpansionLimits - encodings', () => {
  it('refuses a BOM-marked UTF-16LE alias bomb', async () => {
    await write('compose.yaml', encodeUtf16(nestedAliasBomb(12), 'le'));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('refuses a BOM-marked UTF-16BE alias bomb', async () => {
    await write('compose.yaml', encodeUtf16(nestedAliasBomb(12), 'be'));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('accepts a UTF-16LE and a UTF-16BE compose file within the budget', async () => {
    await write('compose.yaml', encodeUtf16(SAFE_COMPOSE, 'le'));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .resolves.toBeUndefined();
    await write('compose.yaml', encodeUtf16(SAFE_COMPOSE, 'be'));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .resolves.toBeUndefined();
  });

  it('refuses a UTF-16 dependency bomb', async () => {
    await write('compose.yaml', 'include:\n  - bomb.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await write('bomb.yaml', encodeUtf16(nestedAliasBomb(12), 'le'));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('keeps the byte cap for a UTF-16 file', async () => {
    await write('compose.yaml', encodeUtf16(`# ${'x'.repeat(MAX_COMPOSE_INPUT_BYTES)}`, 'le'));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
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
