/**
 * Unit tests for the compose alias-expansion guard. These run against the real
 * filesystem because the guard's contract is what it reads, not how a caller
 * mocks it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'child_process';
import { closeSync, existsSync, openSync, promises as fsPromises } from 'fs';
import os from 'os';
import path from 'path';
import {
  assertComposeInputsWithinExpansionLimits,
  assertComposeSourceWithinExpansionLimits,
  composeFileArgsFromInvocation,
  MAX_COMPOSE_DEPENDENCY_REFERENCES,
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

    it('reads a small env file listed many times, once per mention, within the time and bounds', async () => {
      await write('small.env', 'K=value\nL=${K}\n');
      await write('leaf.yaml', SAFE_COMPOSE);
      const files = Array.from({ length: 2000 }, () => '      - small.env').join('\n');
      await write('compose.yaml', `include:\n  - path: leaf.yaml\n    env_file:\n${files}\n`);
      const started = Date.now();
      await expect(run()).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(3_000);
    });

    it('bounds a large env file listed many times by the text parsed for every mention', async () => {
      await write('big.env', `${Array.from({ length: 20_000 }, (_, i) => `K${i}=value${i}`).join('\n')}\n`);
      await write('leaf.yaml', SAFE_COMPOSE);
      const files = Array.from({ length: 2000 }, () => '      - big.env').join('\n');
      await write('compose.yaml', `include:\n  - path: leaf.yaml\n    env_file:\n${files}\n`);
      const started = Date.now();
      await expect(run()).rejects.toThrow(/MiB in total/);
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
  /** `count` different spellings of one relative path, which Compose treats as different entries. */
  const distinctSpellings = (name: string, count: number): string[] =>
    Array.from({ length: count }, (_, i) => `${'./'.repeat(i)}${name}`);
  /** A !!binary value whose bytes are a UTF-8 BOM and then `name`. */
  const bomBinary = (name: string): string => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(name, 'utf8')]).toString('base64');

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

    it('counts a !!binary value and a very long numeral by their text as well', async () => {
      const refs = Array.from({ length: 4_000 }, () => '*b').join(', ');
      const binary = Buffer.alloc(100_000, 7).toString('base64');
      await write('compose.yaml', `x-big: &b !!binary ${binary}\nx-use: [${refs}]\nservices:\n  web:\n    image: nginx\n`);
      await expect(run()).rejects.toThrow(/expands to more than 250,000 nodes/);
      await write('compose.yaml', `x-big: &b ${'1'.repeat(100_000)}\nx-use: [${refs}]\nservices:\n  web:\n    image: nginx\n`);
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

    it('refuses a doubling chain Compose builds across one service\'s env_file list, however the file is spelled', async () => {
      await write('a.env', `A=${'x'.repeat(1_000)}\n`);
      await write('d.env', 'A=${A}${A}\n');
      // Compose keeps one entry per path string, so each spelling is its own read.
      const list = ['a.env', ...distinctSpellings('d.env', 24)];
      await write('compose.yaml', `services:\n  web:\n    image: nginx\n    env_file: [${list.join(', ')}]\n`);
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
      // A label_file list is read mention by mention, so exact repeats count.
      const repeated = ['a.env', ...Array.from({ length: 24 }, () => 'd.env')];
      await write('compose.yaml', `services:\n  web:\n    image: nginx\n    label_file: [${repeated.join(', ')}]\n`);
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
    });

    it('seeds the chain from the service environment, as a map or a list', async () => {
      await write('d.env', 'A=${A}${A}\n');
      const list = distinctSpellings('d.env', 24).join(', ');
      await write('compose.yaml', `services:\n  web:\n    image: nginx\n    environment:\n      A: "${'x'.repeat(100_000)}"\n    env_file: [${list}]\n`);
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
      await write('compose.yaml', `services:\n  web:\n    image: nginx\n    environment:\n      - A=${'x'.repeat(100_000)}\n    env_file: [${list}]\n`);
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
    });

    it('interpolates the service environment against the project environment before it seeds the chain', async () => {
      await write('.env', `BIG=${'x'.repeat(100_000)}\n`);
      await write('d.env', 'A=${A}${A}\n');
      // Fourteen doublings: the literal `${BIG}` (6 characters) stays small, the
      // interpolated 100 KB value passes 1 GB.
      const list = distinctSpellings('d.env', 14).join(', ');
      await write('compose.yaml', `services:\n  web:\n    image: nginx\n    environment:\n      A: "\${BIG}"\n    env_file: [${list}]\n`);
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
      // A value that names nothing large keeps the chain small.
      await write('compose.yaml', `services:\n  web:\n    image: nginx\n    environment:\n      A: "\${MISSING:-ab}"\n    env_file: [d.env, d.env, d.env]\n`);
      await expect(run()).resolves.toBeUndefined();
    });

    it('accepts a short chain over the same file, and a shared file in an umbrella of includes with their own .env', async () => {
      await write('a.env', 'A=ab\n');
      await write('d.env', 'A=${A}${A}\n');
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n    env_file: [a.env, d.env, d.env, d.env, d.env]\n');
      await expect(run()).resolves.toBeUndefined();
      await write('common.env', `K=${'x'.repeat(112_000)}\n`);
      const entries: string[] = [];
      for (let i = 0; i < 80; i += 1) {
        await write(`app${i}/compose.yaml`, 'services:\n  web:\n    image: nginx\n    env_file: ../common.env\n');
        await write(`app${i}/.env`, `TAG=v${i}\n`);
        entries.push(`  - app${i}/compose.yaml`);
      }
      await write('compose.yaml', `include:\n${entries.join('\n')}\n`);
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

    it('counts a brace the expander counts, so nesting cannot hide behind a stray {', async () => {
      await write('compose.yaml', SAFE_COMPOSE);
      await write('.env', `B=${'${a:-{}'.repeat(100)}\n`);
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
    });

    it('reads nesting from the text an escape decodes to', async () => {
      await write('compose.yaml', SAFE_COMPOSE);
      // `\0044` is `$` and `\0173` is `{` to Compose's double-quoted decoder.
      await write('.env', `B="${'\\0044\\0173a:-'.repeat(100)}x"\n`);
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
    });

    it('refuses a path that reaches a process descriptor through a linked directory', async () => {
      // `/dev/fd` is a link to `/proc/self/fd`; an open regular file's descriptor
      // read through it is an ordinary file by its content, so only the name shows it.
      await fsPromises.symlink('/dev', path.join(dir, 'devlink'));
      await write('plain.env', 'A=1\n');
      const fd = openSync(path.join(dir, 'plain.env'), 'r');
      try {
        await write('compose.yaml', `services:\n  web:\n    image: nginx\n    env_file: devlink/fd/${fd}\n`);
        await expect(run()).rejects.toThrow(/not a regular file/);
      } finally {
        closeSync(fd);
      }
    });

    it('refuses a symlink that leads to a process descriptor, and one through /proc/self/root', async () => {
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n    env_file: link.env\n');
      await fsPromises.symlink('/dev/stdin', path.join(dir, 'link.env'));
      await expect(run()).rejects.toThrow(/not a regular file/);
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n    env_file: /proc/self/root/dev/stdin\n');
      await expect(run()).rejects.toThrow(/not a regular file/);
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
  describe('an include env_file listed more than once is read once per mention', () => {
    // `TARGET=${TARGET}a` appends one letter on every read, so the included file
    // Compose selects (`${TARGET}.yaml`) depends on how many times it was read.
    beforeEach(async () => {
      await write('grow.env', 'TARGET=${TARGET}a\n');
      await write('a.yaml', SAFE_COMPOSE);
      await write('aa.yaml', nestedAliasBomb(12));
      await write('aaa.yaml', SAFE_COMPOSE);
      // The included file interpolates its own include path with the entry's env files.
      await write('mid.yaml', 'include:\n  - ${TARGET}.yaml\n');
    });
    const includeWith = (envFiles: string): string => `include:\n  - path: mid.yaml\n    env_file: [${envFiles}]\n`;

    it('follows the file the second read selects, for the same spelling and for another one', async () => {
      await write('compose.yaml', includeWith('grow.env, grow.env'));
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
      await write('compose.yaml', includeWith('grow.env, ./grow.env'));
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
      await write('compose.yaml', includeWith(`grow.env, ${dir}/grow.env`));
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
    });

    it('reads a repeat that has another file between its mentions, and counts a third read', async () => {
      await write('other.env', 'OTHER=1\n');
      await write('compose.yaml', includeWith('grow.env, other.env, grow.env'));
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
      // One more read moves the selection on to a safe file.
      await write('compose.yaml', includeWith('grow.env, grow.env, grow.env'));
      await expect(run()).resolves.toBeUndefined();
    });

    it('still follows the file one read selects', async () => {
      await write('compose.yaml', includeWith('grow.env'));
      await expect(run()).resolves.toBeUndefined();
      await write('a.yaml', nestedAliasBomb(12));
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
    });

    it('reads every mention of a list shared by two includes, and keeps their layers apart', async () => {
      await write('compose.yaml', 'include:\n  - path: mid.yaml\n    env_file: [grow.env]\n  - path: mid.yaml\n    env_file: [grow.env, grow.env]\n');
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
    });
  });

  describe('a !!binary path that starts with a UTF-8 BOM names the file with U+FEFF in its name', () => {
    const BOM = '﻿';

    it('follows an include, a mapped include, and an extends.file', async () => {
      await write('dep.yaml', SAFE_COMPOSE.replace('web', 'other'));
      await write(`${BOM}dep.yaml`, nestedAliasBomb(12));
      await write('compose.yaml', `include:\n  - !!binary ${bomBinary('dep.yaml')}\n`);
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
      await write('compose.yaml', `include:\n  - path: !!binary ${bomBinary('dep.yaml')}\n`);
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
      await write('compose.yaml', `services:\n  web:\n    extends:\n      file: !!binary ${bomBinary('dep.yaml')}\n      service: web\n`);
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
    });

    it('opens the BOM-named file for a service env_file and label_file, over the size cap', async () => {
      await write('big.env', 'K=1\n');
      await write(`${BOM}big.env`, `K=${'x'.repeat(MAX_COMPOSE_INPUT_BYTES + 10)}\n`);
      await write('compose.yaml', `services:\n  web:\n    image: nginx\n    env_file: !!binary ${bomBinary('big.env')}\n`);
      await expect(run()).rejects.toThrow(/larger than 1 MiB/);
      await write('compose.yaml', `services:\n  web:\n    image: nginx\n    label_file: [!!binary ${bomBinary('big.env')}]\n`);
      await expect(run()).rejects.toThrow(/larger than 1 MiB/);
      await write('compose.yaml', `services:\n  web:\n    image: nginx\n    env_file:\n      - path: !!binary ${bomBinary('big.env')}\n`);
      await expect(run()).rejects.toThrow(/larger than 1 MiB/);
    });

    it('reads the same path without a BOM as before', async () => {
      await write('dep.yaml', nestedAliasBomb(12));
      await write('compose.yaml', `include:\n  - !!binary ${b64('dep.yaml')}\n`);
      await expect(run()).rejects.toThrow(/nested YAML aliases/);
    });

    it('does not take a BOM-prefixed key for the key without one', async () => {
      await write('dep.yaml', nestedAliasBomb(12));
      await write('compose.yaml', `!!binary ${bomBinary('include')}: [dep.yaml]\n`);
      await expect(run()).resolves.toBeUndefined();
    });
  });

  describe('a service environment seeds its env files with the text Compose gives the value', () => {
    /** `B0=${A}` and then `levels` doublings, so the last statement copies 2^levels times the seed. */
    const chain = (levels: number): string => {
      const lines = ['B0=${A}'];
      for (let i = 1; i <= levels; i += 1) lines.push(`B${i}="\${B${i - 1}}\${B${i - 1}}"`);
      return `${lines.join('\n')}\n`;
    };
    const withSeed = (seed: string, extra = ''): string =>
      `services:\n  web:\n    image: nginx\n    environment:\n      A: ${seed}\n${extra}    env_file: [chain.env]\n`;

    it.each(['true', 'True', 'false', 'FALSE'])('seeds the boolean %s as its text', async (seed) => {
      // 2^20 copies of four or five characters pass the 1 MiB statement bound.
      await write('chain.env', chain(20));
      await write('compose.yaml', withSeed(seed));
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
    });

    it('seeds a timestamp as the time Compose prints, not as it was written', async () => {
      // 2^16 copies of ten characters stay under the bound; 29 characters pass it.
      await write('chain.env', chain(16));
      await write('compose.yaml', withSeed('2020-01-01'));
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
      await write('compose.yaml', withSeed('"2020-01-01"'));
      await expect(run()).resolves.toBeUndefined();
      await write('compose.yaml', withSeed('2020-01-01T00:00:00Z'));
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
    });

    it('seeds a number as the text Compose prints', async () => {
      // `1e-7` prints as `1e-07`, five characters, where JavaScript prints four:
      // 2^18 copies of five pass the 1 MiB bound and of four do not.
      await write('chain.env', chain(18));
      await write('compose.yaml', withSeed('1e-7'));
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
      await write('chain.env', chain(20));
      await write('compose.yaml', withSeed('1234'));
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
      await write('compose.yaml', withSeed('0'));
      await expect(run()).resolves.toBeUndefined();
    });

    it('keeps a string as written: a quoted scalar, a !!str one, and the words yes and on', async () => {
      await write('chain.env', chain(16));
      for (const seed of ['"true"', '!!str true', '!!str 2020-01-01', 'yes', 'on', '"1e-7"', '"010"', "'2020-01-01'"]) {
        await write('compose.yaml', withSeed(seed));
        await expect(run()).resolves.toBeUndefined();
      }
    });

    it('takes a null value, or a bare name in a list, from the environment by name', async () => {
      await write('chain.env', chain(10));
      const big = 'x'.repeat(100_000);
      // Unset: nothing to seed.
      await write('compose.yaml', withSeed('~'));
      await expect(run()).resolves.toBeUndefined();
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n    environment:\n      - A\n    env_file: [chain.env]\n');
      await expect(run()).resolves.toBeUndefined();
      // Set by the process environment, or by the project .env.
      const processEnv = (name: string): string | undefined => (name === 'A' ? big : undefined);
      await write('compose.yaml', withSeed('~'));
      await expect(run(dir, ['compose', 'config'], processEnv)).rejects.toThrow(/too long, or interpolates into more text/);
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n    environment:\n      - A\n    env_file: [chain.env]\n');
      await expect(run(dir, ['compose', 'config'], processEnv)).rejects.toThrow(/too long, or interpolates into more text/);
      await write('.env', `A=${big}\n`);
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
    });

    it('reads a quoted value with an explicit non-string tag the way a plain one is read', async () => {
      await write('chain.env', chain(16));
      await write('compose.yaml', withSeed("!!timestamp '2020-01-01'"));
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
      await write('chain.env', chain(18));
      await write('compose.yaml', withSeed('!!float "1e-7"'));
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
    });

    it('seeds a !!binary value as the text it decodes to, and a value reached through an alias', async () => {
      await write('chain.env', chain(20));
      await write('compose.yaml', withSeed(`!!binary ${b64('xxxx')}`));
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
      await write('compose.yaml', `x-v: &v true\nservices:\n  web:\n    image: nginx\n    environment:\n      A: *v\n    env_file: [chain.env]\n`);
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
    });

    it('seeds a !!binary environment value that is not UTF-8 at one character per byte', async () => {
      // Compose interpolates the bytes as they are: three bytes, 2^19 copies exceed the bound.
      const bytes = Buffer.from([0xff, 0xfe, 0xfd]).toString('base64');
      await write('chain.env', chain(19));
      await write('compose.yaml', withSeed(`!!binary ${bytes}`));
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
      await write('chain.env', chain(16));
      await expect(run()).resolves.toBeUndefined();
    });

    describe('at the boundary Compose crosses, not the one the written text suggests', () => {
      /** `B0=${A}`, `levels` doublings, then `F` holding `copies` of the last, so `F` is `copies * 2^levels` seeds long. */
      const scaled = (levels: number, copies: number): string => {
        const lines = ['B0=${A}'];
        for (let i = 1; i <= levels; i += 1) lines.push(`B${i}="\${B${i - 1}}\${B${i - 1}}"`);
        lines.push(`F="${`\${B${levels}}`.repeat(copies)}"`);
        return `${lines.join('\n')}\n`;
      };
      const refuses = async (seed: string, levels: number, copies: number): Promise<void> => {
        await write('chain.env', scaled(levels, copies));
        await write('compose.yaml', withSeed(seed));
        await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
      };
      const accepts = async (seed: string, levels: number, copies: number): Promise<void> => {
        await write('chain.env', scaled(levels, copies));
        await write('compose.yaml', withSeed(seed));
        await expect(run()).resolves.toBeUndefined();
      };

      // 3 * 2^14 copies: a 29-character timestamp builds 1,425,408 characters, past the 1 MiB
      // bound, where the 20 characters the text is written in build 983,040.
      // Each seed's value is written in 21 characters or fewer, which stay within the bound as written.
      it.each(['2020-01-01  10:20:30', '2020-1-1  1:2:3', '2020-01-01   10:20:30', '!!timestamp 2020-01-01  10:20:30'])(
        'seeds %s as the 29-character time Compose prints for it',
        async (seed) => {
          await refuses(seed, 14, 3);
        },
      );

      it('keeps a date and time that Compose does not read as a timestamp as the text it is', async () => {
        // A tab, or a space before the `T`, is no timestamp: at most 21 characters build at most 1,032,192.
        await accepts('2020-01-01\t10:20:30', 14, 3);
        await accepts('2020-01-01 T10:20:30Z', 14, 3);
      });

      // 13 * 2^12 copies: 21 characters of `9.223372036854776e+18` build 1,118,208 characters,
      // where the 19 of the integer it was written as build 1,011,712.
      it.each(['!!float 9223372036854775807', '!!float "9223372036854775807"', '!!float 0x7fffffffffffffff'])(
        'seeds %s as the float Compose converts it to',
        async (seed) => {
          await refuses(seed, 12, 13);
        },
      );

      it('seeds the same digits written without a tag as the integer they are', async () => {
        await accepts('9223372036854775807', 12, 13);
        await accepts('!!int 9223372036854775807', 12, 13);
      });

      it.each(['!custom 2020-01-01', '!custom 2020-01-01T10:20:30Z', '!!seq 2020-01-01', '!!set 2020-01-01'])(
        'keeps %s as the string it is: a tag that is not int, float, bool, or timestamp resolves nothing',
        async (seed) => {
          // At most 21 characters stay within the bound as written; read as a timestamp, 29 would exceed it.
          await accepts(seed, 14, 3);
        },
      );

      it('reads a quoted scalar under an explicit tag the way Compose resolves it', async () => {
        await refuses('!!float "9223372036854775807"', 12, 13);
        await refuses("!!timestamp '2020-01-01  10:20:30'", 14, 3);
        // `!!str` and an untagged quoted scalar stay strings.
        await accepts('"2020-01-01  10:20:30"', 14, 3);
        await accepts('!!str 2020-01-01  10:20:30', 14, 3);
      });

      it('seeds a value Compose rejects as written, and leaves a null one to the environment', async () => {
        // 80 KB under a type it cannot have: Compose reports the type error itself, and a gap between
        // this reader and Compose can only count more text. Four doublings of it stay within the bound only if unseeded.
        const text = 'x'.repeat(80_000);
        for (const seed of [`!!int ${text}`, `!!float ${text}`, `!!bool ${text}`]) await refuses(seed, 4, 1);
        for (const seed of [`!!null ${text}`, `!!merge ${text}`]) await accepts(seed, 4, 1);
      });

      // 2^14 copies of one character: a numeral padded with zeros is the value it names.
      it.each([`0x${'0'.repeat(70)}1`, `0b${'0'.repeat(70)}1`, `0o${'0'.repeat(70)}1`, `-0x${'0'.repeat(70)}1`, `0${'0'.repeat(70)}7`])(
        'seeds the padded numeral %s as the short value it names',
        async (seed) => {
          await accepts(seed, 14, 1);
        },
      );

      it('still refuses a numeral whose digits count: 2^20 copies of its value exceed the bound', async () => {
        await refuses(`0x${'0'.repeat(70)}ff`, 20, 1);
        await refuses('0b11111111', 20, 1);
      });

      it('reads the same scalars through an alias and a merged map', async () => {
        await write('chain.env', scaled(14, 3));
        await write(
          'compose.yaml',
          `x-v: &v 2020-01-01  10:20:30\nx-env: &env\n  A: *v\nservices:\n  web:\n    image: nginx\n    environment:\n      <<: *env\n    env_file: [chain.env]\n`,
        );
        await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
        await write(
          'compose.yaml',
          `x-v: &v !custom 2020-01-01\nx-env: &env\n  A: *v\nservices:\n  web:\n    image: nginx\n    environment:\n      <<: *env\n    env_file: [chain.env]\n`,
        );
        await expect(run()).resolves.toBeUndefined();
      });
    });

    it('seeds a value from a merged environment map the same way', async () => {
      await write('chain.env', chain(20));
      await write('compose.yaml', `x-env: &env\n  A: true\nservices:\n  web:\n    image: nginx\n    environment:\n      <<: *env\n    env_file: [chain.env]\n`);
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
    });
  });

  describe('a service env_file keeps one entry per path, as Compose does', () => {
    const big = 'x'.repeat(100_000);
    const seeded = (list: string): string =>
      `services:\n  web:\n    image: nginx\n    environment:\n      A: "${big}"\n    env_file: [${list}]\n`;

    beforeEach(async () => {
      await write('d.env', 'A=${A}${A}\n');
      await write('.env', 'X=d\n');
    });

    it('applies a path listed more than once a single time, whatever the other attributes', async () => {
      // Five applications would build 3.2 MB; one builds 200 KB.
      await write('compose.yaml', seeded(Array.from({ length: 6 }, () => 'd.env').join(', ')));
      await expect(run()).resolves.toBeUndefined();
      await write('compose.yaml', seeded('d.env, "${X}.env", {path: d.env, required: false}, d.env, "${X}.env", {path: d.env}'));
      await expect(run()).resolves.toBeUndefined();
    });

    it('applies a path whose spelling differs once for each spelling', async () => {
      await write('compose.yaml', seeded(distinctSpellings('d.env', 5).join(', ')));
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
    });

    it('keeps a repeated path at the place it first appeared', async () => {
      // `x.env` sets A to a 100 KB value after the five `d.env` spellings have doubled `z`.
      // Moving the later mentions to the end would double that value five times.
      await write('x.env', 'A=${BIG}\n');
      const spellings = distinctSpellings('d.env', 5);
      const list = [...spellings, 'x.env', ...spellings].join(', ');
      await write('compose.yaml', `services:\n  web:\n    image: nginx\n    environment:\n      A: z\n    env_file: [${list}]\n`);
      const env = (name: string): string | undefined => (name === 'BIG' ? big : undefined);
      await expect(run(dir, ['compose', 'config'], env)).resolves.toBeUndefined();
    });

    it('reads a label_file list mention by mention', async () => {
      await write('a.env', `A=${big}\n`);
      await write('compose.yaml', `services:\n  web:\n    image: nginx\n    label_file: [a.env, ${Array.from({ length: 6 }, () => 'd.env').join(', ')}]\n`);
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
    });

    it('gives a path the format its last mention names', async () => {
      // Each spelling is first a raw read, which would not interpolate, and then a plain one.
      // Compose keeps one entry per spelling with the plain format, so all five double the seed.
      const spellings = distinctSpellings('d.env', 5);
      const list = [...spellings.map((name) => `{path: ${name}, format: raw}`), ...spellings].join(', ');
      await write('compose.yaml', seeded(list));
      await expect(run()).rejects.toThrow(/too long, or interpolates into more text/);
      // The reverse order keeps the raw format, which reads the text literally.
      const reversed = [...spellings, ...spellings.map((name) => `{path: ${name}, format: raw}`)].join(', ');
      await write('compose.yaml', seeded(reversed));
      await expect(run()).resolves.toBeUndefined();
    });
  });

  describe('an env_file or label_file chain is bounded over what Compose combines, not over each definition', () => {
    // The first definition builds 640 KB (below the 1 MiB statement bound) and
    // the continuation doubles it to 1.28 MB, which Compose builds and each
    // definition alone would never reach.
    const seedText = 'x'.repeat(80_000);
    const doublings = (from: number, to: number): string =>
      Array.from({ length: to - from + 1 }, (_, i) => `B${from + i}="\${B${from + i - 1}}\${B${from + i - 1}}"`).join('\n');
    const continuation = `${doublings(4, 4)}\n`;

    interface Form {
      files: Record<string, string>;
      invocation: string[];
    }
    /** One service that Compose assembles from two definitions, the first holding `first` and the second `second`. */
    const forms = (kind: 'env_file' | 'label_file', second: string): Record<string, Form> => {
      const seed = kind === 'env_file' ? `    environment:\n      A: ${seedText}\n` : '';
      const first =
        kind === 'env_file'
          ? `B0=\${A}\n${doublings(1, 3)}\n`
          : `B0=${seedText}\n${doublings(1, 3)}\n`;
      const head = (list: string): string => `services:\n  web:\n    image: nginx\n${seed}    ${kind}: [${list}]\n`;
      const more = (list: string): string => `services:\n  web:\n    ${kind}: [${list}]\n`;
      const env = { 'e1.env': first, 'e2.env': second };
      return {
        'two -f files': { files: { 'a.yaml': head('e1.env'), 'b.yaml': more('e2.env'), ...env }, invocation: ['compose', '-f', 'a.yaml', '-f', 'b.yaml', 'config'] },
        'two documents of one stream': { files: { 'a.yaml': `${head('e1.env')}---\n${more('e2.env')}`, ...env }, invocation: ['compose', '-f', 'a.yaml', 'config'] },
        'an include with a list of paths': {
          files: { 'a.yaml': 'include:\n  - path: [b.yaml, c.yaml]\n', 'b.yaml': head('e1.env'), 'c.yaml': more('e2.env'), ...env },
          invocation: ['compose', '-f', 'a.yaml', 'config'],
        },
        'an extends in the same file': {
          files: {
            'a.yaml': `services:\n  base:\n    image: nginx\n${seed}    ${kind}: [e1.env]\n  web:\n    extends: base\n    ${kind}: [e2.env]\n`,
            ...env,
          },
          invocation: ['compose', '-f', 'a.yaml', 'config'],
        },
        'a -f file and an include of another': {
          files: { 'a.yaml': head('e1.env'), 'b.yaml': 'include:\n  - c.yaml\n', 'c.yaml': more('e2.env'), ...env },
          invocation: ['compose', '-f', 'a.yaml', '-f', 'b.yaml', 'config'],
        },
        'an include and a -f file': {
          files: { 'a.yaml': 'include:\n  - b.yaml\n', 'b.yaml': head('e1.env'), 'c.yaml': more('e2.env'), ...env },
          invocation: ['compose', '-f', 'a.yaml', '-f', 'c.yaml', 'config'],
        },
        'an include and the file that includes it': {
          files: { 'a.yaml': `include:\n  - b.yaml\n${more('e2.env')}`, 'b.yaml': head('e1.env'), ...env },
          invocation: ['compose', '-f', 'a.yaml', 'config'],
        },
        'an include two levels down and a -f file': {
          files: { 'a.yaml': 'include:\n  - b.yaml\n', 'b.yaml': 'include:\n  - c.yaml\n', 'c.yaml': head('e1.env'), 'd.yaml': more('e2.env'), ...env },
          invocation: ['compose', '-f', 'a.yaml', '-f', 'd.yaml', 'config'],
        },
        'an extends in another file': {
          files: {
            'a.yaml': `services:\n  web:\n    extends:\n      file: base.yaml\n      service: base\n    ${kind}: [e2.env]\n`,
            'base.yaml': `services:\n  base:\n    image: nginx\n${seed}    ${kind}: [e1.env]\n`,
            ...env,
          },
          invocation: ['compose', '-f', 'a.yaml', 'config'],
        },
      };
    };

    const writeForm = async (form: Form): Promise<void> => {
      for (const [name, content] of Object.entries(form.files)) await write(name, content);
    };
    const names = Object.keys(forms('env_file', continuation));

    describe.each(['env_file', 'label_file'] as const)('%s', (kind) => {
      it.each(names)('refuses a chain that continues across %s', async (name) => {
        const form = forms(kind, continuation)[name];
        await writeForm(form);
        await expect(run(dir, form.invocation)).rejects.toThrow(/too long, or interpolates into more text/);
      });

      it.each(names)('accepts the same layout across %s when the continuation does not grow the value', async (name) => {
        const form = forms(kind, 'C=1\n')[name];
        await writeForm(form);
        await expect(run(dir, form.invocation)).resolves.toBeUndefined();
      });
    });

    it('applies a path that two definitions both list once, as Compose keeps one entry per path', async () => {
      // Six applications of `A=${A}${A}` would build 6.4 MB from a 100 KB seed; one builds 200 KB.
      await write('d.env', 'A=${A}${A}\n');
      const big = 'x'.repeat(100_000);
      await write('a.yaml', `services:\n  web:\n    image: nginx\n    environment:\n      A: "${big}"\n    env_file: [d.env, d.env, d.env]\n`);
      await write('b.yaml', 'services:\n  web:\n    env_file: [d.env, d.env, d.env]\n');
      await expect(run(dir, ['compose', '-f', 'a.yaml', '-f', 'b.yaml', 'config'])).resolves.toBeUndefined();
    });

    it('seeds a later definition from an `environment:` another definition supplied', async () => {
      // The seed is in the file that has no env_file, so only the combined service holds both.
      await write('a.yaml', `services:\n  web:\n    image: nginx\n    environment:\n      A: ${seedText}\n`);
      await write('b.yaml', 'services:\n  web:\n    env_file: [e1.env, e2.env]\n');
      await write('e1.env', `B0=\${A}\n${doublings(1, 3)}\n`);
      await write('e2.env', continuation);
      await expect(run(dir, ['compose', '-f', 'a.yaml', '-f', 'b.yaml', 'config'])).rejects.toThrow(/too long, or interpolates into more text/);
      // A later definition overrides the value, so the earlier seed is not the one the files read.
      await write('c.yaml', 'services:\n  web:\n    environment:\n      A: small\n');
      await expect(run(dir, ['compose', '-f', 'a.yaml', '-f', 'b.yaml', '-f', 'c.yaml', 'config'])).resolves.toBeUndefined();
    });

    describe('a !override or !reset tag drops what an earlier definition gave', () => {
      const seeded = (kind: 'env_file' | 'label_file'): Record<string, string> => ({
        'a.yaml':
          kind === 'env_file'
            ? `services:\n  web:\n    image: nginx\n    environment:\n      A: ${seedText}\n    env_file: [e1.env]\n`
            : 'services:\n  web:\n    image: nginx\n    label_file: [e1.env]\n',
        'e1.env': kind === 'env_file' ? `B0=\${A}\n${doublings(1, 3)}\n` : `B0=${seedText}\n${doublings(1, 3)}\n`,
        'e2.env': continuation,
      });
      const second = (kind: 'env_file' | 'label_file'): Record<string, string> => ({
        'list replaced with !override': `services:\n  web:\n    ${kind}: !override [e2.env]\n`,
        'list reset with !reset': `services:\n  web:\n    ${kind}: !reset []\n`,
        'service replaced with !override': `services:\n  web: !override\n    image: nginx\n    ${kind}: [e2.env]\n`,
        'service removed with !reset': 'services:\n  web: !reset null\n  other:\n    image: nginx\n',
        'services section replaced with !override': `services: !override\n  web:\n    image: nginx\n    ${kind}: [e2.env]\n`,
      });

      describe.each(['env_file', 'label_file'] as const)('%s', (kind) => {
        it.each(Object.keys(second(kind)))('accepts a second -f file with the %s: nothing continues the first chain', async (name) => {
          await write('b.yaml', second(kind)[name]);
          for (const [file, content] of Object.entries(seeded(kind))) await write(file, content);
          await expect(run(dir, ['compose', '-f', 'a.yaml', '-f', 'b.yaml', 'config'])).resolves.toBeUndefined();
        });

        it('accepts a later document of the stream that resets the list', async () => {
          for (const [file, content] of Object.entries(seeded(kind))) await write(file, content);
          await write('a.yaml', `${seeded(kind)['a.yaml']}---\nservices:\n  web:\n    ${kind}: !reset [e2.env]\n`);
          await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).resolves.toBeUndefined();
        });

        it('accepts an extending service that replaces the list it would inherit', async () => {
          const base = seeded(kind)['a.yaml'].replace('web:', 'base:');
          await write('a.yaml', `${base}  web:\n    extends: base\n    ${kind}: !override [e2.env]\n`);
          await write('e1.env', seeded(kind)['e1.env']);
          await write('e2.env', continuation);
          await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).resolves.toBeUndefined();
        });

        it('still refuses when the replacing list names the whole chain', async () => {
          for (const [file, content] of Object.entries(seeded(kind))) await write(file, content);
          await write('b.yaml', `services:\n  web:\n    ${kind}: !override [e1.env, e2.env]\n`);
          await expect(run(dir, ['compose', '-f', 'a.yaml', '-f', 'b.yaml', 'config'])).rejects.toThrow(/too long, or interpolates into more text/);
        });
      });

      it('applies an environment that a later file replaces: the files read the new one', async () => {
        for (const [file, content] of Object.entries(seeded('env_file'))) await write(file, content);
        await write('b.yaml', 'services:\n  web:\n    environment: !override\n      Z: "1"\n    env_file: [e2.env]\n');
        await expect(run(dir, ['compose', '-f', 'a.yaml', '-f', 'b.yaml', 'config'])).resolves.toBeUndefined();
        await write('b.yaml', `services:\n  web:\n    environment: !override\n      A: ${seedText}\n    env_file: [e2.env]\n`);
        await expect(run(dir, ['compose', '-f', 'a.yaml', '-f', 'b.yaml', 'config'])).rejects.toThrow(/too long, or interpolates into more text/);
      });
    });

    describe('what a tag inside an included project replaces stays inside it', () => {
      const seededA = `services:\n  web:\n    image: nginx\n    environment:\n      A: ${seedText}\n    env_file: [e1.env]\n`;
      const writeBase = async (): Promise<void> => {
        await write('a.yaml', seededA);
        await write('e1.env', `B0=\${A}\n${doublings(1, 3)}\n`);
        await write('e2.env', continuation);
      };
      const run2 = (): Promise<void> => run(dir, ['compose', '-f', 'a.yaml', '-f', 'b.yaml', 'config']);

      it.each([
        ['a service replaced with !override', 'services:\n  web: !override\n    image: nginx\n    env_file: [e2.env]\n'],
        ['a list replaced with !override', 'services:\n  web:\n    env_file: !override [e2.env]\n'],
      ])('keeps the chain of an earlier -f file when an included file has %s', async (_name, included) => {
        await writeBase();
        await write('b.yaml', 'include:\n  - c.yaml\n');
        await write('c.yaml', included);
        await expect(run2()).rejects.toThrow(/too long, or interpolates into more text/);
      });

      it('keeps the chain of an earlier -f file when an included file replaces its whole services section', async () => {
        await writeBase();
        await write('b.yaml', 'include:\n  - c.yaml\nservices:\n  web:\n    env_file: [e2.env]\n');
        await write('c.yaml', 'services: !override\n  other:\n    image: nginx\n');
        await expect(run2()).rejects.toThrow(/too long, or interpolates into more text/);
      });

      it('still applies a tag between the files of one include, which Compose merges as one project', async () => {
        await writeBase();
        await write('b.yaml', 'include:\n  - path: [a.yaml, c.yaml]\n');
        await write('c.yaml', 'services:\n  web:\n    env_file: !override [e2.env]\n');
        await expect(run(dir, ['compose', '-f', 'b.yaml', 'config'])).resolves.toBeUndefined();
        await write('c.yaml', 'services:\n  web:\n    env_file: [e2.env]\n');
        await expect(run(dir, ['compose', '-f', 'b.yaml', 'config'])).rejects.toThrow(/too long, or interpolates into more text/);
      });

      it('still refuses the including file’s chain when an included service holds only a short one', async () => {
        // The include reads a benign list; the including file's own service holds the long chain.
        await write('ok.env', 'Z=1\n');
        await write('inc.yaml', 'services:\n  other:\n    image: nginx\n    env_file: [ok.env]\n');
        await write('e1.env', `B0=\${A}\n${doublings(1, 3)}\n`);
        await write('e2.env', continuation);
        await write(
          'a.yaml',
          `include:\n  - inc.yaml\nservices:\n  web:\n    image: nginx\n    environment:\n      A: ${seedText}\n    env_file: [e1.env, e2.env]\n`,
        );
        await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).rejects.toThrow(/too long, or interpolates into more text/);
      });

      it('reads an included service once, however many files it passes through', async () => {
        // Just over half the reference limit: under it when read once, over it when read twice.
        const mentions = Array.from({ length: Math.floor(MAX_COMPOSE_DEPENDENCY_REFERENCES / 2) + 52 }, () => 'x.env').join(', ');
        await write('x.env', 'A=1\n');
        await write('sub/inc.yaml', `services:\n  web:\n    image: nginx\n    label_file: [${mentions.replaceAll('x.env', '../x.env')}]\n`);
        await write('a.yaml', 'include:\n  - sub/inc.yaml\n');
        await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).resolves.toBeUndefined();
        await write('mid.yaml', 'include:\n  - sub/inc.yaml\n');
        await write('a.yaml', 'include:\n  - mid.yaml\n');
        await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).resolves.toBeUndefined();
      });
    });

    describe('an extending service keeps its own tags and not its parent', () => {
      const writeFiles = async (kind: 'env_file' | 'label_file', extending: string, parentList = '[e0.env]'): Promise<void> => {
        const seed = kind === 'env_file' ? `    environment:\n      A: ${seedText}\n` : '';
        await write('a.yaml', `services:\n  web:\n    image: nginx\n${seed}    ${kind}: [e1.env]\n`);
        await write('b.yaml', `services:\n  base:\n    image: nginx\n    ${kind}: ${parentList}\n  web:\n    extends: base\n${extending}`);
        await write('e0.env', 'Z=1\n');
        await write('e1.env', kind === 'env_file' ? `B0=\${A}\n${doublings(1, 3)}\n` : `B0=${seedText}\n${doublings(1, 3)}\n`);
        await write('e2.env', continuation);
      };
      const run2 = (): Promise<void> => run(dir, ['compose', '-f', 'a.yaml', '-f', 'b.yaml', 'config']);

      describe.each(['env_file', 'label_file'] as const)('%s', (kind) => {
        it('accepts an extending service whose own list replaces the earlier file’s chain', async () => {
          await writeFiles(kind, `    ${kind}: !override [e2.env]\n`);
          await expect(run2()).resolves.toBeUndefined();
        });

        it('refuses when only the parent carries the tag: it does not reach the other file', async () => {
          await writeFiles(kind, `    ${kind}: [e2.env]\n`, '!override [e0.env]');
          await expect(run2()).rejects.toThrow(/too long, or interpolates into more text/);
        });

        it('refuses an extending service that adds to the earlier file’s chain', async () => {
          await writeFiles(kind, `    ${kind}: [e2.env]\n`);
          await expect(run2()).rejects.toThrow(/too long, or interpolates into more text/);
        });
      });
    });

    it('keeps a file of the same name apart for one service whose parent is in another directory', async () => {
      // `sub/e.env` and `e.env` are two files, so the service reads the seed and then the continuation.
      await write('sub/base.yaml', `services:\n  base:\n    image: nginx\n    environment:\n      A: ${seedText}\n    env_file: [e.env]\n`);
      await write('sub/e.env', `B0=\${A}\n${doublings(1, 3)}\n`);
      await write('e.env', continuation);
      await write('a.yaml', 'services:\n  web:\n    extends:\n      file: sub/base.yaml\n      service: base\n    env_file: [e.env]\n');
      await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).rejects.toThrow(/too long, or interpolates into more text/);
    });

    it('reads the env_file of an included file from the included file’s directory', async () => {
      await write('sub/b.yaml', `services:\n  web:\n    image: nginx\n    environment:\n      A: ${seedText}\n    env_file: [e.env]\n`);
      await write('sub/e.env', `B0=\${A}\n${doublings(1, 4)}\n`);
      await write('a.yaml', 'include:\n  - sub/b.yaml\n');
      await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).rejects.toThrow(/too long, or interpolates into more text/);
    });

    it('refuses an environment value read differently from Compose when it is in a later definition', async () => {
      await write('a.yaml', 'services:\n  web:\n    image: nginx\n    env_file: [e1.env]\n');
      await write('b.yaml', 'services:\n  web:\n    environment:\n      A: "a\u2028          b"\n');
      await write('e1.env', 'B=${A}\n');
      await expect(run(dir, ['compose', '-f', 'a.yaml', '-f', 'b.yaml', 'config'])).rejects.toThrow(/U\+2028 or U\+2029/);
      // The first file's misread value is overridden by the later one, which the files read instead.
      await write('a.yaml', 'services:\n  web:\n    image: nginx\n    environment:\n      A: "a\u2028          b"\n    env_file: [e1.env]\n');
      await write('b.yaml', 'services:\n  web:\n    environment: !override\n      A: fine\n');
      await expect(run(dir, ['compose', '-f', 'a.yaml', '-f', 'b.yaml', 'config'])).resolves.toBeUndefined();
    });

    it('measures a job that extends a job of another file', async () => {
      await write('base.yaml', `jobs:\n  base:\n    environment:\n      A: ${seedText}\n    env_file: [e1.env]\n`);
      await write('a.yaml', 'jobs:\n  nightly:\n    extends:\n      file: base.yaml\n      service: base\n    env_file: [e2.env]\n');
      await write('e1.env', `B0=\${A}\n${doublings(1, 3)}\n`);
      await write('e2.env', continuation);
      await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).rejects.toThrow(/too long, or interpolates into more text/);
    });

    it('does not combine a service and a job of one name', async () => {
      await write('a.yaml', `services:\n  work:\n    image: nginx\n    environment:\n      A: ${seedText}\n    env_file: [e1.env]\n`);
      await write('b.yaml', 'jobs:\n  work:\n    env_file: [e2.env]\n');
      await write('e1.env', `B0=\${A}\n${doublings(1, 3)}\n`);
      await write('e2.env', continuation);
      await expect(run(dir, ['compose', '-f', 'a.yaml', '-f', 'b.yaml', 'config'])).resolves.toBeUndefined();
    });

    it('still refuses a chain held by a file that is part of an include cycle', async () => {
      await write('a.yaml', `include:\n  - b.yaml\nservices:\n  web:\n    image: nginx\n    environment:\n      A: ${seedText}\n    env_file: [e1.env, e2.env]\n`);
      await write('b.yaml', 'include:\n  - a.yaml\nservices:\n  other:\n    image: nginx\n    env_file: [e2.env]\n');
      await write('e1.env', `B0=\${A}\n${doublings(1, 3)}\n`);
      await write('e2.env', continuation);
      await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).rejects.toThrow(/too long, or interpolates into more text/);
    });

    it('does not combine services that have different names', async () => {
      await write('a.yaml', `services:\n  web:\n    image: nginx\n    environment:\n      A: ${seedText}\n    env_file: [e1.env]\n`);
      await write('b.yaml', 'services:\n  worker:\n    image: nginx\n    env_file: [e2.env]\n');
      await write('e1.env', `B0=\${A}\n${doublings(1, 3)}\n`);
      await write('e2.env', continuation);
      await expect(run(dir, ['compose', '-f', 'a.yaml', '-f', 'b.yaml', 'config'])).resolves.toBeUndefined();
    });

    it('reads a service of an extended file only through the service that extends it', async () => {
      // Compose loads one service of the extended file, so its other services read nothing.
      await write('a.yaml', 'services:\n  web:\n    extends:\n      file: base.yaml\n      service: base\n');
      await write('base.yaml', `services:\n  base:\n    image: nginx\n  other:\n    image: nginx\n    environment:\n      A: ${seedText}\n    env_file: [e1.env, e2.env]\n`);
      await write('e1.env', `B0=\${A}\n${doublings(1, 3)}\n`);
      await write('e2.env', continuation);
      await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).resolves.toBeUndefined();
    });

    it('applies the chain a job builds through extends the way a service is', async () => {
      await write(
        'a.yaml',
        `jobs:\n  base:\n    environment:\n      A: ${seedText}\n    env_file: [e1.env]\n  nightly:\n    extends: base\n    env_file: [e2.env]\n`,
      );
      await write('e1.env', `B0=\${A}\n${doublings(1, 3)}\n`);
      await write('e2.env', continuation);
      await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).rejects.toThrow(/too long, or interpolates into more text/);
    });

    it('refuses an environment value read differently from Compose when env files are read', async () => {
      // A U+2028 inside the value splits the scalar differently for Compose, whose env files would
      // then be seeded with text this reader cannot reproduce, wherever the env_file is declared.
      await write('a.yaml', 'services:\n  web:\n    image: nginx\n    environment:\n      A: "a\u2028          b"\n');
      await write('b.yaml', 'services:\n  web:\n    env_file: [e1.env]\n');
      await write('e1.env', 'B=${A}\n');
      await expect(run(dir, ['compose', '-f', 'a.yaml', '-f', 'b.yaml', 'config'])).rejects.toThrow(/U\+2028 or U\+2029/);
      // With no env file anywhere, the value is never interpolated.
      await write('b.yaml', 'services:\n  web:\n    image: nginx\n');
      await expect(run(dir, ['compose', '-f', 'a.yaml', '-f', 'b.yaml', 'config'])).resolves.toBeUndefined();
    });

    // Each shape in the groups below that seed a chain was rendered with Compose
    // 5.7.0 (the format groups use 21 doublings of a short line instead; the job
    // test pins a conservative refusal, since Compose 5.7.0 rejects `jobs:`): the
    // first file builds 640 KB and the continuation doubles it to 1.28 MB, where the
    // guard had accepted it or refused a project Compose accepts.
    const TOO_LONG = /too long, or interpolates into more text/;
    const A_B = ['compose', '-f', 'a.yaml', '-f', 'b.yaml', 'config'];
    /** The seed's first chain file: `SEED` is what `B0` copies, then three doublings. */
    const seedChain = `B0=\${SEED}\n${doublings(1, 3)}\n`;
    const webWith = (environment: string, files = 'e1.env'): string =>
      `services:\n  web:\n    image: nginx\n    environment:\n${environment}    env_file: [${files}]\n`;
    const more = (list = 'e2.env'): string => `services:\n  web:\n    env_file: [${list}]\n`;

    describe('a list-form environment entry is interpolated as a whole, then split at its first =', () => {
      beforeEach(async () => {
        await write('.env', 'KEY=SEED\n');
        await write('e1.env', seedChain);
        await write('e2.env', continuation);
      });

      it.each([
        ['a name from a variable', `      - "\${KEY}=${seedText}"\n`],
        ['a name from a variable, quoted with single quotes', `      - '\${KEY}=${seedText}'\n`],
        ['a name from a default', `      - "\${MISSING:-SEED}=${seedText}"\n`],
      ])('refuses a chain seeded through %s, continued by a later file', async (_name, entry) => {
        await write('a.yaml', webWith(entry));
        await write('b.yaml', more());
        await expect(run(dir, A_B)).rejects.toThrow(TOO_LONG);
      });

      it('refuses a chain seeded by a variable that holds the whole entry', async () => {
        await write('.env', `ENTRY=SEED=${seedText}\n`);
        await write('a.yaml', webWith('      - ${ENTRY}\n', 'e1.env, e2.env'));
        await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).rejects.toThrow(TOO_LONG);
      });

      it('refuses the same seed through a service that extends the one holding it', async () => {
        await write(
          'a.yaml',
          `services:\n  base:\n    image: nginx\n    environment:\n      - "\${KEY}=${seedText}"\n  web:\n    extends: base\n    env_file: [e1.env, e2.env]\n`,
        );
        await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).rejects.toThrow(TOO_LONG);
      });

      it('refuses the same seed on a job, which shares the reader', async () => {
        await write('a.yaml', `jobs:\n  nightly:\n    environment:\n      - "\${KEY}=${seedText}"\n    env_file: [e1.env, e2.env]\n`);
        await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).rejects.toThrow(TOO_LONG);
      });

      it('accepts the same entries when the value they build is short', async () => {
        await write('a.yaml', webWith('      - "${KEY}=ab"\n', 'e1.env, e2.env'));
        await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).resolves.toBeUndefined();
        await write('.env', 'ENTRY=SEED=ab\n');
        await write('a.yaml', webWith('      - ${ENTRY}\n', 'e1.env, e2.env'));
        await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).resolves.toBeUndefined();
      });

      it('applies a later list entry whose interpolated name replaces the earlier seed', async () => {
        await write('a.yaml', webWith(`      SEED: ${seedText}\n`, 'e1.env, e2.env'));
        await write('b.yaml', 'services:\n  web:\n    environment:\n      - "${KEY}=small"\n');
        await expect(run(dir, A_B)).resolves.toBeUndefined();
      });
    });

    describe('what a definition interpolates when Compose loads it uses the environment it was loaded under', () => {
      const included = (environment: string, files: string): string => `services:\n  web:\n    image: nginx\n${environment}    env_file: [${files}]\n`;

      beforeEach(async () => {
        await write('a.yaml', 'include:\n  - sub/inc.yaml\n');
        await write('b.yaml', more());
        await write('e2.env', continuation);
      });

      it('refuses an environment value an included project interpolates from its own .env, when a later file continues the chain', async () => {
        await write('sub/.env', `FROM=${seedText}\n`);
        await write('sub/inc.yaml', included('    environment:\n      SEED: ${FROM}\n', 'ok.env'));
        await write('sub/ok.env', 'Z=1\n');
        await write('b.yaml', more('e1.env, e2.env'));
        await write('e1.env', seedChain);
        await expect(run(dir, A_B)).rejects.toThrow(TOO_LONG);
        // The same shape with a value that stays small is accepted.
        await write('sub/.env', 'FROM=ab\n');
        await expect(run(dir, A_B)).resolves.toBeUndefined();
      });

      it('refuses a list entry an included project interpolates from its own .env', async () => {
        await write('sub/.env', `KEY=SEED\nVALUE=${seedText}\n`);
        await write('sub/inc.yaml', included('    environment:\n      - "${KEY}=${VALUE}"\n', 'ok.env'));
        await write('sub/ok.env', 'Z=1\n');
        await write('b.yaml', more('e1.env, e2.env'));
        await write('e1.env', seedChain);
        await expect(run(dir, A_B)).rejects.toThrow(TOO_LONG);
      });

      it('reads the env_file and label_file paths of an included project with its own environment', async () => {
        await write('sub/.env', 'DIRN=real\n');
        await write('sub/real/e1.env', `B0=${seedText}\n${doublings(1, 3)}\n`);
        await write('sub/inc.yaml', 'services:\n  web:\n    image: nginx\n    label_file: ["${DIRN}/e1.env"]\n');
        await write('b.yaml', 'services:\n  web:\n    label_file: [e2.env]\n');
        await expect(run(dir, A_B)).rejects.toThrow(TOO_LONG);
        await write('sub/.env', `FROM=${seedText}\nDIRN=real\n`);
        await write('sub/real/e1.env', seedChain);
        await write('sub/inc.yaml', included('    environment:\n      SEED: ${FROM}\n', '"${DIRN}/e1.env"'));
        await write('b.yaml', more());
        await expect(run(dir, A_B)).rejects.toThrow(TOO_LONG);
      });

      it('reads the format of an included project with its own environment', async () => {
        const lines = 'A=1\n' + Array.from({ length: 21 }, () => 'A=${A}${A}').join('\n') + '\n';
        await write('sub/e.env', lines);
        await write('sub/inc.yaml', 'services:\n  web:\n    image: nginx\n    env_file:\n      - path: e.env\n        format: ${FMT}\n');
        await write('sub/.env', 'FMT=raw\n');
        await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).resolves.toBeUndefined();
        await write('sub/.env', 'FMT=other\n');
        await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).rejects.toThrow(TOO_LONG);
      });

      it('reads the format of an included label_file with its own environment', async () => {
        const lines = 'A=1\n' + Array.from({ length: 21 }, () => 'A=${A}${A}').join('\n') + '\n';
        await write('sub/e.env', lines);
        await write('sub/inc.yaml', 'services:\n  web:\n    image: nginx\n    label_file:\n      - path: e.env\n        format: ${FMT}\n');
        await write('sub/.env', 'FMT=raw\n');
        await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).resolves.toBeUndefined();
        await write('sub/.env', 'FMT=other\n');
        await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).rejects.toThrow(TOO_LONG);
      });

      it('reads the text of an env file with the run’s environment, not the included project’s', async () => {
        // `SEED=${FROM}` is empty for Compose, which does not hand the included .env to env file text.
        await write('sub/.env', `FROM=${seedText}\n`);
        await write('sub/e1.env', `SEED=\${FROM}\nB0=\${SEED}\n${doublings(1, 4)}\n`);
        await write('sub/inc.yaml', included('', 'e1.env'));
        await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).resolves.toBeUndefined();
        await expect(run(dir, A_B)).resolves.toBeUndefined();
        // The run’s own environment does reach it.
        await write('.env', `FROM=${seedText}\n`);
        await expect(run(dir, A_B)).rejects.toThrow(TOO_LONG);
      });
    });

    describe('a later file can drop the chain an included project holds', () => {
      const seeded = (kind: 'env_file' | 'label_file'): Record<string, string> =>
        kind === 'env_file'
          ? { 'inc.yaml': webWith(`      A: ${seedText}\n`, 'e1.env, e2.env'), 'e1.env': `B0=\${A}\n${doublings(1, 3)}\n`, 'e2.env': continuation }
          : {
              'inc.yaml': 'services:\n  web:\n    image: nginx\n    label_file: [e1.env, e2.env]\n',
              'e1.env': `B0=${seedText}\n${doublings(1, 3)}\n`,
              'e2.env': continuation,
            };
      const later = (kind: 'env_file' | 'label_file'): Record<string, string> => ({
        'list reset with !reset': `services:\n  web:\n    ${kind}: !reset []\n`,
        'list replaced with !override': `services:\n  web:\n    ${kind}: !override [ok.env]\n`,
        'service replaced with !override': `services:\n  web: !override\n    image: nginx\n`,
        'service removed with !reset': 'services:\n  web: !reset null\n  other:\n    image: nginx\n',
        'services section replaced with !override': 'services: !override\n  other:\n    image: nginx\n',
      });

      describe.each(['env_file', 'label_file'] as const)('%s', (kind) => {
        beforeEach(async () => {
          for (const [file, content] of Object.entries(seeded(kind))) await write(file, content);
          await write('ok.env', 'Z=1\n');
          await write('a.yaml', 'include:\n  - inc.yaml\n');
        });

        it('still refuses the chain when nothing drops it', async () => {
          await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).rejects.toThrow(TOO_LONG);
        });

        it.each(Object.keys(later('env_file')))('accepts it when a later -f file has the %s', async (name) => {
          await write('b.yaml', later(kind)[name]);
          await expect(run(dir, A_B)).resolves.toBeUndefined();
        });

        it('accepts it when a later document of the including file resets the list', async () => {
          await write('a.yaml', `include:\n  - inc.yaml\n---\nservices:\n  web:\n    ${kind}: !reset []\n`);
          await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).resolves.toBeUndefined();
        });

        it('still refuses it when the file that resets comes before the file that includes it', async () => {
          await write('b.yaml', later(kind)['list reset with !reset']);
          await expect(run(dir, ['compose', '-f', 'b.yaml', '-f', 'a.yaml', 'config'])).rejects.toThrow(TOO_LONG);
          await write('b.yaml', later(kind)['service replaced with !override']);
          await expect(run(dir, ['compose', '-f', 'b.yaml', '-f', 'a.yaml', 'config'])).rejects.toThrow(TOO_LONG);
        });

        it('accepts it through an include of an include, dropped by the outermost run', async () => {
          await write('mid.yaml', 'include:\n  - inc.yaml\n');
          await write('a.yaml', 'include:\n  - mid.yaml\n');
          await write('b.yaml', later(kind)['list reset with !reset']);
          await expect(run(dir, A_B)).resolves.toBeUndefined();
          await write('b.yaml', more('ok.env'));
          await expect(run(dir, A_B)).rejects.toThrow(TOO_LONG);
        });
      });
    });

    it('accepts an included seed that a later file replaces with an !override of the whole environment', async () => {
      await write('inc.yaml', webWith(`      A: ${seedText}\n`, 'e1.env, e2.env'));
      await write('e1.env', `B0=\${A}\n${doublings(1, 3)}\n`);
      await write('e2.env', continuation);
      await write('a.yaml', 'include:\n  - inc.yaml\n');
      await write('b.yaml', 'services:\n  web:\n    environment: !override\n      Z: "1"\n');
      await expect(run(dir, A_B)).resolves.toBeUndefined();
      await write('b.yaml', 'services:\n  web:\n    environment:\n      Z: "1"\n');
      await expect(run(dir, A_B)).rejects.toThrow(TOO_LONG);
    });

    it('interpolates the environment of a service another file extends with the environment that file was loaded under', async () => {
      await write('sub/.env', `FROM=${seedText}\n`);
      await write('a.yaml', 'include:\n  - sub/inc.yaml\n');
      await write('sub/inc.yaml', 'services:\n  web:\n    extends:\n      file: base.yaml\n      service: base\n');
      await write('sub/base.yaml', webWith('      SEED: ${FROM}\n', 'e1.env').replace('  web:', '  base:'));
      await write('sub/e1.env', `${seedChain}${continuation}`);
      await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).rejects.toThrow(TOO_LONG);
      await write('sub/.env', 'FROM=ab\n');
      await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).resolves.toBeUndefined();
    });

    describe('a later null or bare name takes the earlier seed out, as Compose does', () => {
      const seeded = webWith(`      A: ${seedText}\n`, 'e1.env, e2.env');
      beforeEach(async () => {
        await write('e1.env', `B0=\${A}\n${doublings(1, 3)}\n`);
        await write('e2.env', continuation);
        await write('a.yaml', seeded);
      });
      const second = (environment: string): string => `services:\n  web:\n    environment:${environment}\n`;

      it('refuses the chain when nothing takes the seed out', async () => {
        await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).rejects.toThrow(TOO_LONG);
      });

      it.each([
        ['a null value', '\n      A: null'],
        ['a ~ value', '\n      A: ~'],
        ['an empty value', '\n      A:'],
        ['a !!null value', '\n      A: !!null ""'],
        ['a key with no value node', ' {A}'],
        ['a bare name', ' [A]'],
        ['a bare name in a block list', '\n      - A'],
        ['a bare name an interpolation spells', ' ["${MISSING:-A}"]'],
      ])('accepts it when a later -f file gives %s', async (_name, environment) => {
        await write('b.yaml', second(environment));
        await expect(run(dir, A_B)).resolves.toBeUndefined();
      });

      it('accepts it when a later document of the same file, or an extending service, takes the seed out', async () => {
        await write('a.yaml', `${seeded}---\n${second(' [A]')}`);
        await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).resolves.toBeUndefined();
        await write(
          'a.yaml',
          `services:\n  base:\n    image: nginx\n    environment:\n      A: ${seedText}\n  web:\n    extends: base\n    environment:\n      A: null\n    env_file: [e1.env, e2.env]\n`,
        );
        await expect(run(dir, ['compose', '-f', 'a.yaml', 'config'])).resolves.toBeUndefined();
      });

      it.each([
        ['null', ' null'],
        ['~', ' ~'],
        ['an empty value', ''],
        ['a !!merge value', '\n      A: !!merge ""'],
      ])('still refuses it when a later file gives only %s, which Compose keeps the seed for', async (_name, environment) => {
        await write('b.yaml', second(environment));
        await expect(run(dir, A_B)).rejects.toThrow(TOO_LONG);
      });

      it.each([
        ['a bare name', '      - !reset A'],
        ['a bare name in a flow list', null],
        ['a bare name an interpolation spells', '      - !reset ${K}'],
        ['an assignment', '      - !reset A=small'],
      ])('refuses it when a later list entry is tagged !reset, which Compose removes: %s', async (_name, entry) => {
        await write('.env', 'K=A\n');
        await write('b.yaml', entry === null ? second(' [!reset A]') : second(`\n${entry}`));
        await expect(run(dir, A_B)).rejects.toThrow(TOO_LONG);
      });

      it.each([
        ['a list entry tagged !override', '\n      - !override A'],
        ['a list entry tagged !!str', '\n      - !!str A'],
        ['a map entry tagged !reset', '\n      A: !reset null'],
      ])('accepts it when a later file gives %s, which Compose applies as written', async (_name, environment) => {
        await write('b.yaml', second(environment));
        await expect(run(dir, A_B)).resolves.toBeUndefined();
      });

      it.each([
        ['a map entry', '\n      A: ""'],
        ['a list entry', '\n      - A='],
      ])('accepts it when a later file gives %s an empty value, which replaces the seed', async (_name, environment) => {
        await write('b.yaml', second(environment));
        await expect(run(dir, A_B)).resolves.toBeUndefined();
      });

      it('refuses it again when a later file gives the seed back after it was taken out', async () => {
        await write('b.yaml', second(' [A]'));
        await write('c.yaml', second(`\n      A: ${seedText}`));
        await expect(run(dir, [...A_B.slice(0, 5), '-f', 'c.yaml', 'config'])).rejects.toThrow(TOO_LONG);
      });
    });

    describe('a format is interpolated before it is compared with raw', () => {
      const lines = 'A=1\n' + Array.from({ length: 21 }, () => 'A=${A}${A}').join('\n') + '\n';
      const asFormat = (kind: 'env_file' | 'label_file', format: string): string =>
        `services:\n  web:\n    image: nginx\n    ${kind}:\n      - path: e.env\n        format: ${format}\n`;

      describe.each(['env_file', 'label_file'] as const)('%s', (kind) => {
        beforeEach(async () => {
          await write('e.env', lines);
        });

        it.each(['${FMT}', '"${FMT}"'])('reads a file raw when %s names raw', async (format) => {
          await write('.env', 'FMT=raw\n');
          await write('compose.yaml', asFormat(kind, format));
          await expect(run()).resolves.toBeUndefined();
        });

        it('reads a file raw when the default of the format names raw', async () => {
          await write('.env', 'X=1\n');
          await write('compose.yaml', asFormat(kind, '${FMT:-raw}'));
          await expect(run()).resolves.toBeUndefined();
        });

        it('still refuses when the interpolated format is not raw, or names nothing', async () => {
          await write('.env', 'FMT=other\n');
          await write('compose.yaml', asFormat(kind, '${FMT}'));
          await expect(run()).rejects.toThrow(TOO_LONG);
          await write('.env', 'X=1\n');
          await expect(run()).rejects.toThrow(TOO_LONG);
        });

        it('still reads a literal raw format literally', async () => {
          await write('compose.yaml', asFormat(kind, 'raw'));
          await expect(run()).resolves.toBeUndefined();
        });
      });
    });
  });
});
