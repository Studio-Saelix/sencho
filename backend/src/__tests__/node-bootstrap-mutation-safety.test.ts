import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { READ_EXIT, WRITE_EXIT, createDirectoryCommand, writeFileCommand } from '../services/nodeBootstrap/executionCommands';
import { StepFailure, TOKEN_PLACEHOLDER, runPlanStep, type StepContext } from '../services/nodeBootstrap/stepRunner';
import { buildPilotEnrollmentCompose } from '../helpers/pilotEnrollmentCompose';
import { DOCKER_KEY_ASC } from './__helpers__/dockerRepoFixtures';
import type { ExecOptions, ExecResult, ExecSession } from '../services/nodeBootstrap/sshExecClient';
import type { BootstrapPlan, BootstrapPlanStep } from '../services/nodeBootstrap/types';

/**
 * Bootstrap mutations must refuse at the moment they change the host, not only
 * when the plan was made: what the checks saw can be replaced before the write.
 * These run the real scripts on a real shell and filesystem, and put the
 * replacement exactly between the check and the mutation by holding the
 * script's standard input open until the host has been changed under it.
 */

const owner = os.userInfo().username;
const group = execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim();
const sha256 = (content: string | Buffer) => crypto.createHash('sha256').update(content).digest('hex');
const file = { mode: '0600', owner, group };

