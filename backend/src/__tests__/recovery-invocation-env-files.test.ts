/**
 * The env files a stored recovery invocation reads for interpolation. Recovery
 * replays the captured prefix, so this derivation has to follow Compose's own
 * precedence rather than the live project selection: an explicit --env-file,
 * else the recorded COMPOSE_FILE interpolation list, else COMPOSE_ENV_FILES,
 * else the project `.env`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'path';
import { recoveryInvocationEnvFiles } from '../services/rollbackInventory';
import type { RollbackInvocationRecord } from '../types/rollbackGeneration';

const STACK_ROOT = path.resolve('/compose/app');

function invocation(over: Partial<RollbackInvocationRecord> = {}): RollbackInvocationRecord {
  return {
    composeArgsPrefix: [],
    projectDirectory: null,
    projectName: 'app',
    explicitComposeFiles: ['compose.yaml'],
    composeLayers: ['compose.yaml'],
    ...over,
  };
}

describe('recoveryInvocationEnvFiles', () => {
  let envFiles: string | undefined;
  let disabled: string | undefined;

  beforeEach(() => {
    envFiles = process.env.COMPOSE_ENV_FILES;
    disabled = process.env.COMPOSE_DISABLE_ENV_FILE;
    delete process.env.COMPOSE_ENV_FILES;
    delete process.env.COMPOSE_DISABLE_ENV_FILE;
  });

  afterEach(() => {
    if (envFiles === undefined) delete process.env.COMPOSE_ENV_FILES;
    else process.env.COMPOSE_ENV_FILES = envFiles;
    if (disabled === undefined) delete process.env.COMPOSE_DISABLE_ENV_FILE;
    else process.env.COMPOSE_DISABLE_ENV_FILE = disabled;
  });

  it('reads the captured --env-file flags in order and nothing the live settings select', () => {
    process.env.COMPOSE_ENV_FILES = 'listed.env';

    const files = recoveryInvocationEnvFiles(invocation({
      composeArgsPrefix: [
        '-f', 'compose.yaml',
        '--env-file', path.join(STACK_ROOT, 'first.env'),
        '--env-file', path.join(STACK_ROOT, 'second.env'),
      ],
      composeLayers: ['compose.yaml'],
      interpolationEnvFiles: ['recorded.env'],
    }), STACK_ROOT);

    expect(files).toEqual([
      { absolutePath: path.join(STACK_ROOT, 'first.env'), fromProcessEnv: false },
      { absolutePath: path.join(STACK_ROOT, 'second.env'), fromProcessEnv: false },
    ]);
  });

  it('replays the recorded COMPOSE_FILE interpolation list when the prefix names no env file', () => {
    process.env.COMPOSE_ENV_FILES = 'listed.env';

    const files = recoveryInvocationEnvFiles(invocation({
      interpolationEnvFiles: ['sub/.env', '.env'],
    }), STACK_ROOT);

    expect(files).toEqual([
      { absolutePath: path.join(STACK_ROOT, 'sub', '.env'), fromProcessEnv: false },
      { absolutePath: path.join(STACK_ROOT, '.env'), fromProcessEnv: false },
    ]);
  });

  it('reads nothing for an empty recorded list, whatever the live settings select', () => {
    process.env.COMPOSE_ENV_FILES = 'listed.env';

    // The capture found no default env file and replays an empty env input,
    // which replaces the process list and a project `.env` created since.
    expect(recoveryInvocationEnvFiles(invocation({
      interpolationEnvFiles: [],
    }), STACK_ROOT)).toEqual([]);
  });

  it('falls back to the process list, resolved against the recovery working directory', () => {
    process.env.COMPOSE_ENV_FILES = 'one.env,,/abs/two.env';

    const files = recoveryInvocationEnvFiles(invocation(), STACK_ROOT);

    expect(files).toEqual([
      { absolutePath: path.join(STACK_ROOT, 'one.env'), fromProcessEnv: true },
      { absolutePath: path.resolve('/abs/two.env'), fromProcessEnv: true },
    ]);
  });

  it('reads no env file when COMPOSE_DISABLE_ENV_FILE is true and nothing else selected one', () => {
    process.env.COMPOSE_DISABLE_ENV_FILE = 'TRUE';

    expect(recoveryInvocationEnvFiles(invocation(), STACK_ROOT)).toEqual([]);
  });

  it('reads the project .env when nothing selected a file', () => {
    expect(recoveryInvocationEnvFiles(invocation(), STACK_ROOT)).toEqual([
      { absolutePath: path.join(STACK_ROOT, '.env'), fromProcessEnv: false },
    ]);
  });

  it('reads the project .env of a selected project directory', () => {
    const fromFlag = recoveryInvocationEnvFiles(invocation({
      composeArgsPrefix: ['--project-directory', 'sub'],
      composeLayers: [],
    }), STACK_ROOT);
    const fromLayer = recoveryInvocationEnvFiles(invocation({
      composeLayers: ['nested/compose.yaml'],
    }), STACK_ROOT);

    expect(fromFlag).toEqual([
      { absolutePath: path.join(STACK_ROOT, 'sub', '.env'), fromProcessEnv: false },
    ]);
    expect(fromLayer).toEqual([
      { absolutePath: path.join(STACK_ROOT, 'nested', '.env'), fromProcessEnv: false },
    ]);
  });

  it('classifies no project env file for a project directory outside the stack', () => {
    const files = recoveryInvocationEnvFiles(invocation({
      composeArgsPrefix: ['--project-directory', '../shared'],
    }), STACK_ROOT);

    expect(files).toEqual([]);
  });
});
