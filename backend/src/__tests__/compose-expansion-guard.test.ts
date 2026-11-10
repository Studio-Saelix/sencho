/**
 * Unit tests for the compose alias-expansion guard. These run against the real
 * filesystem because the guard's contract is what it reads, not how a caller
 * mocks it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'child_process';
import { existsSync, promises as fsPromises } from 'fs';
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

  it('refuses a document the parser rejects when it also holds aliases Compose might still expand', () => {
    const source = `${nestedAliasBomb(12)}  broken: [\n`;
    expect(() => assertComposeSourceWithinExpansionLimits(source, 'compose.yaml'))
      .toThrow(/YAML that Sencho's parser rejects/);
  });

  it('refuses the over-budget chain beside YAML Compose accepts but the parser rejects', () => {
    // Compose's parser takes each of these; the `yaml` package reports an error.
    for (const accepted of ['x-q: "v"#c\n', `x-${'k'.repeat(1100)}: 1\n`, 'x-tf: [\n\ta]\n']) {
      expect(() => assertComposeSourceWithinExpansionLimits(`${nestedAliasBomb(5)}${accepted}`, 'compose.yaml'))
        .toThrow(ComposeExpansionRefusal);
    }
  });

  it('refuses a rejected document that declares an include', () => {
    expect(() => assertComposeSourceWithinExpansionLimits('include:\n  - big.yaml\nx-q: "v"#c\n', 'compose.yaml'))
      .toThrow(ComposeExpansionRefusal);
  });

  it('still measures a document whose only error is an unresolved alias, or that repeats a key', () => {
    expect(() => assertComposeSourceWithinExpansionLimits(`${nestedAliasBomb(12)}  web: *missing\n`, 'compose.yaml'))
      .toThrow(/nested YAML aliases/);
    expect(() => assertComposeSourceWithinExpansionLimits(`${nestedAliasBomb(12)}services:\n  web: {}\n`, 'compose.yaml'))
      .toThrow(/nested YAML aliases/);
  });

  it('leaves a syntax error with no aliases or includes for Compose to report', () => {
    expect(() => assertComposeSourceWithinExpansionLimits('services:\n  web:\n    image: nginx\n  bad: [\n', 'compose.yaml'))
      .not.toThrow();
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

  it('refuses a bomb after an earlier syntax error, since Compose may accept the earlier document', () => {
    // Compose's parser accepts some documents this one rejects, and would go on
    // to expand the later one, so the guard does not assume the stream stops.
    const source = `services: [\n---\n${nestedAliasBomb(12)}`;
    expect(() => assertComposeSourceWithinExpansionLimits(source, 'stream.yaml'))
      .toThrow(ComposeExpansionRefusal);
  });

  it('leaves a syntax error followed only by plain documents to Compose', () => {
    const source = 'services: [\n---\nservices:\n  web:\n    image: nginx\n';
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
      .rejects.toThrow(/larger than 1 MiB/);
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

  it('lets an explicit --env-file win over COMPOSE_ENV_FILES', async () => {
    await write('safe.yaml', SAFE_COMPOSE);
    await write('selected.yaml', nestedAliasBomb(12));
    await write('explicit.env', 'COMPOSE_FILE=safe.yaml\n');
    await write('listed.env', 'COMPOSE_FILE=selected.yaml\n');
    process.env.COMPOSE_ENV_FILES = 'listed.env';
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', '--env-file', 'explicit.env', 'config'],
    })).resolves.toBeUndefined();
  });

  it('lets COMPOSE_ENV_FILES win over the project .env', async () => {
    await write('safe.yaml', SAFE_COMPOSE);
    await write('selected.yaml', nestedAliasBomb(12));
    await write('.env', 'COMPOSE_FILE=safe.yaml\n');
    await write('listed.env', 'COMPOSE_FILE=selected.yaml\n');
    process.env.COMPOSE_ENV_FILES = 'listed.env';
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('reads the project .env, not the -f file directory .env, when --project-directory is set', async () => {
    await write('project/.env', 'DIR=deep\n');
    await write('sub/.env', 'DIR=safe\n');
    await write('sub/compose.yaml', 'include:\n  - ${DIR}/bomb.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await write('project/deep/bomb.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', '--project-directory', 'project', '-f', 'sub/compose.yaml', 'config'],
    })).rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('lets a process COMPOSE_DISABLE_ENV_FILE=false keep the project .env values', async () => {
    process.env.COMPOSE_DISABLE_ENV_FILE = 'false';
    await write('.env', 'COMPOSE_DISABLE_ENV_FILE=true\nDIR=deep\n');
    await write('compose.yaml', 'include:\n  - ${DIR}/bomb.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await write('deep/bomb.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
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

  it('takes the child environment as the whole environment, so a name it lacks is unset', async () => {
    await write('selected.yaml', nestedAliasBomb(12));
    await write('compose.yaml', SAFE_COMPOSE);
    process.env.COMPOSE_FILE = 'selected.yaml';
    // The child has no COMPOSE_FILE, so Compose loads the safe discovered file.
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', 'config'],
      env: (name) => (name === 'SOMETHING_ELSE' ? 'x' : undefined),
    })).resolves.toBeUndefined();
  });

  it('lets the child environment win over a different process environment', async () => {
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
      .rejects.toThrow(/larger than 1 MiB/);
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
    await write('compose.yaml', encodeUtf16(`# ${'x'.repeat(MAX_COMPOSE_INPUT_BYTES / 2 + 100)}`, 'le'));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toThrow(/larger than 1 MiB/);
  });
});

describe('composeFileArgsFromInvocation', () => {
  it('reads -f, --file and --file= forms in order', () => {
    expect(composeFileArgsFromInvocation([
      'compose', '-f', 'a.yaml', '--file', 'b.yaml', '--file=c.yaml', 'config', '--format', 'json',
    ])).toEqual(['a.yaml', 'b.yaml', 'c.yaml']);
  });

  it('reads -f= and -fvalue forms', () => {
    expect(composeFileArgsFromInvocation([
      'compose', '-f=a.yaml', '-fb.yaml', 'config',
    ])).toEqual(['a.yaml', 'b.yaml']);
  });

  it('skips another global flag value before -f', () => {
    expect(composeFileArgsFromInvocation([
      'compose', '--project-name', 'demo', '-f', 'a.yaml', 'config',
    ])).toEqual(['a.yaml']);
  });

  it('does not read a command flag after the subcommand', () => {
    expect(composeFileArgsFromInvocation(['compose', 'logs', '-f', 'web'])).toEqual([]);
  });

  it('returns nothing when the invocation lets Compose discover its files', () => {
    expect(composeFileArgsFromInvocation(['compose', 'config', '--format', 'json'])).toEqual([]);
  });
});

describe('assertComposeInputsWithinExpansionLimits - selection, dependency, and stream edge cases', () => {
  it('still measures the selected files when an explicit env file is /dev/null', async () => {
    await write('compose.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', '--env-file', os.devNull, '-f', 'compose.yaml', 'config'],
    })).rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('keeps every COMPOSE_* value from a self-disabling .env for dependency paths', async () => {
    await write('.env', 'COMPOSE_DISABLE_ENV_FILE=true\nCOMPOSE_DIR=sub\n');
    await write('compose.yaml', 'include:\n  - ${COMPOSE_DIR}/bomb.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await write('sub/bomb.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('refuses a bomb named by a job extends.file', async () => {
    await write('compose.yaml', [
      'jobs:',
      '  task:',
      '    extends:',
      '      file: base.yaml',
      '      service: base',
      '    triggers:',
      '      manual: true',
      'services:',
      '  web:',
      '    image: nginx:alpine',
    ].join('\n'));
    await write('base.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('treats an empty include project_directory as absent', async () => {
    await write('compose.yaml', [
      'include:',
      '  - path: app/main.yaml',
      '    project_directory: ""',
      'services:',
      '  web:',
      '    image: nginx:alpine',
    ].join('\n'));
    await write('app/main.yaml', 'services:\n  inner:\n    extends:\n      file: base.yaml\n      service: base\n');
    await write('app/base.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('treats an interpolated empty include project_directory as absent', async () => {
    await write('.env', 'PROJDIR=\n');
    await write('compose.yaml', [
      'include:',
      '  - path: app/main.yaml',
      '    project_directory: ${PROJDIR}',
      'services:',
      '  web:',
      '    image: nginx:alpine',
    ].join('\n'));
    await write('app/main.yaml', 'services:\n  inner:\n    extends:\n      file: base.yaml\n      service: base\n');
    await write('app/base.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('counts every occurrence of a repeated dependency toward the total budget', async () => {
    const includes = Array.from({ length: 16 }, () => '  - shared.yaml').join('\n');
    await write('compose.yaml', `include:\n${includes}\nservices:\n  web:\n    image: nginx:alpine\n`);
    // Each occurrence is under the per-file budget; sixteen are not under the
    // per-invocation budget.
    await write('shared.yaml', nestedAliasBomb(4));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toThrow(/expand to more than 1,000,000 nodes in total/);
  });

  it('discovers a compose file in a parent directory', async () => {
    await write('compose.yaml', nestedAliasBomb(12));
    await write('stack/.keep', '');
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: path.join(dir, 'stack'),
      invocation: ['compose', 'config'],
    })).rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('discovers an override beside a parent compose file', async () => {
    await write('compose.yaml', SAFE_COMPOSE);
    await write('compose.override.yml', nestedAliasBomb(12));
    await write('stack/.keep', '');
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: path.join(dir, 'stack'),
      invocation: ['compose', 'config'],
    })).rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('measures a local include path with a dotted directory name', async () => {
    await write('compose.yaml', 'include:\n  - apps.web/bomb.yaml\nservices:\n  web:\n    image: nginx:alpine\n');
    await write('apps.web/bomb.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toThrow(/nested YAML aliases/);
  });

  it('measures a local -f path with a dotted directory name', async () => {
    await write('apps.web/bomb.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', '-f', 'apps.web/bomb.yaml', 'config'],
    })).rejects.toThrow(/nested YAML aliases/);
  });

  it('refuses a relative project_directory inside an included project', async () => {
    await write('compose.yaml', 'include:\n  - path: sub/main.yaml\n    project_directory: deep\nservices:\n  web:\n    image: nginx:alpine\n');
    await write('sub/main.yaml', 'include:\n  - path: sub2/main2.yaml\n    project_directory: ../deep2\nservices:\n  level1:\n    image: nginx:alpine\n');
    await write('deep2/nested/dep.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toThrow(/relative project_directory inside an included or extended file/);
  });

  it('refuses a relative env_file inside an included project', async () => {
    await write('compose.yaml', 'include:\n  - path: sub/main.yaml\n    project_directory: deep\nservices:\n  web:\n    image: nginx:alpine\n');
    await write('sub/main.yaml', 'include:\n  - path: sub2/main2.yaml\n    env_file: vars.env\nservices:\n  level1:\n    image: nginx:alpine\n');
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toThrow(/relative env_file inside an included or extended file/);
  });

  it('accepts a first-level relative project_directory with a safe nested include', async () => {
    await write('compose.yaml', 'include:\n  - path: sub/main.yaml\n    project_directory: deep\nservices:\n  web:\n    image: nginx:alpine\n');
    await write('sub/main.yaml', 'include:\n  - sub2/main2.yaml\nservices:\n  level1:\n    image: nginx:alpine\n');
    await write('deep/sub2/main2.yaml', SAFE_COMPOSE);
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .resolves.toBeUndefined();
  });

  it('refuses a ~ env-file path it cannot resolve the way Compose does', async () => {
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', '--env-file', '~/vars.env', 'config'],
    })).rejects.toThrow(/cannot resolve the env file path/);
  });

  it('joins a ~someone extends path under the child HOME, as Compose does', async () => {
    const previousHome = process.env.HOME;
    process.env.HOME = path.join(dir, 'home');
    try {
      await write('compose.yaml', 'services:\n  web:\n    extends:\n      file: sub/a.yaml\n      service: base\n');
      await write('sub/a.yaml', 'services:\n  base:\n    extends:\n      file: ~someone/b.yaml\n      service: deeper\n');
      await write('home/someone/b.yaml', nestedAliasBomb(12));
      await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
        .rejects.toThrow(/nested YAML aliases/);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('refuses a ~ COMPOSE_ENV_FILES path it cannot resolve the way Compose does', async () => {
    process.env.COMPOSE_ENV_FILES = '~/vars.env';
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toThrow(/cannot resolve the env file path/);
  });

  it('refuses a bare-host git include reference', async () => {
    await write('compose.yaml', 'include:\n  - github.com/org/repo\nservices:\n  web:\n    image: nginx:alpine\n');
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toThrow(/remote include/);
  });

  it('refuses an SCP-like git extends reference', async () => {
    await write('compose.yaml', [
      'services:',
      '  web:',
      '    extends:',
      '      file: git@github.com:org/repo.git',
      '      service: base',
    ].join('\n'));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toThrow(/remote extends/);
  });

  it('refuses a remote top-level -f reference without echoing it', async () => {
    let message = '';
    try {
      await assertComposeInputsWithinExpansionLimits({
        cwd: dir,
        invocation: ['compose', '-f', 'https://user:secret@example.com/bomb.git', 'config'],
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('remote Git or OCI');
    expect(message).not.toContain('secret');
  });

  it('refuses a remote COMPOSE_FILE reference', async () => {
    process.env.COMPOSE_FILE = 'github.com/org/repo';
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toThrow(/remote Git or OCI/);
  });

  it('reads a bomb named by -f= and -fvalue forms', async () => {
    await write('compose.yaml', SAFE_COMPOSE);
    await write('selected.yaml', nestedAliasBomb(12));
    for (const form of ['-f=selected.yaml', '-fselected.yaml']) {
      await expect(assertComposeInputsWithinExpansionLimits({
        cwd: dir,
        invocation: ['compose', form, 'config'],
      })).rejects.toBeInstanceOf(ComposeExpansionRefusal);
    }
  });

  it('does not treat a command flag after the subcommand as a compose file', async () => {
    await write('compose.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({
      cwd: dir,
      invocation: ['compose', 'logs', '-f', 'web'],
    })).rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('expands ~ in a nested extends path from the child HOME', async () => {
    const previousHome = process.env.HOME;
    process.env.HOME = path.join(dir, 'home');
    try {
      await write('compose.yaml', 'services:\n  web:\n    extends:\n      file: sub/a.yaml\n      service: base\n');
      await write('sub/a.yaml', 'services:\n  base:\n    extends:\n      file: ~/b.yaml\n      service: deeper\n');
      await write('home/b.yaml', nestedAliasBomb(12));
      await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
        .rejects.toBeInstanceOf(ComposeExpansionRefusal);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('keeps a nested extends ~ path literal when HOME is unset', async () => {
    const previousHome = process.env.HOME;
    delete process.env.HOME;
    try {
      await write('compose.yaml', 'services:\n  web:\n    extends:\n      file: sub/a.yaml\n      service: base\n');
      await write('sub/a.yaml', 'services:\n  base:\n    extends:\n      file: ~/b.yaml\n      service: deeper\n');
      await write('sub/~/b.yaml', nestedAliasBomb(12));
      await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
        .rejects.toBeInstanceOf(ComposeExpansionRefusal);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('keeps a top-level extends ~ path literal', async () => {
    await write('compose.yaml', 'services:\n  web:\n    extends:\n      file: ~/b.yaml\n      service: deeper\n');
    await write('~/b.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });

  it('follows an include in a document with reset tags', async () => {
    await write('compose.yaml', 'include:\n  - bomb.yaml\nservices:\n  web:\n    ports: !reset []\n');
    await write('bomb.yaml', nestedAliasBomb(12));
    await expect(assertComposeInputsWithinExpansionLimits({ cwd: dir, invocation: ['compose', 'config'] }))
      .rejects.toBeInstanceOf(ComposeExpansionRefusal);
  });
});

describe('assertComposeInputsWithinExpansionLimits - parser gaps, devices, extends copies, and cost', () => {
  const run = (cwd = dir, invocation: string[] = ['compose', 'config'], env?: (name: string) => string | undefined) =>
    assertComposeInputsWithinExpansionLimits({ cwd, invocation, env });

  describe('YAML the parser rejects but Compose accepts', () => {
    it('refuses a bomb file with an unspaced comment after a quoted value', async () => {
      await write('compose.yaml', `${nestedAliasBomb(5)}x-q: "v"#c\n`);
      await expect(run()).rejects.toThrow(/YAML that Sencho's parser rejects/);
    });

    it('refuses the same file when it is only a dependency', async () => {
      await write('compose.yaml', 'include:\n  - dep.yaml\nservices:\n  web:\n    image: nginx\n');
      await write('dep.yaml', `${nestedAliasBomb(5)}x-tf: [\n\ta]\n`);
      await expect(run()).rejects.toBeInstanceOf(ComposeExpansionRefusal);
    });

    it('refuses an include that sits in a document the parser rejects', async () => {
      await write('compose.yaml', 'include:\n  - dep.yaml\nx-q: "v"#c\n');
      await write('dep.yaml', nestedAliasBomb(5));
      await expect(run()).rejects.toBeInstanceOf(ComposeExpansionRefusal);
    });

    it('leaves a broken file with no aliases or includes to Compose', async () => {
      await write('compose.yaml', 'services:\n  web: [1\n');
      await expect(run()).resolves.toBeUndefined();
    });

    it('refuses a bomb after an earlier unparsable document, since Compose may parse the first one', async () => {
      await write('compose.yaml', `services:\n  web: [1\n---\n${nestedAliasBomb(12)}`);
      await expect(run()).rejects.toThrow(/YAML that Sencho's parser rejects/);
    });

    it('refuses a rejected document that hides include behind a quoted escape', async () => {
      await write('compose.yaml', 'x-q: "v"#c\n"inc\\x6cude":\n  - dep.yaml\n');
      await write('dep.yaml', nestedAliasBomb(5));
      await expect(run()).rejects.toBeInstanceOf(ComposeExpansionRefusal);
    });

  });

  describe('inputs that are not regular files', () => {
    const makeFifo = async (name: string) => {
      const target = path.join(dir, name);
      await new Promise<void>((resolve, reject) => {
        execFile('mkfifo', [target], (err) => (err ? reject(err) : resolve()));
      });
      return target;
    };

    it('refuses an include of /dev/zero', async () => {
      await write('compose.yaml', 'include:\n  - /dev/zero\n');
      await expect(run()).rejects.toThrow(/not a regular file/);
    });

    it('refuses an extends of /dev/zero', async () => {
      await write('compose.yaml', 'services:\n  web:\n    extends:\n      file: /dev/zero\n      service: base\n');
      await expect(run()).rejects.toThrow(/not a regular file/);
    });

    it('refuses an include that is a FIFO', async () => {
      await makeFifo('pipe.yaml');
      await write('compose.yaml', 'include:\n  - pipe.yaml\n');
      await expect(run()).rejects.toThrow(/not a regular file/);
    });

    it('refuses a -f file that links to /dev/zero', async () => {
      await fsPromises.symlink('/dev/zero', path.join(dir, 'zero.yaml'));
      await expect(run(dir, ['compose', '-f', 'zero.yaml', 'config'])).rejects.toThrow(/not a regular file/);
    });

    it('refuses a discovered compose.yaml that links to /dev/zero beside a benign compose.yml', async () => {
      await fsPromises.symlink('/dev/zero', path.join(dir, 'compose.yaml'));
      await write('compose.yml', SAFE_COMPOSE);
      await expect(run()).rejects.toThrow(/not a regular file/);
    });

    it('refuses a discovered override that links to /dev/zero', async () => {
      await write('compose.yaml', SAFE_COMPOSE);
      await fsPromises.symlink('/dev/zero', path.join(dir, 'compose.override.yml'));
      await expect(run()).rejects.toThrow(/not a regular file/);
    });

    it('refuses an include env_file of /dev/zero', async () => {
      await write('compose.yaml', 'include:\n  - path: dep.yaml\n    env_file: /dev/zero\n');
      await write('dep.yaml', SAFE_COMPOSE);
      await expect(run()).rejects.toThrow(/not a regular file/);
    });

    it('refuses a project .env that links to /dev/zero', async () => {
      await write('compose.yaml', SAFE_COMPOSE);
      await fsPromises.symlink('/dev/zero', path.join(dir, '.env'));
      await expect(run()).rejects.toThrow(/not a regular file/);
    });

    it('still reads /dev/null as an empty env file and measures the compose file', async () => {
      await write('compose.yaml', nestedAliasBomb(12));
      await expect(run(dir, ['compose', '--env-file', '/dev/null', 'config'])).rejects.toThrow(/nested YAML aliases/);
    });

    it('treats a directory named like a compose file as the pick, as Compose does', async () => {
      await fsPromises.mkdir(path.join(dir, 'compose.yaml'));
      await write('compose.yml', nestedAliasBomb(12));
      await expect(run()).resolves.toBeUndefined();
    });
  });

  describe('extends copies and repeated dependencies', () => {
    it('refuses services that each extend one under-budget service of the same file', async () => {
      const chain = ['x0: &a0 [lol, lol, lol, lol, lol, lol, lol, lol, lol]'];
      for (let level = 1; level <= 4; level += 1) {
        chain.push(`x${level}: &a${level} [${Array.from({ length: 9 }, () => `*a${level - 1}`).join(', ')}]`);
      }
      const extenders = Array.from({ length: 30 }, (_, i) => `  s${i}:\n    extends: y`).join('\n');
      await write('compose.yaml', `${chain.join('\n')}\nservices:\n  y:\n    image: nginx\n    x-big: *a4\n${extenders}\n`);
      await expect(run()).rejects.toThrow(/in total/);
    });

    it('refuses the same fan-out through extends: { service: ... }', async () => {
      const chain = ['x0: &a0 [lol, lol, lol, lol, lol, lol, lol, lol, lol]'];
      for (let level = 1; level <= 4; level += 1) {
        chain.push(`x${level}: &a${level} [${Array.from({ length: 9 }, () => `*a${level - 1}`).join(', ')}]`);
      }
      const extenders = Array.from({ length: 30 }, (_, i) => `  s${i}:\n    extends:\n      service: y`).join('\n');
      await write('compose.yaml', `${chain.join('\n')}\nservices:\n  y:\n    image: nginx\n    x-big: *a4\n${extenders}\n`);
      await expect(run()).rejects.toThrow(/in total/);
    });

    it('refuses an extends carried in through a merge key', async () => {
      const chain = ['x0: &a0 [lol, lol, lol, lol, lol, lol, lol, lol, lol]'];
      for (let level = 1; level <= 4; level += 1) {
        chain.push(`x${level}: &a${level} [${Array.from({ length: 9 }, () => `*a${level - 1}`).join(', ')}]`);
      }
      const extenders = Array.from({ length: 30 }, (_, i) => `  s${i}:\n    <<: *ext`).join('\n');
      await write('compose.yaml', `${chain.join('\n')}\nx-ext: &ext\n  extends: y\nservices:\n  y:\n    image: nginx\n    x-big: *a4\n${extenders}\n`);
      await expect(run()).rejects.toThrow(/in total/);
    });

    it('refuses services that extend a chain through another file and charge its whole subtree', async () => {
      await write('big.yaml', `${nestedAliasBomb(4)}`);
      await write('mid.yaml', 'services:\n  m:\n    extends:\n      file: big.yaml\n      service: y\n');
      const extenders = Array.from({ length: 30 }, (_, i) => `  s${i}:\n    extends:\n      file: mid.yaml\n      service: m`).join('\n');
      await write('compose.yaml', `services:\n${extenders}\n`);
      await expect(run()).rejects.toThrow(/in total/);
    });

    it('charges the descendants of a file that one file includes many times', async () => {
      await write('big.yaml', nestedAliasBomb(4));
      await write('mid.yaml', 'include:\n  - big.yaml\n');
      await write('compose.yaml', `include:\n${Array.from({ length: 30 }, () => '  - mid.yaml').join('\n')}\n`);
      await expect(run()).rejects.toThrow(/in total/);
    });

    it('refuses a fan-out that doubles at every level of tiny files', async () => {
      for (let level = 0; level < 25; level += 1) {
        await write(`f${level}.yaml`, `include:\n  - f${level + 1}.yaml\n  - f${level + 1}.yaml\n`);
      }
      await write('f25.yaml', '');
      await write('compose.yaml', 'include:\n  - f0.yaml\n');
      await expect(run()).rejects.toThrow(/in total/);
    });

    it('refuses more include references than the bound', async () => {
      await write('leaf.yaml', SAFE_COMPOSE);
      await write('compose.yaml', `include:\n${Array.from({ length: 5000 }, () => '  - leaf.yaml').join('\n')}\n`);
      await expect(run()).rejects.toThrow(/include, extends, and env file references/);
    });

    it('refuses an extends chain deeper than the bound inside one file', async () => {
      const services = Array.from({ length: 40 }, (_, i) =>
        (i === 0 ? '  s0:\n    image: nginx' : `  s${i}:\n    extends: s${i - 1}`)).join('\n');
      await write('compose.yaml', `services:\n${services}\n`);
      await expect(run()).rejects.toThrow(/extends chain deeper/);
    });

    it('accepts an ordinary stack where a few services extend a shared base', async () => {
      const services = Array.from({ length: 12 }, (_, i) => `  s${i}:\n    extends: base\n    image: nginx`).join('\n');
      await write('compose.yaml', `services:\n  base:\n    image: alpine\n    environment:\n      A: b\n${services}\n`);
      await expect(run()).resolves.toBeUndefined();
    });

    it('accepts a same-file extends cycle or a missing parent, which Compose reports itself', async () => {
      await write('compose.yaml', 'services:\n  a:\n    extends: b\n  b:\n    extends: a\n  c:\n    extends: nope\n');
      await expect(run()).resolves.toBeUndefined();
    });

    it('accepts an include cycle, which Compose reports itself', async () => {
      await write('compose.yaml', 'include:\n  - a.yaml\n');
      await write('a.yaml', 'include:\n  - compose.yaml\n');
      await expect(run()).resolves.toBeUndefined();
    });

    it('accepts an extends cycle across files, which Compose reports itself', async () => {
      await write('compose.yaml', 'services:\n  web:\n    extends:\n      file: a.yaml\n      service: x\n');
      await write('a.yaml', 'services:\n  x:\n    extends:\n      file: compose.yaml\n      service: web\n');
      await expect(run()).resolves.toBeUndefined();
    });
  });

  describe('cost of the guard itself', () => {
    it('measures a file with tens of thousands of aliases in linear time', async () => {
      const aliases = Array.from({ length: 60_000 }, () => '  - *a').join('\n');
      await write('compose.yaml', `x-a: &a [1, 2]\nx-list:\n${aliases}\nservices:\n  web:\n    image: nginx\n`);
      const started = Date.now();
      await expect(run()).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    it('reads the project .env once for many includes', async () => {
      await write('leaf.yaml', SAFE_COMPOSE);
      await write('.env', `${Array.from({ length: 5_000 }, (_, i) => `K${i}=value${i}`).join('\n')}\n`);
      await write('compose.yaml', `include:\n${Array.from({ length: 1500 }, () => '  - leaf.yaml').join('\n')}\n`);
      const realOpen = fsPromises.open.bind(fsPromises);
      const opened: string[] = [];
      const spy = vi.spyOn(fsPromises, 'open').mockImplementation(((target: unknown, ...rest: unknown[]) => {
        opened.push(String(target));
        return (realOpen as (...a: unknown[]) => Promise<unknown>)(target, ...rest);
      }) as typeof fsPromises.open);
      try {
        await expect(run()).resolves.toBeUndefined();
      } finally {
        spy.mockRestore();
      }
      // One read for the selection and one for the included project's own
      // .env, however many includes name it.
      expect(opened.filter((target) => target.endsWith(`${path.sep}.env`)).length).toBeLessThanOrEqual(2);
    });
  });

  describe('a symlinked working directory', () => {
    it('resolves relative dependencies from the physical directory, as Compose does', async () => {
      await write('real/stack/compose.yaml', 'include:\n  - ../common.yaml\n');
      await write('real/common.yaml', nestedAliasBomb(12));
      await write('link-parent/common.yaml', SAFE_COMPOSE);
      await fsPromises.symlink(path.join(dir, 'real', 'stack'), path.join(dir, 'link-parent', 'stack'));
      await expect(run(path.join(dir, 'link-parent', 'stack'))).rejects.toThrow(/nested YAML aliases/);
    });

    it('does not refuse a benign stack because of a bomb beside the link', async () => {
      await write('real/stack/compose.yaml', 'include:\n  - ../common.yaml\n');
      await write('real/common.yaml', SAFE_COMPOSE);
      await write('link-parent/common.yaml', nestedAliasBomb(12));
      await fsPromises.symlink(path.join(dir, 'real', 'stack'), path.join(dir, 'link-parent', 'stack'));
      await expect(run(path.join(dir, 'link-parent', 'stack'))).resolves.toBeUndefined();
    });
  });

  describe('anchors and merge keys', () => {
    it('counts only the last definition of a reused anchor name before an alias', async () => {
      // The first &a is a bomb that the alias no longer names.
      const source = [
        'x0: &b0 [lol, lol, lol, lol, lol, lol, lol, lol, lol]',
        ...Array.from({ length: 12 }, (_, i) => `x${i + 1}: &b${i + 1} [${Array.from({ length: 9 }, () => `*b${i}`).join(', ')}]`),
      ];
      // Bomb defined under the name a, then redefined as a scalar before use.
      const bomb = source.join('\n').replace(/&b/g, '&a').replace(/\*b/g, '*a');
      await write('compose.yaml', `${bomb}\nx-small: &a small\nx-use: [*a, *a, *a]\nservices:\n  web:\n    image: nginx\n`);
      // x12 itself is still a bomb, so the file is refused; the redefinition does not hide it.
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
    });

    it('does not count an anchor name redefined before a reused alias against the earlier bomb', async () => {
      await write('compose.yaml', [
        'x-big: &a [lol, lol, lol, lol, lol, lol, lol, lol, lol]',
        'x-small: &a small',
        `x-use: [${Array.from({ length: 20 }, () => '*a').join(', ')}]`,
        'services:',
        '  web:',
        '    image: nginx',
      ].join('\n'));
      await expect(run()).resolves.toBeUndefined();
    });

    it('refuses a bomb built from merge keys', async () => {
      const lines = ['x0: &m0 {a: 1, b: 2, c: 3}'];
      for (let level = 1; level <= 6; level += 1) {
        const merged = Array.from({ length: 9 }, () => `*m${level - 1}`).join(', ');
        lines.push(`x${level}: &m${level} {<<: [${merged}], k${level}: 1}`);
      }
      await write('compose.yaml', `${lines.join('\n')}\nservices:\n  web:\n    image: nginx\n`);
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
    });

    it('refuses a bomb whose aliases are mapping keys', async () => {
      const lines = ['x0: &k0 [lol, lol, lol, lol, lol, lol, lol, lol, lol]'];
      for (let level = 1; level <= 6; level += 1) {
        lines.push(`x${level}: &k${level} {${Array.from({ length: 9 }, () => `*k${level - 1} : *k${level - 1}`).join(', ')}}`);
      }
      await write('compose.yaml', `${lines.join('\n')}\nservices:\n  web:\n    image: nginx\n`);
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
    });
  });

  describe('env files', () => {
    it('refuses an env file over the byte cap', async () => {
      await write('compose.yaml', SAFE_COMPOSE);
      await write('big.env', `K=${'x'.repeat(MAX_COMPOSE_INPUT_BYTES)}\n`);
      await expect(run(dir, ['compose', '--env-file', 'big.env', 'config'])).rejects.toThrow(/Env file "big.env" is larger than 1 MiB/);
    });

    it('refuses an included project .env over the byte cap', async () => {
      await write('compose.yaml', 'include:\n  - sub/dep.yaml\n');
      await write('sub/dep.yaml', SAFE_COMPOSE);
      await write('sub/.env', `K=${'x'.repeat(MAX_COMPOSE_INPUT_BYTES)}\n`);
      await expect(run()).rejects.toThrow(/Env file ".*\.env" is larger than 1 MiB/);
    });

    it('treats a COMPOSE_ENV_FILES entry that does not exist as a Compose failure', async () => {
      await write('compose.yaml', nestedAliasBomb(12));
      await expect(run(dir, ['compose', 'config'], (name) => (name === 'COMPOSE_ENV_FILES' ? 'missing.env' : undefined)))
        .resolves.toBeUndefined();
    });

    it('refuses a remote include project_directory', async () => {
      await write('compose.yaml', 'include:\n  - path: dep.yaml\n    project_directory: https://example.com/repo.git\n');
      await write('dep.yaml', SAFE_COMPOSE);
      await expect(run()).rejects.toThrow(/remote include reference/);
    });

    it('treats a COMPOSE_FILE of only separators as nothing to measure', async () => {
      await write('compose.yaml', nestedAliasBomb(12));
      await expect(run(dir, ['compose', 'config'], (name) => (name === 'COMPOSE_FILE' ? ':::' : undefined)))
        .resolves.toBeUndefined();
    });

    it('treats an include path that fails interpolation as unresolved', async () => {
      await write('compose.yaml', 'include:\n  - ${REQUIRED:?must be set}/dep.yaml\n');
      await expect(run()).resolves.toBeUndefined();
    });
  });

  describe('line breaks, key checks, and env-file budgets', () => {
    it('refuses a flow sequence that U+0085, U+2028, or U+2029 splits, as unmeasurable', async () => {
      for (const breakChar of ['\u0085', '\u2028', '\u2029']) {
        const lines = ['x-l0: &l0 [a, a, a, a, a, a, a, a, a]'];
        for (let level = 1; level <= 6; level += 1) {
          lines.push(`x-l${level}: &l${level} [${breakChar}${Array.from({ length: 9 }, () => `*l${level - 1}`).join(', ')}]`);
        }
        await write('compose.yaml', `${lines.join('\n')}\nservices:\n  web:\n    image: nginx\n`);
        // Compose accepts the break inside the flow sequence. Here it becomes a
        // newline the parser rejects, and the file is refused as unmeasurable.
        await expect(run()).rejects.toBeInstanceOf(ComposeExpansionRefusal);
      }
    });

    it('measures an alias bomb that follows U+0085, U+2028, or U+2029 in a comment', async () => {
      for (const breakChar of ['\u0085', '\u2028', '\u2029']) {
        await write('compose.yaml', `x-pad: 1 # note${breakChar}${nestedAliasBomb(12)}`);
        await expect(run()).rejects.toThrow(/nested YAML aliases/);
      }
    });

    it('follows an include that follows one of those line breaks', async () => {
      await write('compose.yaml', 'x-a: foo\u0085include:\u0085- dep.yaml\n');
      await write('dep.yaml', nestedAliasBomb(12));
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
    });

    it('parses a flow map with tens of thousands of keys in linear time', async () => {
      const keys = Array.from({ length: 40_000 }, (_, i) => `k${i}: 1`).join(', ');
      await write('compose.yaml', `x-big: {${keys}}\nservices:\n  web:\n    image: nginx\n`);
      const started = Date.now();
      await expect(run()).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(3_000);
    });

    it('refuses a Git source string over the byte cap', () => {
      const source = `# ${'x'.repeat(MAX_COMPOSE_INPUT_BYTES)}\n`;
      expect(() => assertComposeSourceWithinExpansionLimits(source, 'compose.yaml')).toThrow(/larger than 1 MiB/);
    });

    it('refuses an env_file list too long to read', async () => {
      await write('big.env', 'K=1\n');
      await write('leaf.yaml', SAFE_COMPOSE);
      const files = Array.from({ length: 5000 }, () => '      - big.env').join('\n');
      await write('compose.yaml', `include:\n  - path: leaf.yaml\n    env_file:\n${files}\n`);
      await expect(run()).rejects.toThrow(/env file references/);
    });

    it('reads an env file listed many times once', async () => {
      await write('big.env', `${Array.from({ length: 20_000 }, (_, i) => `K${i}=value${i}`).join('\n')}\n`);
      await write('leaf.yaml', SAFE_COMPOSE);
      const files = Array.from({ length: 2000 }, () => '      - big.env').join('\n');
      await write('compose.yaml', `include:\n  - path: leaf.yaml\n    env_file:\n${files}\n`);
      const started = Date.now();
      await expect(run()).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(3_000);
    });

    it('accepts an umbrella that includes many projects, each with its own .env', async () => {
      const entries: string[] = [];
      for (let i = 0; i < 100; i += 1) {
        await write(`app${i}/compose.yaml`, SAFE_COMPOSE);
        await write(`app${i}/.env`, `TAG=v${i}\n`);
        entries.push(`  - app${i}/compose.yaml`);
      }
      await write('compose.yaml', `include:\n${entries.join('\n')}\n`);
      await expect(run()).resolves.toBeUndefined();
    });

    it('refuses more distinct env files than the bound', async () => {
      await write('leaf.yaml', SAFE_COMPOSE);
      const envFiles: string[] = [];
      for (let i = 0; i < 520; i += 1) {
        await write(`e${i}.env`, `K${i}=1\n`);
        envFiles.push(`      - e${i}.env`);
      }
      await write('compose.yaml', `include:\n  - path: leaf.yaml\n    env_file:\n${envFiles.join('\n')}\n`);
      await expect(run()).rejects.toThrow(/past 512 files/);
    });

    it('refuses the same large file parsed under many project directories', async () => {
      await write('dep.yaml', `# ${'x'.repeat(500_000)}\n`);
      const entries = Array.from({ length: 20 }, (_, i) => `  - path: dep.yaml\n    project_directory: p${i}`);
      await write('compose.yaml', `include:\n${entries.join('\n')}\n`);
      await expect(run()).rejects.toThrow(/MiB of compose text in total/);
    });

    it('reads a lone carriage return as a line break, as Compose does', async () => {
      await write('compose.yaml', 'services:\n  web:\n    image: alpine\n# c\rinclude:\r  - inc.yaml\r');
      await write('inc.yaml', nestedAliasBomb(12));
      await expect(run()).rejects.toBeInstanceOf(ComposeExpansionRefusal);
      const bomb = nestedAliasBomb(12).replace(/\n/g, '\r');
      await write('compose.yaml', `x-pad: 1 # note\r${bomb}`);
      await expect(run()).rejects.toBeInstanceOf(ComposeExpansionRefusal);
    });

    it('accepts a file with lone-CR or CRLF line endings that reuses an anchor', async () => {
      const source = 'x-a: &a [1, 2]\nservices:\n  web:\n    image: nginx\n    x-list: *a\n';
      await write('compose.yaml', source.replace(/\n/g, '\r'));
      await expect(run()).resolves.toBeUndefined();
      await write('compose.yaml', source.replace(/\n/g, '\r\n'));
      await expect(run()).resolves.toBeUndefined();
    });

    it('checks a ~ service env_file against HOME', async () => {
      // HOME is a different directory from the stack, so `~/pipe.env` names a
      // file only the HOME expansion can reach (the literal `./~/pipe.env` does not exist).
      await fsPromises.mkdir(path.join(dir, 'home'));
      await new Promise<void>((resolve, reject) => {
        execFile('mkfifo', [path.join(dir, 'home', 'pipe.env')], (err) => (err ? reject(err) : resolve()));
      });
      await fsPromises.symlink('/dev/zero', path.join(dir, 'home', 'zero.env'));
      const home = (name: string): string | undefined => (name === 'HOME' ? path.join(dir, 'home') : undefined);
      for (const target of ['~/pipe.env', '~/zero.env']) {
        await write('compose.yaml', `services:\n  web:\n    image: nginx\n    env_file: ${target}\n`);
        await expect(run(dir, ['compose', 'config'], home)).rejects.toThrow(/not a regular file/);
        // With no HOME the path stays literal and nothing there exists.
        await expect(run(dir, ['compose', 'config'], () => undefined)).resolves.toBeUndefined();
      }
    });

    it('names an input outside the stack by its own path', async () => {
      await write('compose.yaml', 'include:\n  - /dev/zero\n');
      await expect(run()).rejects.toThrow(/"\/dev\/zero" is not a regular file/);
    });

    it('refuses env files that total more than the parse budget', async () => {
      await write('leaf.yaml', SAFE_COMPOSE);
      const entries: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        // Each value stays under the single-value bound; the file totals ~900 KB.
        const values = Array.from({ length: 18 }, (_, k) => `K${k}=${'x'.repeat(50_000)}`);
        await write(`e${i}.env`, `${values.join('\n')}\n`);
        entries.push(`  - path: leaf.yaml\n    env_file: e${i}.env`);
      }
      await write('compose.yaml', `include:\n${entries.join('\n')}\n`);
      await expect(run()).rejects.toThrow(/past 8 MiB in total/);
    });

    it('refuses an unbounded service env_file or label_file', async () => {
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n    env_file: /dev/zero\n');
      await expect(run()).rejects.toThrow(/not a regular file/);
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n    env_file:\n      - path: /dev/zero\n        required: false\n');
      await expect(run()).rejects.toThrow(/not a regular file/);
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n    label_file: /dev/zero\n');
      await expect(run()).rejects.toThrow(/not a regular file/);
    });

    it('refuses a service env_file that is a FIFO', async () => {
      await new Promise<void>((resolve, reject) => {
        execFile('mkfifo', [path.join(dir, 'pipe.env')], (err) => (err ? reject(err) : resolve()));
      });
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n    env_file: ./pipe.env\n');
      await expect(run()).rejects.toThrow(/not a regular file/);
    });

    it('refuses an unbounded service env_file inside an included file', async () => {
      await write('compose.yaml', 'include:\n  - dep.yaml\n');
      await write('dep.yaml', 'services:\n  web:\n    image: nginx\n    env_file: ${DEVICE}\n');
      await write('.env', 'DEVICE=/dev/zero\n');
      await expect(run()).rejects.toThrow(/not a regular file/);
    });

    it('accepts a service env_file that is /dev/null, missing, or an ordinary file', async () => {
      await write('ok.env', 'A=1\n');
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n    env_file:\n      - /dev/null\n      - ok.env\n      - missing.env\n');
      await expect(run()).resolves.toBeUndefined();
    });

    it('refuses before parsing further files once the distinct files pass the run budget', async () => {
      const body = `x: [${'a,'.repeat(140_000)}a]\n`;
      for (let level = 0; level < 10; level += 1) {
        await write(`f${level}.yaml`, `${body}${level < 9 ? `include:\n  - f${level + 1}.yaml\n` : ''}`);
      }
      await write('compose.yaml', 'include:\n  - f0.yaml\n');
      await expect(run()).rejects.toThrow(/in total/);
    });
  });
});

describe('assertComposeInputsWithinExpansionLimits - scalar text, interpolation bounds, and layered environments', () => {
  const run = (cwd = dir, invocation: string[] = ['compose', 'config'], env?: (name: string) => string | undefined) =>
    assertComposeInputsWithinExpansionLimits({ cwd, invocation, env });
  const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

  describe('a !!binary scalar names what it decodes to, as Compose reads it', () => {
    beforeEach(async () => {
      await write('dep.yaml', nestedAliasBomb(12));
    });

    it('follows an include path written as !!binary', async () => {
      await write('compose.yaml', `include:\n  - !!binary ${b64('dep.yaml')}\n`);
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
      await write('compose.yaml', `include:\n  - path: !!binary ${b64('dep.yaml')}\n`);
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
    });

    it('follows an extends.file written as !!binary', async () => {
      await write('compose.yaml', `services:\n  web:\n    extends:\n      file: !!binary ${b64('dep.yaml')}\n      service: web\n`);
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
    });

    it('reads a !!binary key as the name it decodes to', async () => {
      await write('compose.yaml', `!!binary ${b64('include')}: [dep.yaml]\n`);
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
      await write('compose.yaml', `!!binary ${b64('services')}:\n  web:\n    image: nginx\n    extends:\n      file: dep.yaml\n      service: web\n`);
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
    });

    it('refuses a service env_file written as !!binary that names a device', async () => {
      await write('compose.yaml', `services:\n  web:\n    image: nginx\n    env_file: !!binary ${b64('/dev/zero')}\n`);
      await expect(run()).rejects.toThrow(/not a regular file/);
    });

    it('accepts a !!binary path to a safe file', async () => {
      await write('dep.yaml', SAFE_COMPOSE.replace('web', 'other'));
      await write('compose.yaml', `include:\n  - !!binary ${b64('dep.yaml')}\n`);
      await expect(run()).resolves.toBeUndefined();
    });
  });

  describe('U+2028 and U+2029 inside a key or path', () => {
    it('refuses an include path that holds one, because Compose keeps it and the parse folds it', async () => {
      for (const separator of ['\u2028', '\u2029']) {
        // Compose loads `x<sep>y.yaml`; folded to a space the guard would look for `x y.yaml`.
        await write(`x${separator}y.yaml`, nestedAliasBomb(12));
        await write('compose.yaml', `include:\n  - "x${separator}    y.yaml"\n`);
        await expect(run()).rejects.toThrow(/U\+2028 or U\+2029/);
      }
    });

    it('still accepts the characters in a comment, or in a value the parse reads cleanly', async () => {
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n    labels:\n      note: "a\u2028          b\u2029          c"\n# trailing\u2028# comment\n');
      await expect(run()).resolves.toBeUndefined();
    });

    it('refuses a document the folded break makes unparsable, rather than guess what Compose reads', async () => {
      // Compose keeps the character in the value; folded, it ends the line and
      // the continuation has no indentation, so the parse rejects the document.
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n    labels:\n      note: "a\u2028b"\n');
      await expect(run()).rejects.toThrow(/Unicode line separator/);
    });
  });

  describe('service env_file and label_file are read under the cap', () => {
    it.runIf(process.platform === 'linux' && existsSync('/proc/self/pagemap'))(
      'refuses a /proc file that reports no size but never ends',
      async () => {
        for (const field of ['env_file', 'label_file']) {
          await write('compose.yaml', `services:\n  web:\n    image: nginx\n    ${field}: /proc/self/pagemap\n`);
          await expect(run()).rejects.toThrow(/larger than 1 MiB/);
        }
      },
    );

    it('refuses an ordinary env_file over the cap and counts its text toward the run', async () => {
      await write('big.env', `A=${'x'.repeat(MAX_COMPOSE_INPUT_BYTES)}\n`);
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n    env_file: big.env\n');
      await expect(run()).rejects.toThrow(/larger than 1 MiB/);
      const nineValues = Array.from({ length: 9 }, (_, k) => `A${k}=${'x'.repeat(100_000)}`).join('\n');
      for (let i = 0; i < 10; i += 1) await write(`m${i}.env`, `${nineValues}\n`);
      const files = Array.from({ length: 10 }, (_, i) => `      - m${i}.env`).join('\n');
      await write('compose.yaml', `services:\n  web:\n    image: nginx\n    env_file:\n${files}\n`);
      await expect(run()).rejects.toThrow(/MiB of compose and env text in total/);
    });
  });

  describe('the guard bounds its own work', () => {
    it('does not rescan blank lines after a rejected document (quadratic regular expression)', async () => {
      const source = `services: [@bad\n${'\n'.repeat(400_000)}`;
      const started = Date.now();
      assertComposeSourceWithinExpansionLimits(source, 'compose.yaml');
      await write('compose.yaml', source);
      await run();
      expect(Date.now() - started).toBeLessThan(3_000);
    });

    it('refuses a .env whose interpolation doubles into gigabytes, quickly and without building it', async () => {
      const lines = ['A0=seed-value'];
      for (let i = 1; i <= 24; i += 1) lines.push(`A${i}="\${A${i - 1}}\${A${i - 1}}"`);
      for (let i = 0; i < 2_000; i += 1) lines.push(`B${i}="\${A24}"`);
      await write('.env', `${lines.join('\n')}\n`);
      await write('compose.yaml', SAFE_COMPOSE);
      const started = Date.now();
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    it('refuses an include env_file value longer than the bound', async () => {
      await write('big.env', `V=${'x'.repeat(140_000)}\n`);
      await write('leaf.yaml', SAFE_COMPOSE);
      await write('compose.yaml', 'include:\n  - path: leaf.yaml\n    env_file: big.env\n');
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
    });

    it('refuses an over-long path template, quickly, and accepts a nested one within the bound', async () => {
      await write('.env', 'A=\n');
      await write('compose.yaml', `include:\n  - '${'${A:-'.repeat(50)}x${'}'.repeat(50)}'\n`);
      const started = Date.now();
      await expect(run()).resolves.toBeUndefined();
      await write('compose.yaml', `include:\n  - '${'${A:-'.repeat(40_000)}'\n`);
      await expect(run()).rejects.toThrow(/too long or interpolates into too much text/);
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    it('refuses a path that repeats a large variable past the expansion bound', async () => {
      await write('.env', `BIG=${'x'.repeat(30_000)}\n`);
      await write('compose.yaml', `include:\n  - '${'${BIG}'.repeat(600)}'\n`);
      await expect(run()).rejects.toThrow(/too long or interpolates into too much text/);
    });

    it('still accepts an ordinary interpolated .env and path', async () => {
      await write('.env', 'DIR=sub\nNAME=${DIR}/dep\nEXT="yaml"\n');
      await write('sub/dep.yaml', SAFE_COMPOSE);
      await write('compose.yaml', 'include:\n  - ${NAME}.${EXT}\n');
      await expect(run()).resolves.toBeUndefined();
    });
  });

  describe('YAML spellings Compose reads as ordinary structure', () => {
    beforeEach(async () => {
      await write('dep.yaml', nestedAliasBomb(12));
    });

    it('follows an include list tagged !!pairs or !!omap, which the parser hands over as bare pairs', async () => {
      await write('compose.yaml', 'include: !!pairs\n  - path: dep.yaml\n');
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
      await write('compose.yaml', 'include: !!omap\n  - path: dep.yaml\n');
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
      await write('compose.yaml', 'include: !!pairs [ {path: dep.yaml} ]\n');
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
    });

    it('reads a service env_file listed as !!pairs', async () => {
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n    env_file: !!pairs\n      - path: /dev/zero\n');
      await expect(run()).rejects.toThrow(/not a regular file/);
    });

    it('treats a quoted << tagged !!merge as a merge key', async () => {
      await write('compose.yaml', "!!merge '<<': {include: [dep.yaml]}\nservices:\n  web:\n    image: nginx\n");
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
      await write('base.yaml', nestedAliasBomb(12));
      await write('compose.yaml', "services:\n  web:\n    image: nginx\n    !!merge '<<': {extends: {file: base.yaml, service: web}}\n");
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
    });

    it('does not read a quoted << with no tag as a merge key', async () => {
      await write('compose.yaml', "x-a: {include: [dep.yaml]}\nservices:\n  web:\n    image: nginx\n    '<<': {extends: {file: dep.yaml, service: web}}\n");
      await expect(run()).resolves.toBeUndefined();
    });

    it('refuses a rejected document that holds a U+2028 or a tag spelling, since either can hide an include', async () => {
      await write('compose.yaml', 'x-note: "p\u2028q"\n!!binary aW5jbHVkZQ==: [dep.yaml]\n');
      await expect(run()).rejects.toThrow(/parser rejects/);
      await write('compose.yaml', 'x-note: "p\u2028q"\nservices:\n  web:\n    image: nginx\n    env_file: "e\u2028f.env"\n');
      await expect(run()).rejects.toThrow(/parser rejects/);
      await write('compose.yaml', '!!binary aW5jbHVkZQ==: [dep.yaml]\nbad: [unclosed\n');
      await expect(run()).rejects.toThrow(/parser rejects/);
    });

    it('still leaves a plain syntax error with none of those for Compose to report', async () => {
      await write('compose.yaml', 'services:\n  web:\n    image: [unclosed\n');
      await expect(run()).resolves.toBeUndefined();
    });

    it('refuses a !!binary path that is not valid UTF-8, which Compose keeps as raw bytes', async () => {
      await write('compose.yaml', `include:\n  - !!binary ${Buffer.from([0x64, 0xff, 0x2e, 0x79, 0x61, 0x6d, 0x6c]).toString('base64')}\n`);
      await expect(run()).rejects.toThrow(/not UTF-8/);
    });
  });

  describe('large scalars count by their text, not as one node', () => {
    it('refuses one large anchored string aliased many times', async () => {
      const big = 'x'.repeat(100_000);
      const refs = Array.from({ length: 4_000 }, () => '*b').join(', ');
      await write('compose.yaml', `x-big: &b "${big}"\nx-use: [${refs}]\nservices:\n  web:\n    image: nginx\n`);
      await expect(run()).rejects.toThrow(/expands to more than 250,000 nodes/);
    });

    it('accepts a large scalar used a few times, and ordinary short strings used often', async () => {
      const big = 'x'.repeat(100_000);
      await write('compose.yaml', `x-big: &b "${big}"\nx-use: [*b, *b, *b]\nservices:\n  web:\n    image: nginx\n`);
      await expect(run()).resolves.toBeUndefined();
    });
  });

  describe('a service env_file is interpolated, so it is bounded like a project .env', () => {
    const doubling = (levels: number): string => {
      const lines = ['A0=seed'];
      for (let i = 1; i <= levels; i += 1) lines.push(`A${i}="\${A${i - 1}}\${A${i - 1}}"`);
      return `${lines.join('\n')}\n`;
    };

    it('refuses a doubling env_file and label_file, but reads a format: raw one literally', async () => {
      await write('bomb.env', doubling(24));
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n    env_file: bomb.env\n');
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n    label_file: bomb.env\n');
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n    env_file:\n      - path: bomb.env\n        format: raw\n');
      await expect(run()).resolves.toBeUndefined();
    });

    it('leaves a syntax error in an env_file for Compose and accepts ordinary interpolation', async () => {
      await write('bad.env', 'A B=1\n');
      await write('ok.env', 'NAME=${HOME_DIR:-/srv}/app\nOTHER="${NAME}-x"\n');
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n    env_file: [bad.env, ok.env]\n');
      await expect(run()).resolves.toBeUndefined();
    });

    it('reads a file that many services share once', async () => {
      await write('shared.env', `A=${'x'.repeat(112_000)}\n`);
      const services = Array.from({ length: 120 }, (_, i) => `  s${i}:\n    image: nginx\n    env_file: shared.env`).join('\n');
      await write('compose.yaml', `services:\n${services}\n`);
      const openSpy = vi.spyOn(fsPromises, 'open');
      try {
        await expect(run()).resolves.toBeUndefined();
        expect(openSpy.mock.calls.filter(([target]) => /shared\.env$/.test(String(target))).length).toBe(1);
      } finally {
        openSpy.mockRestore();
      }
    });
  });

  describe('template nesting and process descriptors', () => {
    it('refuses a path or env value nested past the depth bound, and accepts ordinary nesting', async () => {
      await write('.env', 'A=\n');
      await write('compose.yaml', `include:\n  - '${'${A:-'.repeat(100)}x${'}'.repeat(100)}'\n`);
      await expect(run()).rejects.toThrow(/too long or interpolates into too much text/);
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
      await write('.env', `B=${'${A:-'.repeat(100)}x${'}'.repeat(100)}\n`);
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
      await write('.env', 'A=\nB=${A:-${A:-${A:-x}}}\n');
      await expect(run()).resolves.toBeUndefined();
    });

    it('refuses a compose input named by one of the process descriptors, which are not the child\'s', async () => {
      await write('compose.yaml', SAFE_COMPOSE);
      await expect(run(dir, ['compose', '-f', '/dev/stdin', 'config'])).rejects.toThrow(/not a regular file/);
      await expect(run(dir, ['compose', '--env-file', '/proc/self/fd/0', 'config'])).rejects.toThrow(/not a regular file/);
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n    env_file: /proc/self/mem\n');
      await expect(run()).rejects.toThrow(/not a regular file/);
    });
  });

  describe('env-file reads stop at the byte bound', () => {
    it('stops reading once the env files read pass 8 MiB, instead of reading every listed file', async () => {
      const values = Array.from({ length: 18 }, (_, k) => `K${k}=${'x'.repeat(50_000)}`);
      await write('real.env', `${values.join('\n')}\n`);
      const links: string[] = [];
      for (let i = 0; i < 60; i += 1) {
        await fsPromises.symlink(path.join(dir, 'real.env'), path.join(dir, `link${i}.env`));
        links.push(`      - link${i}.env`);
      }
      await write('leaf.yaml', SAFE_COMPOSE);
      await write('compose.yaml', `include:\n  - path: leaf.yaml\n    env_file:\n${links.join('\n')}\n`);
      const openSpy = vi.spyOn(fsPromises, 'open');
      try {
        await expect(run()).rejects.toThrow(/past 8 MiB in total/);
        const envOpens = openSpy.mock.calls.filter(([target]) => /link\d+\.env$/.test(String(target))).length;
        // 900 KB each: the ninth read passes 8 MiB, so the other files stay unread.
        expect(envOpens).toBeLessThanOrEqual(12);
      } finally {
        openSpy.mockRestore();
      }
    });
  });

  describe('standard input', () => {
    it('refuses -f - and a COMPOSE_FILE entry of -, which the guard cannot read', async () => {
      await write('compose.yaml', SAFE_COMPOSE);
      await expect(run(dir, ['compose', '-f', '-', 'config'])).rejects.toThrow(/standard input/);
      await expect(run(dir, ['compose', 'config'], (name) => (name === 'COMPOSE_FILE' ? '-' : undefined)))
        .rejects.toThrow(/standard input/);
    });
  });

  describe('layered include environments', () => {
    it('keeps an inherited name over an include env_file assignment, as Compose does', async () => {
      await write('.env', 'FOO=fromroot\n');
      await write('e.env', 'FOO=frominc\n');
      await write('fromroot.yaml', nestedAliasBomb(12));
      await write('frominc.yaml', SAFE_COMPOSE);
      await write('compose.yaml', 'include:\n  - path: mid.yaml\n    env_file: e.env\n');
      await write('mid.yaml', 'include:\n  - ${FOO}.yaml\n');
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
    });

    it('measures a shared file again when only an ancestor layer differs', async () => {
      // `leaf.yaml` is reached through `mid.yaml` under two outer layers with the
      // same inner `b.env`; the include it declares names a file chosen by the outer one.
      await write('a1.env', 'DEP=safe.yaml\n');
      await write('a2.env', 'DEP=bomb.yaml\n');
      await write('b.env', 'X=1\n');
      await write('safe.yaml', SAFE_COMPOSE);
      await write('bomb.yaml', nestedAliasBomb(12));
      await write('compose.yaml', 'include:\n  - path: mid.yaml\n    env_file: a1.env\n  - path: mid.yaml\n    env_file: a2.env\n');
      await write('mid.yaml', 'include:\n  - path: leaf.yaml\n    env_file: /ABS/b.env\n'.replace('/ABS', dir));
      await write('leaf.yaml', 'include:\n  - ${DEP}\n');
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
    });
  });
});