function runShell(command: string, stdin = '', env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('sh', ['-c', `LC_ALL=C ${command}`], { input: stdin, encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const REAL_STAT = execFileSync('sh', ['-c', 'command -v stat'], { encoding: 'utf8' }).trim();
const REAL_SHA256SUM = execFileSync('sh', ['-c', 'command -v sha256sum'], { encoding: 'utf8' }).trim();

/**
 * A directory of command shims that sit first on PATH. The `stat` shim runs the
 * real one and then, right after its first call, runs `action`: that is the
 * moment between the script inspecting a directory name and entering it, which
 * no test can otherwise reach. The `sha256sum` shim pauses on a moved-aside file.
 */
function shimDir(base: string, action: string): { path: string; env: NodeJS.ProcessEnv } {
  const dir = path.join(base, 'shims');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'stat'), [
    '#!/bin/sh',
    `count="${dir}/count"`,
    'n=$(cat "$count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$count"',
    `"${REAL_STAT}" "$@"; rc=$?`,
    `if [ "$n" = 1 ]; then ${action}; fi`,
    'exit $rc',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'sha256sum'), [
    '#!/bin/sh',
    'case "$*" in *.old.*) sleep 1 ;; esac',
    `exec "${REAL_SHA256SUM}" "$@"`,
  ].join('\n'), { mode: 0o755 });
  return { path: dir, env: { PATH: `${dir}:${process.env.PATH ?? ''}` } };
}

/**
 * Run a write script, wait until it has passed its checks and is waiting for
 * the content (its temporary file exists in `watch`), run `inject`, then send
 * the content. `watch` holds the temporary file because the script enters its
 * directory by identity, so the name it was given may by then point elsewhere.
 */
async function runRaced(
  command: string,
  stdin: string,
  waitFor: () => boolean,
  inject: () => void,
): Promise<{ status: number | null; stderr: string }> {
  const child = spawn('sh', ['-c', `LC_ALL=C ${command}`]);
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const closed = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  const deadline = Date.now() + 10_000;
  while (!waitFor()) {
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('the script never reached its input');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  inject();
  child.stdin.end(stdin);
  return { status: await closed, stderr };
}

function modeOf(target: string): string {
  return (fs.statSync(target).mode & 0o777).toString(8);
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-bootstrap-race-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const READ_MISSING = READ_EXIT.missing;
const hasTemp = (dir: string, name: string) => () => fs.readdirSync(dir).some((entry) => entry.startsWith(`.${name}.`));

describe('B1: file publication refuses at the moment of the write', () => {
  it('does not overwrite a file created after the absence check', async () => {
    const target = path.join(root, 'compose.yaml');
    const result = await runRaced(
      writeFileCommand(target, { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null }),
      'ours',
      hasTemp(root, 'compose.yaml'),
      () => fs.writeFileSync(target, 'theirs', { mode: 0o644 }),
    );
    expect(result.status).toBe(WRITE_EXIT.exists);
    expect(fs.readFileSync(target, 'utf8')).toBe('theirs');
    expect(modeOf(target)).toBe('644');
    expect(fs.readdirSync(root)).toEqual(['compose.yaml']);
  });

  it('does not write through a symlink created after the absence check', async () => {
    const target = path.join(root, 'compose.yaml');
    const elsewhere = path.join(root, 'elsewhere');
    fs.writeFileSync(elsewhere, 'untouched', { mode: 0o644 });
    const result = await runRaced(
      writeFileCommand(target, { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null }),
      'ours',
      hasTemp(root, 'compose.yaml'),
      () => fs.symlinkSync(elsewhere, target),
    );
    expect(result.status).toBe(WRITE_EXIT.exists);
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe('untouched');
    expect(modeOf(elsewhere)).toBe('644');
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(root).sort()).toEqual(['compose.yaml', 'elsewhere']);
  });

  it('does not replace a directory created at the name after the check', async () => {
    const target = path.join(root, 'compose.yaml');
    const result = await runRaced(
      writeFileCommand(target, { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null }),
      'ours',
      hasTemp(root, 'compose.yaml'),
      () => fs.mkdirSync(target),
    );
    expect(result.status).toBe(WRITE_EXIT.exists);
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  describe('a retry that replaces the file it inspected', () => {
    const inspected = 'old compose with a spent token';

    function arrange(): string {
      const target = path.join(root, 'compose.yaml');
      fs.writeFileSync(target, inspected, { mode: 0o644 });
      return target;
    }
    const command = (target: string) => writeFileCommand(target, { ...file, sha256: sha256('new compose') }, { sudo: false, replaces: sha256(inspected) });

    it('replaces it when it is still that file', async () => {
      const target = arrange();
      const result = await runRaced(command(target), 'new compose', hasTemp(root, 'compose.yaml'), () => undefined);
      expect(result.status).toBe(0);
      expect(fs.readFileSync(target, 'utf8')).toBe('new compose');
      expect(modeOf(target)).toBe('600');
      expect(fs.readdirSync(root)).toEqual(['compose.yaml']);
    });

    it('refuses and keeps the operator file when its content changed after it was read', async () => {
      const target = arrange();
      const result = await runRaced(command(target), 'new compose', hasTemp(root, 'compose.yaml'), () => {
        fs.unlinkSync(target);
        fs.writeFileSync(target, 'operator edit', { mode: 0o640 });
      });
      expect(result.status).toBe(WRITE_EXIT.exists);
      expect(fs.readFileSync(target, 'utf8')).toBe('operator edit');
      expect(modeOf(target)).toBe('640');
      expect(fs.readdirSync(root)).toEqual(['compose.yaml']);
    });

    it('refuses and keeps a symlink put at the name after it was read', async () => {
      const target = arrange();
      const elsewhere = path.join(root, 'elsewhere');
      fs.writeFileSync(elsewhere, 'untouched', { mode: 0o644 });
      const result = await runRaced(command(target), 'new compose', hasTemp(root, 'compose.yaml'), () => {
        fs.unlinkSync(target);
        fs.symlinkSync(elsewhere, target);
      });
      expect(result.status).toBe(WRITE_EXIT.exists);
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(elsewhere, 'utf8')).toBe('untouched');
      expect(fs.readdirSync(root).sort()).toEqual(['compose.yaml', 'elsewhere']);
    });

    it('refuses and keeps a directory put at the name after it was read', async () => {
      const target = arrange();
      const result = await runRaced(command(target), 'new compose', hasTemp(root, 'compose.yaml'), () => {
        fs.unlinkSync(target);
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'theirs'), 'theirs');
      });
      expect(result.status).toBe(WRITE_EXIT.exists);
      expect(fs.readFileSync(path.join(target, 'theirs'), 'utf8')).toBe('theirs');
      expect(fs.readdirSync(root)).toEqual(['compose.yaml']);
    });

    it('writes the new file when the old one was removed before the write', async () => {
      const removed = arrange();
      const gone = await runRaced(command(removed), 'new compose', hasTemp(root, 'compose.yaml'), () => fs.unlinkSync(removed));
      expect(gone.status).toBe(0);
      expect(fs.readFileSync(removed, 'utf8')).toBe('new compose');
    });
  });

  describe('a directory swapped for a symlink after it was inspected', () => {
    it('refuses a directory that is already a symlink, before anything is written', () => {
      const real = path.join(root, 'real');
      fs.mkdirSync(real, { mode: 0o755 });
      const link = path.join(root, 'link');
      fs.symlinkSync(real, link);
      const result = runShell(writeFileCommand(path.join(link, 'compose.yaml'), { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null }), 'ours');
      expect(result.status).toBe(WRITE_EXIT.notDirectory);
      expect(fs.readdirSync(real)).toEqual([]);
    });

    it('writes only into the directory it inspected when the name is swapped meanwhile', async () => {
      const dir = path.join(root, 'agent');
      const decoy = path.join(root, 'decoy');
      fs.mkdirSync(dir, { mode: 0o755 });
      fs.mkdirSync(decoy, { mode: 0o755 });
      const result = await runRaced(
        writeFileCommand(path.join(dir, 'compose.yaml'), { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null }),
        'ours',
        hasTemp(dir, 'compose.yaml'),
        () => {
          fs.renameSync(dir, `${dir}.moved`);
          fs.symlinkSync(decoy, dir);
        },
      );
      expect(result.status).toBe(0);
      expect(fs.readdirSync(decoy)).toEqual([]);
      expect(modeOf(decoy)).toBe('755');
      expect(fs.readFileSync(path.join(`${dir}.moved`, 'compose.yaml'), 'utf8')).toBe('ours');
    });

    it('writes only into the directory it inspected when an ancestor is swapped meanwhile', async () => {
      const parent = path.join(root, 'srv');
      const dir = path.join(parent, 'agent');
      const decoyParent = path.join(root, 'decoy');
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
      fs.mkdirSync(path.join(decoyParent, 'agent'), { recursive: true, mode: 0o755 });
      const result = await runRaced(
        writeFileCommand(path.join(dir, 'compose.yaml'), { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null }),
        'ours',
        hasTemp(dir, 'compose.yaml'),
        () => {
          fs.renameSync(parent, `${parent}.moved`);
          fs.symlinkSync(decoyParent, parent);
        },
      );
      expect(result.status).toBe(0);
      expect(fs.readdirSync(path.join(decoyParent, 'agent'))).toEqual([]);
      expect(fs.readFileSync(path.join(`${parent}.moved`, 'agent', 'compose.yaml'), 'utf8')).toBe('ours');
    });
  });
});

describe('B1: directory creation never changes a directory it did not create', () => {
  const dirSpec = { mode: '0700', owner, group };

  it('creates a missing directory with the planned mode', () => {
    const target = path.join(root, 'agent');
    expect(runShell(createDirectoryCommand(target, dirSpec, { sudo: false, allowExisting: false })).status).toBe(0);
    expect(modeOf(target)).toBe('700');
  });

  it('refuses a symlink at the name and leaves the directory it points to alone', () => {
    const unrelated = path.join(root, 'unrelated');
    fs.mkdirSync(unrelated);
    fs.chmodSync(unrelated, 0o755);
    const link = path.join(root, 'agent');
    fs.symlinkSync(unrelated, link);
    for (const allowExisting of [false, true]) {
      expect(runShell(createDirectoryCommand(link, dirSpec, { sudo: false, allowExisting })).status).toBe(WRITE_EXIT.exists);
      expect(modeOf(unrelated)).toBe('755');
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    }
  });

  it('refuses a directory created since the plan was approved, and keeps its mode', () => {
    const made = path.join(root, 'agent');
    fs.mkdirSync(made);
    fs.chmodSync(made, 0o755);
    expect(runShell(createDirectoryCommand(made, dirSpec, { sudo: false, allowExisting: false })).status).toBe(WRITE_EXIT.exists);
    expect(modeOf(made)).toBe('755');
  });

  it('applies the mode to an existing real directory only when that is allowed (the apt keyring directory)', () => {
    const keyrings = path.join(root, 'keyrings');
    fs.mkdirSync(keyrings);
    fs.chmodSync(keyrings, 0o700);
    expect(runShell(createDirectoryCommand(keyrings, { mode: '0755', owner, group }, { sudo: false, allowExisting: true })).status).toBe(0);
    expect(modeOf(keyrings)).toBe('755');
  });

  it('treats an injection-shaped path as data', () => {
    const hostile = path.join(root, "it's $(touch pwned) `id`;");
    expect(runShell(createDirectoryCommand(hostile, dirSpec, { sudo: false, allowExisting: false })).status).toBe(0);
    expect(fs.readdirSync(root).some((name) => name.startsWith('pwned'))).toBe(false);
  });
});

/** A session that runs the commands on this machine's shell, with the download answered from memory. */
function localSession(options: { download?: string; downloadFails?: boolean; truncatedDownload?: boolean; beforeWrite?: () => void } = {}): ExecSession & { commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    closed: false,
    close: () => undefined,
    run: async (command: string, runOptions: ExecOptions): Promise<ExecResult> => {
      commands.push(command);
      if (command.startsWith('curl ')) {
        return { exitCode: options.downloadFails ? 22 : 0, stdout: options.downloadFails ? '' : options.download ?? DOCKER_KEY_ASC, stderr: '', truncated: options.truncatedDownload === true, timedOut: false, error: null };
      }
      if (command.includes('sencho-write')) options.beforeWrite?.();
      const result = spawnSync('sh', ['-c', `LC_ALL=C ${command}`], { input: runOptions.stdin ?? '', encoding: 'utf8' });
      return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, truncated: false, timedOut: false, error: null };
    },
  };
}

function context(session: ExecSession, secrets: string[] = []): StepContext {
  return { session, signal: new AbortController().signal, note: () => undefined, secrets, composeWithToken: () => { throw new Error('not a compose step'); } };
}

const PLAN = { paths: { composeDir: { input: '/opt/docker/sencho' }, agentDir: { input: '/opt/sencho-agent' } } } as unknown as BootstrapPlan;

function keyStep(dest: string, mode = '0644'): BootstrapPlanStep {
  return {
    id: 'docker-key',
    title: 'Fetch the Docker repository key',
    rationale: 'test',
    effect: 'file-write',
    privilege: 'user',
    command: 'curl -fsSL https://download.docker.com/linux/ubuntu/gpg',
    target: { path: dest, mode, owner, group, preserveExisting: false },
    disruptive: false,
    reversible: 'yes',
    pointOfNoReturn: false,
    timeoutMs: 30_000,
  };
}

async function failureOf(run: () => Promise<unknown>): Promise<StepFailure> {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof StepFailure) return error;
    throw error;
  }
  throw new Error('expected the step to fail');
}

describe('B1: the Docker key is verified before it is put in place, and never written through a path', () => {
  it('publishes Docker\'s key with the planned mode', async () => {
    const dest = path.join(root, 'docker.asc');
    const outcome = await runPlanStep(keyStep(dest), context(localSession()), PLAN);
    expect(outcome.status).toBe('done');
    expect(fs.readFileSync(dest, 'utf8')).toBe(DOCKER_KEY_ASC);
    expect(modeOf(dest)).toBe('644');
    expect(fs.readdirSync(root)).toEqual(['docker.asc']);
  });

  it('writes nothing when the download is not Docker\'s release key', async () => {
    const dest = path.join(root, 'docker.asc');
    const failure = await failureOf(() => runPlanStep(keyStep(dest), context(localSession({ download: 'not a key\n' })), PLAN));
    expect(failure.code).toBe('KEY_NOT_VERIFIED');
    expect(failure.changedNothing).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('writes nothing when the download fails', async () => {
    const failure = await failureOf(() => runPlanStep(keyStep(path.join(root, 'docker.asc')), context(localSession({ downloadFails: true })), PLAN));
    expect(failure.code).toBe('STEP_FAILED');
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('does not write through a symlink at the destination', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    fs.writeFileSync(elsewhere, 'untouched', { mode: 0o640 });
    const dest = path.join(root, 'docker.asc');
    fs.symlinkSync(elsewhere, dest);
    const failure = await failureOf(() => runPlanStep(keyStep(dest), context(localSession()), PLAN));
    expect(failure.kind).toBe('recovery');
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe('untouched');
    expect(modeOf(elsewhere)).toBe('640');
  });

  it('does not write through a symlink created after the destination was inspected', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    fs.writeFileSync(elsewhere, 'untouched', { mode: 0o640 });
    const dest = path.join(root, 'docker.asc');
    const failure = await failureOf(() => runPlanStep(keyStep(dest), context(localSession({ beforeWrite: () => fs.symlinkSync(elsewhere, dest) })), PLAN));
    expect(failure.code).toBe('FILE_CONFLICT');
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe('untouched');
    expect(modeOf(elsewhere)).toBe('640');
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);
  });

  it('leaves an existing file that is not Docker\'s key as it is', async () => {
    const dest = path.join(root, 'docker.asc');
    fs.writeFileSync(dest, 'someone else\'s key material');
    const failure = await failureOf(() => runPlanStep(keyStep(dest), context(localSession()), PLAN));
    expect(failure.code).toBe('FILE_CONFLICT');
    expect(fs.readFileSync(dest, 'utf8')).toBe('someone else\'s key material');
  });

  it('replaces a leftover copy of Docker\'s own key, which brings its mode to the plan', async () => {
    const dest = path.join(root, 'docker.asc');
    fs.writeFileSync(dest, DOCKER_KEY_ASC, { mode: 0o600 });
    const outcome = await runPlanStep(keyStep(dest), context(localSession()), PLAN);
    expect(outcome.status).toBe('done');
    expect(modeOf(dest)).toBe('644');
  });

  it('refuses a leftover key that changed between the read and the write', async () => {
    const dest = path.join(root, 'docker.asc');
    fs.writeFileSync(dest, DOCKER_KEY_ASC, { mode: 0o600 });
    const failure = await failureOf(() => runPlanStep(keyStep(dest), context(localSession({ beforeWrite: () => fs.writeFileSync(dest, 'swapped in') })), PLAN));
    expect(failure.code).toBe('FILE_CONFLICT');
    expect(fs.readFileSync(dest, 'utf8')).toBe('swapped in');
    expect(fs.readdirSync(root)).toEqual(['docker.asc']);
  });
});

describe('B1: a directory step refuses what appeared after the plan was approved', () => {
  function dirStep(dest: string, allowExisting = false): BootstrapPlanStep {
    return {
      id: 'create-agent-dir',
      title: 'Create the Agent installation directory',
      rationale: 'test',
      effect: 'directory-create',
      privilege: 'user',
      command: createDirectoryCommand(dest, { mode: '0700', owner, group }, { sudo: false, allowExisting }),
      target: { path: dest, mode: '0700', owner, group, preserveExisting: allowExisting },
      disruptive: false,
      reversible: 'yes',
      pointOfNoReturn: false,
      timeoutMs: 10_000,
    };
  }

  it('creates the directory and verifies it', async () => {
    const dest = path.join(root, 'agent');
    const outcome = await runPlanStep(dirStep(dest), context(localSession()), PLAN);
    expect(outcome.status).toBe('done');
    expect(modeOf(dest)).toBe('700');
  });

  it('stops on a symlink put at the name, changes nothing and counts as no change', async () => {
    const unrelated = path.join(root, 'unrelated');
    fs.mkdirSync(unrelated);
    fs.chmodSync(unrelated, 0o755);
    const dest = path.join(root, 'agent');
    fs.symlinkSync(unrelated, dest);
    const failure = await failureOf(() => runPlanStep(dirStep(dest), context(localSession()), PLAN));
    expect(failure.code).toBe('FILE_CONFLICT');
    expect(failure.changedNothing).toBe(true);
    expect(modeOf(unrelated)).toBe('755');
  });
});

/** The compose file a retry finds, with a real-looking token in it. */
const OLD_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.previous-attempt-token.signature-material';
const NEW_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.this-attempt-token.signature-material';

function composeStep(dest: string): BootstrapPlanStep {
  const reviewed = buildPilotEnrollmentCompose({ primaryUrl: 'https://hub.example.com', token: TOKEN_PLACEHOLDER, composeDir: '/opt/docker/sencho' });
  return {
    id: 'agent-compose-file',
    title: 'Write the Pilot compose file',
    rationale: 'test',
    effect: 'file-write',
    privilege: 'user',
    command: null,
    target: { path: dest, mode: '0600', owner, group, preserveExisting: true },
    file: { path: dest, mode: '0600', content: reviewed, redacted: true },
    disruptive: false,
    reversible: 'yes',
    pointOfNoReturn: false,
    timeoutMs: 10_000,
  };
}

function composeWith(token: string): string {
  return buildPilotEnrollmentCompose({ primaryUrl: 'https://hub.example.com', token, composeDir: '/opt/docker/sencho' });
}

/** Every form a credential can take in a recorded detail: raw, base64, and base64 at each alignment. */
function leaks(text: string | null, token: string): boolean {
  if (!text) return false;
  const forms = [token, Buffer.from(token).toString('base64')];
  for (let shift = 0; shift < 3; shift += 1) {
    const encoded = Buffer.from(`${'x'.repeat(shift)}${token}`).toString('base64');
    forms.push(encoded.slice(8, encoded.length - 8));
  }
  if (forms.some((form) => text.includes(form))) return true;
  // A decoded view of any long base64 run.
  return (text.match(/[A-Za-z0-9+/=]{24,}/g) ?? []).some((run) => Buffer.from(run, 'base64').toString('utf8').includes(token.slice(10, 40)));
}

describe('B2: a failed file read records nothing of the file', () => {
  const oldContent = composeWith(OLD_TOKEN);
  const encoded = Buffer.from(oldContent).toString('base64');

  function sessionReturning(result: Partial<ExecResult>): ExecSession {
    return {
      closed: false,
      close: () => undefined,
      run: async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false, error: null, ...result }),
    };
  }

  it.each([
    ['the connection drops after the content was sent', { exitCode: null, stdout: encoded, error: 'CONNECTION_LOST' as const }],
    ['the read times out after the content was sent', { exitCode: null, stdout: encoded, timedOut: true }],
    ['the channel fails after the content was sent', { exitCode: null, stdout: encoded, error: 'COMMAND_ERROR' as const }],
    ['the read exits non-zero after the content was sent', { exitCode: 5, stdout: encoded, stderr: 'base64: write error' }],
  ])('keeps the previous attempt\'s credential out of the failure when %s', async (_label, result) => {
    const failure = await failureOf(() => runPlanStep(composeStep('/opt/sencho-agent/compose.yaml'), {
      ...context(sessionReturning(result), [NEW_TOKEN]),
      composeWithToken: () => composeWith(NEW_TOKEN),
    }, PLAN));
    const recorded = `${failure.message}\n${failure.detail ?? ''}`;
    expect(leaks(recorded, OLD_TOKEN)).toBe(false);
    expect(leaks(recorded, NEW_TOKEN)).toBe(false);
    expect(recorded).not.toContain(encoded.slice(0, 40));
    expect(failure.detail ?? '').not.toContain(encoded.slice(0, 40));
  });

  it('still records the command\'s own error text for a non-zero exit', async () => {
    const failure = await failureOf(() => runPlanStep(composeStep('/opt/sencho-agent/compose.yaml'), {
      ...context(sessionReturning({ exitCode: 5, stdout: encoded, stderr: 'base64: write error' }), [NEW_TOKEN]),
      composeWithToken: () => composeWith(NEW_TOKEN),
    }, PLAN));
    expect(failure.code).toBe('READ_FAILED');
    expect(failure.detail).toBe('base64: write error');
  });

  it('keeps a key download out of the failure detail as well', async () => {
    const failure = await failureOf(() => runPlanStep(keyStep(path.join(root, 'docker.asc')), context(sessionReturning({ exitCode: null, stdout: DOCKER_KEY_ASC, error: 'CONNECTION_LOST' })), PLAN));
    expect(failure.code).toBe('SSH_CONNECTION_LOST');
    expect(failure.detail ?? '').not.toContain('BEGIN PGP');
  });
});

describe('B1: the directory is pinned between its inspection and its entry', () => {
  it('refuses a directory name swapped for a symlink between the check and the entry, and writes nothing', () => {
    const dir = path.join(root, 'agent');
    const decoy = path.join(root, 'decoy');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.mkdirSync(decoy, { mode: 0o755 });
    const shim = shimDir(root, `mv "${dir}" "${dir}.moved" && ln -s "${decoy}" "${dir}"`);
    const result = runShell(writeFileCommand(path.join(dir, 'compose.yaml'), { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null }), 'ours', shim.env);
    expect(result.status).toBe(WRITE_EXIT.notDirectory);
    expect(fs.readdirSync(decoy)).toEqual([]);
    expect(fs.readdirSync(`${dir}.moved`)).toEqual([]);
  });

  it('refuses an ancestor swapped for a symlink between the check and the entry, and writes nothing', () => {
    const parent = path.join(root, 'srv');
    const decoyParent = path.join(root, 'decoy');
    fs.mkdirSync(path.join(parent, 'agent'), { recursive: true });
    fs.mkdirSync(path.join(decoyParent, 'agent'), { recursive: true });
    const shim = shimDir(root, `mv "${parent}" "${parent}.moved" && ln -s "${decoyParent}" "${parent}"`);
    const result = runShell(writeFileCommand(path.join(parent, 'agent', 'compose.yaml'), { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null }), 'ours', shim.env);
    expect(result.status).toBe(WRITE_EXIT.notDirectory);
    expect(fs.readdirSync(path.join(decoyParent, 'agent'))).toEqual([]);
  });

  it('creates nothing in a parent swapped between the check and the entry', () => {
    const parent = path.join(root, 'srv');
    const decoy = path.join(root, 'decoy');
    fs.mkdirSync(parent, { mode: 0o755 });
    fs.mkdirSync(decoy, { mode: 0o755 });
    const shim = shimDir(root, `mv "${parent}" "${parent}.moved" && ln -s "${decoy}" "${parent}"`);
    const result = runShell(createDirectoryCommand(path.join(parent, 'agent'), { mode: '0700', owner, group }, { sudo: false, allowExisting: false }), '', shim.env);
    expect(result.status).toBe(WRITE_EXIT.notDirectory);
    expect(fs.readdirSync(decoy)).toEqual([]);
    expect(modeOf(decoy)).toBe('755');
  });

  it('removes its temporary file when the session ends on a closed pipe (the token must not stay behind)', async () => {
    const target = path.join(root, 'compose.yaml');
    const child = spawn('sh', ['-c', `LC_ALL=C ${writeFileCommand(target, { ...file, sha256: sha256('the full content') }, { sudo: false, replaces: null })}`]);
    const closed = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    const deadline = Date.now() + 10_000;
    while (!hasTemp(root, 'compose.yaml')()) {
      if (Date.now() > deadline) throw new Error('the script never reached its input');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // The reader of the script's error output is gone, then the content ends early.
    child.stderr.destroy();
    child.stdin.end('the full');
    await closed;
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('puts the previous compose file back when the script is stopped while it is moved aside', async () => {
    const target = path.join(root, 'compose.yaml');
    fs.writeFileSync(target, 'old compose with a spent token', { mode: 0o600 });
    const shim = shimDir(root, ':');
    const child = spawn('sh', ['-c', `LC_ALL=C ${writeFileCommand(target, { ...file, sha256: sha256('new compose') }, { sudo: false, replaces: sha256('old compose with a spent token') })}`], { env: { ...process.env, ...shim.env }, detached: true });
    const closed = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    child.stdin.end('new compose');
    const deadline = Date.now() + 10_000;
    while (!fs.readdirSync(root).some((entry) => entry.startsWith('.compose.yaml.old.'))) {
      if (Date.now() > deadline) throw new Error('the file was never moved aside');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // The whole group, so the shell that holds the script gets the signal too.
    process.kill(-(child.pid as number), 'SIGTERM');
    await closed;
    const settled = Date.now() + 10_000;
    while (fs.readdirSync(root).some((entry) => entry.startsWith('.compose.yaml.')) && Date.now() < settled) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.readFileSync(target, 'utf8')).toBe('old compose with a spent token');
    expect(fs.readdirSync(root).filter((entry) => entry !== 'shims')).toEqual(['compose.yaml']);
  });
});

/** A shim that runs the real command and then stops the shell that called it, as sudo does when a session ends. */
function signalingShim(base: string, command: string, when: string): { PATH: string } {
  const dir = path.join(base, `signal-${command}`);
  fs.mkdirSync(dir);
  const real = execFileSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(dir, command), [
    '#!/bin/sh',
    `"${real}" "$@"; rc=$?`,
    `case "$*" in ${when}) kill -TERM $PPID ;; esac`,
    'exit $rc',
  ].join('\n'), { mode: 0o755 });
  return { PATH: `${dir}:${process.env.PATH ?? ''}` };
}

describe('B1: a stop in the middle of a replacement never loses or strands the compose file', () => {
  const previous = 'old compose with a spent token';
  const replacement = () => writeFileCommand(path.join(root, 'compose.yaml'), { ...file, sha256: sha256('new compose') }, { sudo: false, replaces: sha256(previous) });

  it('puts the previous file back when the stop lands right after it was moved aside', () => {
    fs.writeFileSync(path.join(root, 'compose.yaml'), previous, { mode: 0o600 });
    const env = signalingShim(root, 'mv', '*.old.*');
    const result = runShell(replacement(), 'new compose', env);
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8')).toBe(previous);
    expect(fs.readdirSync(root).filter((entry) => !entry.startsWith('signal-'))).toEqual(['compose.yaml']);
  });

  it('leaves only the new file when the stop lands right after it was published', () => {
    fs.writeFileSync(path.join(root, 'compose.yaml'), previous, { mode: 0o600 });
    const env = signalingShim(root, 'ln', '*.old.*) ;; *./compose.yaml');
    const result = runShell(replacement(), 'new compose', env);
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8')).toBe('new compose');
    expect(fs.readdirSync(root).filter((entry) => !entry.startsWith('signal-'))).toEqual(['compose.yaml']);
  });
});

describe('B1: directory creation makes missing parents the way install -d did', () => {
  const dirSpec = { mode: '0700', owner, group };

  it('creates every missing parent with 0755 and gives only the directory itself the planned mode', () => {
    const target = path.join(root, 'opt', 'docker', 'sencho');
    expect(runShell(createDirectoryCommand(target, { mode: '0755', owner, group }, { sudo: false, allowExisting: false })).status).toBe(0);
    expect(modeOf(path.join(root, 'opt'))).toBe('755');
    expect(modeOf(path.join(root, 'opt', 'docker'))).toBe('755');
    const agent = path.join(root, 'srv', 'a', 'agent');
    expect(runShell(createDirectoryCommand(agent, dirSpec, { sudo: false, allowExisting: false })).status).toBe(0);
    expect(modeOf(path.join(root, 'srv', 'a'))).toBe('755');
    expect(modeOf(agent)).toBe('700');
  });

  it('works under an existing ancestor that is a symlink, which the plan discloses, and creates inside what it leads to', () => {
    const real = path.join(root, 'real');
    fs.mkdirSync(real, { mode: 0o755 });
    const link = path.join(root, 'link');
    fs.symlinkSync(real, link);
    expect(runShell(createDirectoryCommand(path.join(link, 'docker', 'sencho'), { mode: '0755', owner, group }, { sudo: false, allowExisting: false })).status).toBe(0);
    expect(fs.statSync(path.join(real, 'docker', 'sencho')).isDirectory()).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('enters a parent that appeared as a real directory meanwhile and leaves its mode alone', () => {
    // A mkdir that finds the name taken by a directory made in the meantime.
    const shimBase = path.join(root, 'shim-mkdir');
    fs.mkdirSync(shimBase);
    const realMkdir = execFileSync('sh', ['-c', 'command -v mkdir'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(shimBase, 'mkdir'), ['#!/bin/sh', 'case "$2" in ./mid) "' + realMkdir + '" -m 0700 ./mid; exit 1 ;; esac', `exec "${realMkdir}" "$@"`].join('\n'), { mode: 0o755 });
    const target = path.join(root, 'mid', 'agent');
    const result = runShell(createDirectoryCommand(target, dirSpec, { sudo: false, allowExisting: false }), '', { PATH: `${shimBase}:${process.env.PATH ?? ''}` });
    expect(result.status).toBe(0);
    expect(modeOf(path.join(root, 'mid'))).toBe('700');
    expect(modeOf(target)).toBe('700');
  });

  it('refuses when the nearest existing ancestor is a file, and when the path is not absolute', () => {
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, 'x');
    expect(runShell(createDirectoryCommand(path.join(blocker, 'agent'), dirSpec, { sudo: false, allowExisting: false })).status).toBe(WRITE_EXIT.notDirectory);
    expect(runShell(createDirectoryCommand('relative/agent', dirSpec, { sudo: false, allowExisting: false })).status).toBe(WRITE_EXIT.notDirectory);
  });

  it.skipIf(IS_ROOT)('says nothing was created when mkdir fails for a reason other than the name existing', () => {
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked, { mode: 0o555 });
    const result = runShell(createDirectoryCommand(path.join(locked, 'agent'), dirSpec, { sudo: false, allowExisting: false }));
    expect(result.status).toBe(WRITE_EXIT.notCreated);
    expect(result.stderr).toContain('could not create');
    fs.chmodSync(locked, 0o755);
  });

  it.skipIf(IS_ROOT)('says a directory was created but not finished when its owner cannot be set', () => {
    const target = path.join(root, 'srv', 'agent');
    const result = runShell(createDirectoryCommand(target, { mode: '0700', owner, group: 'root' }, { sudo: false, allowExisting: false }));
    expect(result.status).toBe(WRITE_EXIT.unfinished);
    expect(fs.existsSync(target)).toBe(true);
  });
});

/** A session that answers each command from a script, for the step's own mapping of what the scripts report. */
function scriptedSession(answer: (command: string) => Partial<ExecResult>): ExecSession & { commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    closed: false,
    close: () => undefined,
    run: async (command: string) => {
      commands.push(command);
      return { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false, error: null, ...answer(command) };
    },
  };
}

describe('B1: the step names what a script refused', () => {
  function dirStepFor(dest: string): BootstrapPlanStep {
    return {
      id: 'create-compose-dir',
      title: 'Create the Compose stacks directory',
      rationale: 'test',
      effect: 'directory-create',
      privilege: 'user',
      command: createDirectoryCommand(dest, { mode: '0755', owner, group }, { sudo: false, allowExisting: false }),
      target: { path: dest, mode: '0755', owner, group, preserveExisting: false },
      disruptive: false,
      reversible: 'yes',
      pointOfNoReturn: false,
      timeoutMs: 10_000,
    };
  }

  it.each([
    [WRITE_EXIT.exists, 'recovery', 'FILE_CONFLICT', true],
    [WRITE_EXIT.notDirectory, 'failed', 'DIRECTORY_CHANGED', true],
    [WRITE_EXIT.notCreated, 'failed', 'STEP_FAILED', true],
    [WRITE_EXIT.unfinished, 'recovery', 'DIRECTORY_NOT_FINISHED', false],
    [1, 'failed', 'STEP_FAILED', false],
  ])('maps a directory script exit %i to %s %s (changed nothing: %s)', async (exitCode, kind, code, changedNothing) => {
    const failure = await failureOf(() => runPlanStep(dirStepFor('/opt/docker/sencho'), context(scriptedSession(() => ({ exitCode, stderr: 'script said so' }))), PLAN));
    expect(failure).toMatchObject({ kind, code, changedNothing });
    expect(failure.detail).toBe('script said so');
  });

  const composeAt = '/opt/sencho-agent/compose.yaml';

  it('treats a refused plain write as having changed nothing, and a refused replacement as possibly having changed something', async () => {
    const plain = scriptedSession((command) => (command.includes('sencho-read') ? { exitCode: READ_MISSING } : { exitCode: WRITE_EXIT.exists }));
    const plainFailure = await failureOf(() => runPlanStep(composeStep(composeAt), { ...context(plain, [NEW_TOKEN]), composeWithToken: () => composeWith(NEW_TOKEN) }, PLAN));
    expect(plainFailure).toMatchObject({ code: 'FILE_CONFLICT', changedNothing: true });

    const previous = Buffer.from(composeWith(OLD_TOKEN)).toString('base64');
    const replace = scriptedSession((command) => (command.includes('sencho-read') ? { stdout: previous } : { exitCode: WRITE_EXIT.exists }));
    const replaceFailure = await failureOf(() => runPlanStep(composeStep(composeAt), { ...context(replace, [NEW_TOKEN]), composeWithToken: () => composeWith(NEW_TOKEN) }, PLAN));
    expect(replaceFailure).toMatchObject({ code: 'FILE_CONFLICT', changedNothing: false });
    // The write was told which file it may replace: the one that was read.
    expect(replace.commands.some((command) => command.includes(`'${sha256(composeWith(OLD_TOKEN))}'`))).toBe(true);
  });

  it('names a directory that changed under a file write', async () => {
    const session = scriptedSession((command) => (command.includes('sencho-read') ? { exitCode: READ_MISSING } : { exitCode: WRITE_EXIT.notDirectory }));
    const failure = await failureOf(() => runPlanStep(composeStep(composeAt), { ...context(session, [NEW_TOKEN]), composeWithToken: () => composeWith(NEW_TOKEN) }, PLAN));
    expect(failure).toMatchObject({ kind: 'failed', code: 'DIRECTORY_CHANGED', changedNothing: true });
  });
});

describe('B1: every writer caller refuses a name taken after it looked', () => {
  const callers: Array<[string, string, string]> = [
    ['the bootstrap marker', 'sencho-bootstrap.json', '{"project":"sencho-agent"}\n'],
    ['the hub CA', 'sencho-hub-ca.pem', '-----BEGIN CERTIFICATE-----\nMIIBhub\n-----END CERTIFICATE-----\n'],
    ['the apt source', 'docker.list', 'deb [arch=amd64] https://download.docker.com/linux/ubuntu noble stable\n'],
  ];

  it.each(callers)('%s: a file or symlink created at its name after the plan was approved is kept', async (_label, name, content) => {
    const dest = path.join(root, name);
    const step: BootstrapPlanStep = {
      id: 'writer-caller',
      title: `Write ${name}`,
      rationale: 'test',
      effect: 'file-write',
      privilege: 'user',
      command: null,
      target: { path: dest, mode: '0644', owner, group, preserveExisting: false },
      file: { path: dest, mode: '0644', content, redacted: false },
      disruptive: false,
      reversible: 'yes',
      pointOfNoReturn: false,
      timeoutMs: 10_000,
    };
    const elsewhere = path.join(root, 'elsewhere');
    fs.writeFileSync(elsewhere, 'untouched', { mode: 0o640 });
    const racing = localSession({ beforeWrite: () => fs.symlinkSync(elsewhere, dest) });
    const failure = await failureOf(() => runPlanStep(step, context(racing), PLAN));
    expect(failure).toMatchObject({ code: 'FILE_CONFLICT', changedNothing: true });
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe('untouched');
    expect(modeOf(elsewhere)).toBe('640');

    fs.unlinkSync(dest);
    const plain = localSession({ beforeWrite: () => fs.writeFileSync(dest, 'theirs') });
    await expect(runPlanStep(step, context(plain), PLAN)).rejects.toMatchObject({ code: 'FILE_CONFLICT' });
    expect(fs.readFileSync(dest, 'utf8')).toBe('theirs');

    fs.unlinkSync(dest);
    expect((await runPlanStep(step, context(localSession()), PLAN)).status).toBe('done');
    expect(fs.readFileSync(dest, 'utf8')).toBe(content);
  });
});

describe('B2: a failed key download records none of the key either', () => {
  it.each([
    ['times out', { exitCode: null, timedOut: true }],
    ['loses the channel', { exitCode: null, error: 'COMMAND_ERROR' as const }],
    ['exits non-zero', { exitCode: 22, stderr: 'curl: (22) The requested URL returned error: 404' }],
  ])('keeps the key out of the failure when the download %s after sending it', async (_label, result) => {
    const session = scriptedSession(() => ({ stdout: DOCKER_KEY_ASC, ...result }));
    const failure = await failureOf(() => runPlanStep(keyStep(path.join(root, 'docker.asc')), context(session), PLAN));
    expect(`${failure.message}${failure.detail ?? ''}`).not.toContain('BEGIN PGP');
    expect(`${failure.message}${failure.detail ?? ''}`).not.toContain('mQINBFit2ioBEADh');
  });

  it('refuses a download cut off by the size cap, and writes nothing', async () => {
    const failure = await failureOf(() => runPlanStep(keyStep(path.join(root, 'docker.asc')), context(localSession({ truncatedDownload: true })), PLAN));
    expect(failure.code).toBe('KEY_NOT_VERIFIED');
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
