import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { READ_EXIT, START_EXIT, WRITE_EXIT, madeDirectoriesInput, startInput, startProjectCommand } from '../services/nodeBootstrap/executionCommands';
import { approvedIdentity, approvedPath, directoryCommand, identityOf, writeCommand } from './__helpers__/bootstrapCommands';
import { StepFailure, TOKEN_PLACEHOLDER, approvedBinding, approvedDirectory, runPlanStep, type StepContext } from '../services/nodeBootstrap/stepRunner';
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
      writeCommand(target, { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null }),
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
      writeCommand(target, { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null }),
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
      writeCommand(target, { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null }),
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
    const command = (target: string) => writeCommand(target, { ...file, sha256: sha256('new compose') }, { sudo: false, replaces: sha256(inspected) });

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
      const result = runShell(writeCommand(path.join(link, 'compose.yaml'), { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null }), 'ours');
      expect(result.status).toBe(WRITE_EXIT.notDirectory);
      expect(fs.readdirSync(real)).toEqual([]);
    });

    it('writes only into the directory it inspected when the name is swapped meanwhile', async () => {
      const dir = path.join(root, 'agent');
      const decoy = path.join(root, 'decoy');
      fs.mkdirSync(dir, { mode: 0o755 });
      fs.mkdirSync(decoy, { mode: 0o755 });
      const result = await runRaced(
        writeCommand(path.join(dir, 'compose.yaml'), { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null }),
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
        writeCommand(path.join(dir, 'compose.yaml'), { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null }),
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
    expect(runShell(directoryCommand(target, dirSpec, { sudo: false, allowExisting: false })).status).toBe(0);
    expect(modeOf(target)).toBe('700');
  });

  it('refuses a symlink at the name and leaves the directory it points to alone', () => {
    const unrelated = path.join(root, 'unrelated');
    fs.mkdirSync(unrelated);
    fs.chmodSync(unrelated, 0o755);
    const link = path.join(root, 'agent');
    fs.symlinkSync(unrelated, link);
    for (const allowExisting of [false, true]) {
      expect(runShell(directoryCommand(link, dirSpec, { sudo: false, allowExisting })).status).toBe(WRITE_EXIT.exists);
      expect(modeOf(unrelated)).toBe('755');
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    }
  });

  it('refuses a directory created since the plan was approved, and keeps its mode', () => {
    const made = path.join(root, 'agent');
    fs.mkdirSync(made);
    fs.chmodSync(made, 0o755);
    expect(runShell(directoryCommand(made, dirSpec, { sudo: false, allowExisting: false })).status).toBe(WRITE_EXIT.exists);
    expect(modeOf(made)).toBe('755');
  });

  it('applies the mode to an existing real directory only when that is allowed (the apt keyring directory)', () => {
    const keyrings = path.join(root, 'keyrings');
    fs.mkdirSync(keyrings);
    fs.chmodSync(keyrings, 0o700);
    expect(runShell(directoryCommand(keyrings, { mode: '0755', owner, group }, { sudo: false, allowExisting: true })).status).toBe(0);
    expect(modeOf(keyrings)).toBe('755');
  });

  it('treats an injection-shaped path as data', () => {
    const hostile = path.join(root, "it's $(touch pwned) `id`;");
    expect(runShell(directoryCommand(hostile, dirSpec, { sudo: false, allowExisting: false })).status).toBe(0);
    expect(fs.readdirSync(root).some((name) => name.startsWith('pwned'))).toBe(false);
  });
});

/** A session that runs the commands on this machine's shell, with the download answered from memory. */
function localSession(options: { download?: string; downloadFails?: boolean; truncatedDownload?: boolean; beforeWrite?: () => void; env?: NodeJS.ProcessEnv } = {}): ExecSession & { commands: string[] } {
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
      const result = spawnSync('sh', ['-c', `LC_ALL=C ${command}`], { input: runOptions.stdin ?? '', encoding: 'utf8', env: { ...process.env, ...options.env } });
      return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, truncated: false, timedOut: false, error: null };
    },
  };
}

function context(session: ExecSession, secrets: string[] = []): StepContext {
  return { session, signal: new AbortController().signal, note: () => undefined, secrets, directories: new Map(), composeWithToken: () => { throw new Error('not a compose step'); } };
}

const PLAN = { paths: { composeDir: { input: '/opt/docker/sencho', identity: '64768:300:1000:2026-01-01' }, agentDir: { input: '/opt/sencho-agent', identity: '64768:200:1000:2026-01-01' } } } as unknown as BootstrapPlan;

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
      command: directoryCommand(dest, { mode: '0700', owner, group }, { sudo: false, allowExisting }),
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
    const result = runShell(writeCommand(path.join(dir, 'compose.yaml'), { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null }), 'ours', shim.env);
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
    const result = runShell(writeCommand(path.join(parent, 'agent', 'compose.yaml'), { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null }), 'ours', shim.env);
    expect(result.status).toBe(WRITE_EXIT.notDirectory);
    expect(fs.readdirSync(path.join(decoyParent, 'agent'))).toEqual([]);
  });

  it('creates nothing in a parent swapped between the check and the entry', () => {
    const parent = path.join(root, 'srv');
    const decoy = path.join(root, 'decoy');
    fs.mkdirSync(parent, { mode: 0o755 });
    fs.mkdirSync(decoy, { mode: 0o755 });
    const shim = shimDir(root, `mv "${parent}" "${parent}.moved" && ln -s "${decoy}" "${parent}"`);
    const result = runShell(directoryCommand(path.join(parent, 'agent'), { mode: '0700', owner, group }, { sudo: false, allowExisting: false }), '', shim.env);
    expect(result.status).toBe(WRITE_EXIT.notDirectory);
    expect(fs.readdirSync(decoy)).toEqual([]);
    expect(modeOf(decoy)).toBe('755');
  });

  it('removes its temporary file when the session ends on a closed pipe (the token must not stay behind)', async () => {
    const target = path.join(root, 'compose.yaml');
    const child = spawn('sh', ['-c', `LC_ALL=C ${writeCommand(target, { ...file, sha256: sha256('the full content') }, { sudo: false, replaces: null })}`]);
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
    const child = spawn('sh', ['-c', `LC_ALL=C ${writeCommand(target, { ...file, sha256: sha256('new compose') }, { sudo: false, replaces: sha256('old compose with a spent token') })}`], { env: { ...process.env, ...shim.env }, detached: true });
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
  const replacement = () => writeCommand(path.join(root, 'compose.yaml'), { ...file, sha256: sha256('new compose') }, { sudo: false, replaces: sha256(previous) });

  it('puts the previous file back when the stop lands right after it was moved aside', () => {
    fs.writeFileSync(path.join(root, 'compose.yaml'), previous, { mode: 0o600 });
    const env = signalingShim(root, 'mv', '*.old.*');
    const result = runShell(replacement(), 'new compose', env);
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8')).toBe(previous);
    expect(fs.readdirSync(root).filter((entry) => !entry.startsWith('signal-'))).toEqual(['compose.yaml']);
  });

  it('leaves no extra link to the original when the stop lands right after it was put back', () => {
    fs.writeFileSync(path.join(root, 'compose.yaml'), previous, { mode: 0o600 });
    // The write was told to replace a different file, so the original is moved aside, found not to match, and put back.
    const command = writeCommand(path.join(root, 'compose.yaml'), { ...file, sha256: sha256('new compose') }, { sudo: false, replaces: sha256('something else') });
    const env = signalingShim(root, 'ln', '*.old.*');
    const result = runShell(command, 'new compose', env);
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

describe('B1: directory creation makes the missing parents too', () => {
  const dirSpec = { mode: '0700', owner, group };

  it('creates every missing parent with 0755 and gives only the directory itself the planned mode', () => {
    const target = path.join(root, 'opt', 'docker', 'sencho');
    expect(runShell(directoryCommand(target, { mode: '0755', owner, group }, { sudo: false, allowExisting: false })).status).toBe(0);
    expect(modeOf(path.join(root, 'opt'))).toBe('755');
    expect(modeOf(path.join(root, 'opt', 'docker'))).toBe('755');
    const agent = path.join(root, 'srv', 'a', 'agent');
    expect(runShell(directoryCommand(agent, dirSpec, { sudo: false, allowExisting: false })).status).toBe(0);
    expect(modeOf(path.join(root, 'srv', 'a'))).toBe('755');
    expect(modeOf(agent)).toBe('700');
  });

  it('works under an existing ancestor that is a symlink, which the plan discloses, and creates inside what it leads to', () => {
    const real = path.join(root, 'real');
    fs.mkdirSync(real, { mode: 0o755 });
    const link = path.join(root, 'link');
    fs.symlinkSync(real, link);
    expect(runShell(directoryCommand(path.join(link, 'docker', 'sencho'), { mode: '0755', owner, group }, { sudo: false, allowExisting: false })).status).toBe(0);
    expect(fs.statSync(path.join(real, 'docker', 'sencho')).isDirectory()).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('refuses when the nearest existing ancestor is a file, and when the path is not absolute', () => {
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, 'x');
    expect(runShell(directoryCommand(path.join(blocker, 'agent'), dirSpec, { sudo: false, allowExisting: false })).status).toBe(WRITE_EXIT.notDirectory);
    expect(runShell(directoryCommand('relative/agent', dirSpec, { sudo: false, allowExisting: false })).status).toBe(WRITE_EXIT.notDirectory);
  });

  it.skipIf(IS_ROOT)('says nothing was created when mkdir fails for a reason other than the name existing', () => {
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked, { mode: 0o555 });
    const result = runShell(directoryCommand(path.join(locked, 'agent'), dirSpec, { sudo: false, allowExisting: false }));
    expect(result.status).toBe(WRITE_EXIT.notCreated);
    expect(result.stderr).toContain('could not create');
    fs.chmodSync(locked, 0o755);
  });

  it.skipIf(IS_ROOT)('says nothing was created when the owner cannot be set, and leaves nothing behind', () => {
    const parent = path.join(root, 'srv');
    fs.mkdirSync(parent, { mode: 0o755 });
    const target = path.join(parent, 'a', 'agent');
    const result = runShell(directoryCommand(target, { mode: '0700', owner, group: 'root' }, { sudo: false, allowExisting: false }));
    expect(result.status).toBe(WRITE_EXIT.notCreated);
    // The directories are finished before they are put in place: a failure leaves no half-made directory and no staging directory.
    expect(fs.readdirSync(parent)).toEqual([]);
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
      command: directoryCommand(dest, { mode: '0755', owner, group }, { sudo: false, allowExisting: false }),
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

/** The names every shared writer caller publishes: the marker, the compose file, the CA, the apt source and the Docker key. */
const WRITER_NAMES: Array<[string, string, string]> = [
  ['the bootstrap marker', 'sencho-bootstrap.json', '0600'],
  ['the compose file', 'compose.yaml', '0600'],
  ['the hub CA', 'sencho-hub-ca.pem', '0644'],
  ['the apt source', 'docker.list', '0644'],
  ['the Docker key', 'docker.asc', '0644'],
];

describe('B1: execution is bound to the directory the plan approved', () => {
  /** root/srv/agent approved as it is, then root/srv replaced by a link to root/decoy/agent's parent before the script starts. */
  function arrangeSwappedAncestor(): { dir: string; decoyDir: string; approved: string } {
    const parent = path.join(root, 'srv');
    const dir = path.join(parent, 'agent');
    const decoyParent = path.join(root, 'decoy');
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.mkdirSync(path.join(decoyParent, 'agent'), { recursive: true, mode: 0o755 });
    return {
      dir,
      decoyDir: path.join(decoyParent, 'agent'),
      approved: approvedPath(dir),
    };
  }
  const swapAncestor = () => {
    const parent = path.join(root, 'srv');
    fs.renameSync(parent, `${parent}.moved`);
    fs.symlinkSync(path.join(root, 'decoy'), parent);
  };

  it.each(WRITER_NAMES)('refuses to write %s through an ancestor replaced by a link before the script started', (_label, name, mode) => {
    const { dir, decoyDir, approved } = arrangeSwappedAncestor();
    const command = writeCommand(path.join(dir, name), { mode, owner, group, sha256: sha256('ours') }, { sudo: false, replaces: null, directory: approved });
    swapAncestor();
    const result = runShell(command, 'ours');
    expect(result.status).toBe(WRITE_EXIT.notDirectory);
    expect(fs.readdirSync(decoyDir)).toEqual([]);
    expect(modeOf(decoyDir)).toBe('755');
    expect(fs.readdirSync(path.join(`${path.join(root, 'srv')}.moved`, 'agent'))).toEqual([]);
  });

  it('refuses a replacement through the swapped ancestor as well, and keeps what the link leads to', () => {
    const { dir, decoyDir, approved } = arrangeSwappedAncestor();
    fs.writeFileSync(path.join(dir, 'compose.yaml'), 'old', { mode: 0o600 });
    fs.writeFileSync(path.join(decoyDir, 'compose.yaml'), 'old', { mode: 0o644 });
    const command = writeCommand(path.join(dir, 'compose.yaml'), { ...file, sha256: sha256('new') }, { sudo: false, replaces: sha256('old'), directory: approved });
    swapAncestor();
    expect(runShell(command, 'new').status).toBe(WRITE_EXIT.notDirectory);
    expect(fs.readFileSync(path.join(decoyDir, 'compose.yaml'), 'utf8')).toBe('old');
    expect(modeOf(path.join(decoyDir, 'compose.yaml'))).toBe('644');
  });

  it('refuses a system directory that is reached through a link (the apt directories must be what they say)', () => {
    const real = path.join(root, 'real');
    fs.mkdirSync(path.join(real, 'keyrings'), { recursive: true, mode: 0o755 });
    fs.symlinkSync(real, path.join(root, 'etc'));
    const keyrings = path.join(root, 'etc', 'keyrings');
    const result = runShell(writeCommand(path.join(keyrings, 'docker.asc'), { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null, directory: keyrings }), 'ours');
    expect(result.status).toBe(WRITE_EXIT.notDirectory);
    expect(fs.readdirSync(path.join(real, 'keyrings'))).toEqual([]);
    // The same directory, reached the way it is approved, is written.
    const direct = path.join(real, 'keyrings');
    expect(runShell(writeCommand(path.join(direct, 'docker.asc'), { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null, directory: direct }), 'ours').status).toBe(0);
  });

  it('refuses, through a step, a file written into an agent directory whose ancestor was replaced after the preflight', async () => {
    const { dir, decoyDir, approved } = arrangeSwappedAncestor();
    const identityBefore = approvedIdentity(dir);
    const plan = { paths: { composeDir: { input: '/opt/docker/sencho', realPath: '/opt/docker/sencho', identity: '64768:300:1000:2026-01-01' }, agentDir: { input: dir, realPath: approved, identity: identityBefore } } } as unknown as BootstrapPlan;
    const step = composeStep(path.join(dir, 'compose.yaml'));
    const racing = localSession({ beforeWrite: swapAncestor });
    const failure = await failureOf(() => runPlanStep(step, { ...context(racing, [NEW_TOKEN]), composeWithToken: () => composeWith(NEW_TOKEN) }, plan));
    expect(failure).toMatchObject({ kind: 'failed', code: 'DIRECTORY_CHANGED', changedNothing: true });
    expect(fs.readdirSync(decoyDir)).toEqual([]);
  });

  it('writes the file when the agent directory is reached through a link the plan disclosed', async () => {
    const real = path.join(root, 'data', 'agent');
    fs.mkdirSync(real, { recursive: true, mode: 0o755 });
    const link = path.join(root, 'link');
    fs.symlinkSync(path.join(root, 'data'), link);
    const dir = path.join(link, 'agent');
    const plan = { paths: { composeDir: { input: '/opt/docker/sencho', realPath: '/opt/docker/sencho', identity: '64768:300:1000:2026-01-01' }, agentDir: { input: dir, realPath: approvedPath(dir), identity: approvedIdentity(dir) } } } as unknown as BootstrapPlan;
    expect(approvedPath(dir)).toBe(fs.realpathSync(real));
    const outcome = await runPlanStep(composeStep(path.join(dir, 'compose.yaml')), { ...context(localSession(), [NEW_TOKEN]), composeWithToken: () => composeWith(NEW_TOKEN) }, plan);
    expect(outcome.status).toBe('done');
    expect(fs.existsSync(path.join(real, 'compose.yaml'))).toBe(true);
  });

  it('refuses, through the key step, a keyring directory that became a link after the plan was approved', async () => {
    const keyrings = path.join(root, 'keyrings');
    const decoy = path.join(root, 'decoy');
    fs.mkdirSync(keyrings, { mode: 0o755 });
    fs.mkdirSync(decoy, { mode: 0o755 });
    const racing = localSession({
      beforeWrite: () => {
        fs.renameSync(keyrings, `${keyrings}.moved`);
        fs.symlinkSync(decoy, keyrings);
      },
    });
    const failure = await failureOf(() => runPlanStep(keyStep(path.join(keyrings, 'docker.asc')), context(racing), PLAN));
    expect(failure).toMatchObject({ code: 'DIRECTORY_CHANGED', changedNothing: true });
    expect(fs.readdirSync(decoy)).toEqual([]);
  });

  describe('directories', () => {
    const dirSpec = { mode: '0700', owner, group };

    it('creates nothing below an ancestor replaced by a link before the script started', () => {
      const parent = path.join(root, 'srv');
      const decoy = path.join(root, 'decoy');
      fs.mkdirSync(parent, { mode: 0o755 });
      fs.mkdirSync(decoy, { mode: 0o755 });
      const command = directoryCommand(path.join(parent, 'a', 'agent'), dirSpec, { sudo: false, allowExisting: false });
      fs.renameSync(parent, `${parent}.moved`);
      fs.symlinkSync(decoy, parent);
      const result = runShell(command);
      expect(result.status).toBe(WRITE_EXIT.notDirectory);
      expect(fs.readdirSync(decoy)).toEqual([]);
      expect(modeOf(decoy)).toBe('755');
    });

    it('changes nothing in an existing directory (the apt keyrings) replaced by a link before the script started', () => {
      const keyrings = path.join(root, 'keyrings');
      const decoy = path.join(root, 'decoy');
      fs.mkdirSync(keyrings, { mode: 0o700 });
      fs.mkdirSync(decoy, { mode: 0o700 });
      const command = directoryCommand(keyrings, { mode: '0755', owner, group }, { sudo: false, allowExisting: true });
      fs.renameSync(keyrings, `${keyrings}.moved`);
      fs.symlinkSync(decoy, keyrings);
      expect(runShell(command).status).toBe(WRITE_EXIT.exists);
      expect(modeOf(decoy)).toBe('700');
      // A real directory put back at the name is accepted only when it resolves to the approved path; with another approved path it is refused.
      fs.unlinkSync(keyrings);
      fs.mkdirSync(keyrings, { mode: 0o700 });
      const moved = directoryCommand(keyrings, { mode: '0755', owner, group }, { sudo: false, allowExisting: true, approved: path.join(root, 'elsewhere') });
      expect(runShell(moved).status).toBe(WRITE_EXIT.notDirectory);
      expect(modeOf(keyrings)).toBe('700');
    });

    it('refuses when the approved path is not where the directory would be made', () => {
      const parent = path.join(root, 'srv');
      fs.mkdirSync(parent, { mode: 0o755 });
      const command = directoryCommand(path.join(parent, 'agent'), dirSpec, { sudo: false, allowExisting: false, approved: path.join(root, 'elsewhere', 'agent') });
      expect(runShell(command).status).toBe(WRITE_EXIT.notDirectory);
      expect(fs.readdirSync(parent)).toEqual([]);
    });

    it('creates the directory under a link the plan disclosed, at the path it approved', () => {
      const real = path.join(root, 'real');
      fs.mkdirSync(real, { mode: 0o755 });
      fs.symlinkSync(real, path.join(root, 'link'));
      const target = path.join(root, 'link', 'a', 'agent');
      const command = directoryCommand(target, dirSpec, { sudo: false, allowExisting: false });
      expect(runShell(command).status).toBe(0);
      expect(modeOf(path.join(real, 'a', 'agent'))).toBe('700');
    });

    /**
     * An `mv` that, just before it moves the staged directory into place, runs
     * `create` from the staging directory (so `../` is the directory the final
     * name is in): the gap in which another process could take the final name.
     */
    function occupyBeforeMove(create: string): { PATH: string } {
      const dir = path.join(root, 'shim-occupy');
      fs.mkdirSync(dir);
      const real = execFileSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).trim();
      fs.writeFileSync(path.join(dir, 'mv'), ['#!/bin/sh', `case "$*" in -nT*) ${create} ;; esac`, `exec "${real}" "$@"`].join('\n'), { mode: 0o755 });
      return { PATH: `${dir}:${process.env.PATH ?? ''}` };
    }

    const stagingLeft = (parent: string) => fs.readdirSync(parent).filter((name) => name.startsWith('.sencho-new'));

    it.each([
      ['an empty directory of the same owner in mode 0700 (the one a mode heuristic cannot tell from the new one)', 'mkdir -m 0700 ../agent', '700', []],
      ['an empty directory in mode 0755', 'mkdir -m 0755 ../agent', '755', []],
      ['a directory with operator data', 'mkdir -m 0700 ../agent && printf operator > ../agent/keep', '700', ['keep']],
    ])('leaves %s put at the new name in the last moment exactly as it was', (_label, create, mode, entries) => {
      const parent = path.join(root, 'srv');
      fs.mkdirSync(parent, { mode: 0o755 });
      const result = runShell(directoryCommand(path.join(parent, 'agent'), dirSpec, { sudo: false, allowExisting: false }), '', occupyBeforeMove(create));
      expect(result.status).toBe(WRITE_EXIT.exists);
      expect(modeOf(path.join(parent, 'agent'))).toBe(mode);
      expect(fs.readdirSync(path.join(parent, 'agent'))).toEqual(entries);
      if (entries.includes('keep')) expect(fs.readFileSync(path.join(parent, 'agent', 'keep'), 'utf8')).toBe('operator');
      expect(stagingLeft(parent)).toEqual([]);
    });

    it('leaves a symlink put at the new name in the last moment, and what it points to, alone', () => {
      const parent = path.join(root, 'srv');
      fs.mkdirSync(parent, { mode: 0o755 });
      const unrelated = path.join(root, 'unrelated');
      fs.mkdirSync(unrelated, { mode: 0o755 });
      const result = runShell(directoryCommand(path.join(parent, 'agent'), dirSpec, { sudo: false, allowExisting: false }), '', occupyBeforeMove(`ln -s "${unrelated}" ../agent`));
      expect(result.status).toBe(WRITE_EXIT.exists);
      expect(modeOf(unrelated)).toBe('755');
      expect(fs.readdirSync(unrelated)).toEqual([]);
      expect(stagingLeft(parent)).toEqual([]);
    });

    it('leaves a directory that took the place of the topmost parent alone, and creates nothing below it', () => {
      const base = path.join(root, 'srv');
      fs.mkdirSync(base, { mode: 0o755 });
      const result = runShell(directoryCommand(path.join(base, 'mid', 'agent'), dirSpec, { sudo: false, allowExisting: false }), '', occupyBeforeMove('mkdir -m 0700 ../mid && mkdir ../mid/inner'));
      expect(result.status).toBe(WRITE_EXIT.exists);
      expect(fs.readdirSync(path.join(base, 'mid'))).toEqual(['inner']);
      expect(fs.readdirSync(path.join(base, 'mid', 'inner'))).toEqual([]);
      expect(modeOf(path.join(base, 'mid'))).toBe('700');
      expect(stagingLeft(base)).toEqual([]);
    });

    it('is not fooled by a directory swapped in for the staging directory, and changes nothing in it', () => {
      const parent = path.join(root, 'srv');
      fs.mkdirSync(parent, { mode: 0o755 });
      const shims = path.join(root, 'shim-stage');
      fs.mkdirSync(shims);
      const realStat = execFileSync('sh', ['-c', 'command -v stat'], { encoding: 'utf8' }).trim();
      const done = path.join(shims, 'done');
      // After the first look at the staging directory's identity, another directory takes its name.
      fs.writeFileSync(path.join(shims, 'stat'), [
        '#!/bin/sh',
        `"${realStat}" "$@"; rc=$?`,
        'for a; do last=$a; done',
        `case "$last" in ./.sencho-new.*) if [ ! -e "${done}" ]; then : > "${done}"; mv "$last" "$last.aside" && mkdir -m 0700 "$last" && printf operator > "$last/keep"; fi ;; esac`,
        'exit $rc',
      ].join('\n'), { mode: 0o755 });
      const result = runShell(directoryCommand(path.join(parent, 'agent'), dirSpec, { sudo: false, allowExisting: false }), '', { PATH: `${shims}:${process.env.PATH ?? ''}` });
      expect(result.status).toBe(WRITE_EXIT.unfinished);
      expect(fs.existsSync(path.join(parent, 'agent'))).toBe(false);
      const substitute = fs.readdirSync(parent).find((name) => name.startsWith('.sencho-new') && !name.endsWith('.aside'));
      expect(substitute).toBeDefined();
      expect(fs.readdirSync(path.join(parent, substitute as string))).toEqual(['keep']);
      expect(modeOf(path.join(parent, substitute as string))).toBe('700');
    });

    it('creates a directory under a setgid parent, which hands its bit on', () => {
      const parent = path.join(root, 'srv');
      fs.mkdirSync(parent, { mode: 0o755 });
      fs.chmodSync(parent, 0o2755);
      const target = path.join(parent, 'agent');
      expect(runShell(directoryCommand(target, dirSpec, { sudo: false, allowExisting: false })).status).toBe(0);
      expect(fs.statSync(target).isDirectory()).toBe(true);
      expect(modeOf(target)).toBe('700');
    });

    /** What a default ACL on the parent does: a directory is made in a mode the umask did not choose. */
    function aclParent(): { PATH: string } {
      const dir = path.join(root, 'shim-acl');
      fs.mkdirSync(dir);
      const realMkdir = execFileSync('sh', ['-c', 'command -v mkdir'], { encoding: 'utf8' }).trim();
      fs.writeFileSync(path.join(dir, 'mkdir'), ['#!/bin/sh', `"${realMkdir}" "$@"; rc=$?`, 'for a; do last=$a; done', 'chmod 0755 "$last" 2>/dev/null', 'exit $rc'].join('\n'), { mode: 0o755 });
      return { PATH: `${dir}:${process.env.PATH ?? ''}` };
    }

    it('gives the directory the planned mode whatever mode mkdir made it in (a parent with an ACL)', () => {
      const parent = path.join(root, 'srv');
      fs.mkdirSync(parent, { mode: 0o755 });
      const target = path.join(parent, 'agent');
      expect(runShell(directoryCommand(target, dirSpec, { sudo: false, allowExisting: false }), '', aclParent()).status).toBe(0);
      expect(modeOf(target)).toBe('700');
    });

    it('removes its staging directory, and makes nothing at the final name, when a stop lands while it builds', () => {
      const parent = path.join(root, 'srv');
      fs.mkdirSync(parent, { mode: 0o755 });
      const dir = path.join(root, 'shim-stop');
      fs.mkdirSync(dir);
      const realMkdir = execFileSync('sh', ['-c', 'command -v mkdir'], { encoding: 'utf8' }).trim();
      // The shell that called mkdir is stopped right after the first directory inside the staging directory was made.
      fs.writeFileSync(path.join(dir, 'mkdir'), ['#!/bin/sh', `"${realMkdir}" "$@"; rc=$?`, 'case "$*" in "-- ./a") kill -TERM $PPID ;; esac', 'exit $rc'].join('\n'), { mode: 0o755 });
      const result = runShell(directoryCommand(path.join(parent, 'a', 'agent'), dirSpec, { sudo: false, allowExisting: false }), '', { PATH: `${dir}:${process.env.PATH ?? ''}` });
      expect(result.status).not.toBe(0);
      expect(fs.readdirSync(parent)).toEqual([]);
    });

    /** Shims for the commands the directory script runs, each running the real one and then `action` (a shell snippet), on the first call whose arguments match. */
    function shimmed(name: string, match: string, action: string, order: 'after' | 'before' = 'after'): NodeJS.ProcessEnv {
      const dir = path.join(root, `shim-${name}`);
      fs.mkdirSync(dir, { recursive: true });
      const real = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
      // The shim may run under a command substitution or a pipeline (a forked copy of the shell): the shell to stop is the topmost one that is running the script.
      const killMain = 'killmain() { m=; p=$PPID; while [ -n "$p" ] && [ "$p" -gt 1 ]; do if tr "\\0" "\\n" < /proc/$p/cmdline | grep -qx "set -eu"; then m=$p; fi; p=$(awk \'/^PPid/ { print $2 }\' /proc/$p/status); done; kill -TERM "$m"; }';
      fs.writeFileSync(path.join(dir, name), [
        '#!/bin/sh',
        killMain,
        `hit() { case "$*" in ${match}) [ ! -e "${dir}/hit" ] && : > "${dir}/hit" ;; *) return 1 ;; esac; }`,
        `if hit "$@" && [ "${order}" = before ]; then ${action}; fi`,
        `"${real}" "$@"; rc=$?`,
        `if [ -e "${dir}/hit" ] && [ ! -e "${dir}/done" ] && [ "${order}" = after ]; then : > "${dir}/done"; ${action}; fi`,
        'exit $rc',
      ].join('\n'), { mode: 0o755 });
      return { PATH: `${dir}:${process.env.PATH ?? ''}` };
    }

    it('removes its staging directory when a stop lands right after mktemp made it, before its identity was read', () => {
      const parent = path.join(root, 'srv');
      fs.mkdirSync(parent, { mode: 0o755 });
      const env = shimmed('mktemp', '*sencho-new*', 'killmain');
      const result = runShell(directoryCommand(path.join(parent, 'agent'), dirSpec, { sudo: false, allowExisting: false }), '', env);
      expect(result.status).toBe(1);
      expect(fs.readdirSync(parent)).toEqual([]);
    });

    it('removes its staging directory when a stop lands after the shell entered it, before it was recorded as entered', () => {
      const parent = path.join(root, 'srv');
      fs.mkdirSync(parent, { mode: 0o755 });
      // `stat -- ..` is the check that the staging directory sits in the directory held above it, right after the entry.
      const env = shimmed('stat', '*"-- .."*', 'killmain');
      const result = runShell(directoryCommand(path.join(parent, 'agent'), dirSpec, { sudo: false, allowExisting: false }), '', env);
      expect(result.status).toBe(1);
      expect(fs.readdirSync(parent)).toEqual([]);
    });

    it('still removes its staging directory when a second stop lands during the cleanup', () => {
      const parent = path.join(root, 'srv');
      fs.mkdirSync(parent, { mode: 0o755 });
      const first = shimmed('mkdir', '"-- ./agent"', 'killmain');
      // The cleanup's first rmdir is stopped again: the signals are ignored while it runs.
      const second = shimmed('rmdir', '*agent*', 'killmain');
      const result = runShell(directoryCommand(path.join(parent, 'agent'), dirSpec, { sudo: false, allowExisting: false }), '', { PATH: `${first.PATH?.split(':')[0]}:${second.PATH}` });
      expect(result.status).toBe(1);
      expect(fs.readdirSync(parent)).toEqual([]);
    });

    it('says the directory could not be put in place, and creates nothing, when the rename itself is refused', () => {
      const parent = path.join(root, 'srv');
      fs.mkdirSync(parent, { mode: 0o755 });
      const dir = path.join(root, 'shim-refuse');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'mv'), ['#!/bin/sh', 'echo "mv: Permission denied" >&2', 'exit 1'].join('\n'), { mode: 0o755 });
      const result = runShell(directoryCommand(path.join(parent, 'agent'), dirSpec, { sudo: false, allowExisting: false }), '', { PATH: `${dir}:${process.env.PATH ?? ''}` });
      expect(result.status).toBe(WRITE_EXIT.notCreated);
      expect(result.stderr).toContain('could not put it in place');
      expect(result.stderr).not.toContain('already exists');
      expect(fs.readdirSync(parent)).toEqual([]);
    });

    it('refuses, and reports nothing as made, when the directory it moved into place is swapped at once', () => {
      const parent = path.join(root, 'srv');
      fs.mkdirSync(parent, { mode: 0o755 });
      // Right after the real move, another directory (with operator data) takes the name.
      const env = shimmed('mv', '*-nT*', `mv ../agent ../agent.gone && mkdir ../agent && printf keep > ../agent/operator-data`);
      const result = runShell(directoryCommand(path.join(parent, 'agent'), dirSpec, { sudo: false, allowExisting: false }), '', env);
      expect(result.status).toBe(WRITE_EXIT.unfinished);
      expect(result.stdout).not.toContain('SENCHO_DIR_MADE');
      expect(fs.readFileSync(path.join(parent, 'agent', 'operator-data'), 'utf8')).toBe('keep');
    });

    it('refuses, and creates nothing at the final name, when the staging directory was moved out of the held directory', () => {
      const parent = path.join(root, 'srv');
      const elsewhere = path.join(root, 'elsewhere');
      fs.mkdirSync(parent, { mode: 0o755 });
      fs.mkdirSync(elsewhere, { mode: 0o755 });
      // The staging directory is renamed into another directory before the move; its `..` is no longer the held one.
      const env = shimmed('chmod', '"0700 -- ./agent"', `mv "$(pwd -P)" "${elsewhere}/stage"`);
      const result = runShell(directoryCommand(path.join(parent, 'agent'), dirSpec, { sudo: false, allowExisting: false }), '', env);
      expect(result.status).toBe(WRITE_EXIT.unfinished);
      expect(fs.existsSync(path.join(parent, 'agent'))).toBe(false);
      expect(fs.existsSync(path.join(elsewhere, 'agent'))).toBe(false);
    });

    it('still finishes a directory it made itself', () => {
      const target = path.join(root, 'srv', 'agent');
      expect(runShell(directoryCommand(target, dirSpec, { sudo: false, allowExisting: false })).status).toBe(0);
      expect(modeOf(target)).toBe('700');
    });
  });
});

/**
 * A `mv` that does its move and then, when the move put something aside (the
 * `-fT` one; the script's own restore uses `-nT` and is left alone), puts
 * something else at the original name and stops the shell that called it, as a
 * dropped session does: the stop lands after the rename and before the script
 * has recorded what it moved.
 */
function stopAfterRename(base: string, name: string, conflict: 'file' | 'symlink' | 'directory', signal = 'TERM'): { PATH: string } {
  const dir = path.join(base, `stop-${conflict}-${signal}`);
  fs.mkdirSync(dir);
  const real = execFileSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).trim();
  const create = {
    file: `printf theirs > ./${name}`,
    symlink: `ln -s /nonexistent-target ./${name}`,
    directory: `mkdir ./${name} && printf theirs > ./${name}/inside`,
  }[conflict];
  fs.writeFileSync(path.join(dir, 'mv'), [
    '#!/bin/sh',
    `"${real}" "$@"; rc=$?`,
    `case "$*" in -fT*.old.*) ${create}; kill -${signal} $PPID ;; esac`,
    'exit $rc',
  ].join('\n'), { mode: 0o755 });
  return { PATH: `${dir}:${process.env.PATH ?? ''}` };
}

describe('B3: a stop right after the rename never deletes what was moved aside', () => {
  const edit = 'operator edit made after the file was read';
  const cases = WRITER_NAMES
    .filter(([, name]) => name === 'compose.yaml' || name === 'docker.asc')
    .flatMap(([label, name, mode]) => (['file', 'symlink', 'directory'] as const).map((conflict) => [label, name, conflict, mode] as const));

  it.each(cases)('keeps the edit made to %s (%s) when a %s appears at its name', (_label, name, conflict, mode) => {
    const target = path.join(root, name);
    fs.writeFileSync(target, edit, { mode: 0o640 });
    const env = stopAfterRename(root, name, conflict);
    // The run inspected an earlier version, so the edit is not the file it may replace.
    const command = writeCommand(target, { mode, owner, group, sha256: sha256('new') }, { sudo: false, replaces: sha256('what was read') });
    const result = runShell(command, 'new', env);
    expect(result.status).not.toBe(0);
    const kept = fs.readdirSync(root).filter((entry) => entry.startsWith(`.${name}.old.`));
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, kept[0]), 'utf8')).toBe(edit);
    expect(modeOf(path.join(root, kept[0]))).toBe('640');
    expect(result.stderr).toContain(`kept as ${root}/${kept[0]}`);
    // What appeared at the name is left as it is, and the temporary file with the new content is gone.
    if (conflict === 'file') expect(fs.readFileSync(target, 'utf8')).toBe('theirs');
    if (conflict === 'symlink') expect(fs.readlinkSync(target)).toBe('/nonexistent-target');
    if (conflict === 'directory') expect(fs.readFileSync(path.join(target, 'inside'), 'utf8')).toBe('theirs');
    expect(fs.readdirSync(root).filter((entry) => !entry.startsWith('stop-') && entry !== name && entry !== kept[0])).toEqual([]);
  });

  it.each(['HUP', 'INT', 'TERM'])('keeps it on SIG%s too', (signal) => {
    const target = path.join(root, 'compose.yaml');
    fs.writeFileSync(target, edit, { mode: 0o640 });
    const env = stopAfterRename(root, 'compose.yaml', 'file', signal);
    const result = runShell(writeCommand(target, { ...file, sha256: sha256('new') }, { sudo: false, replaces: sha256('what was read') }), 'new', env);
    expect(result.status).not.toBe(0);
    const kept = fs.readdirSync(root).filter((entry) => entry.startsWith('.compose.yaml.old.'));
    expect(kept.map((entry) => fs.readFileSync(path.join(root, entry), 'utf8'))).toEqual([edit]);
  });

  it('puts the original back when nothing took its name, and keeps no stray copy', () => {
    const target = path.join(root, 'compose.yaml');
    fs.writeFileSync(target, edit, { mode: 0o640 });
    const dir = path.join(root, 'stop-only');
    fs.mkdirSync(dir);
    const real = execFileSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(dir, 'mv'), ['#!/bin/sh', `"${real}" "$@"; rc=$?`, 'case "$*" in -fT*.old.*) kill -TERM $PPID ;; esac', 'exit $rc'].join('\n'), { mode: 0o755 });
    const result = runShell(writeCommand(target, { ...file, sha256: sha256('new') }, { sudo: false, replaces: sha256('what was read') }), 'new', { PATH: `${dir}:${process.env.PATH ?? ''}` });
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe(edit);
    expect(fs.readdirSync(root).filter((entry) => entry !== 'stop-only')).toEqual(['compose.yaml']);
  });

  it('keeps the file it was told to replace, under its slot name, when a stop and a new file at the name meet', () => {
    const target = path.join(root, 'compose.yaml');
    const previous = 'old compose with a spent token';
    fs.writeFileSync(target, previous, { mode: 0o600 });
    const env = stopAfterRename(root, 'compose.yaml', 'file');
    const result = runShell(writeCommand(target, { ...file, sha256: sha256('new') }, { sudo: false, replaces: sha256(previous) }), 'new', env);
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe('theirs');
    const kept = fs.readdirSync(root).filter((entry) => entry.startsWith('.compose.yaml.old.'));
    expect(kept.map((entry) => fs.readFileSync(path.join(root, entry), 'utf8'))).toEqual([previous]);
  });
});

describe('B1: approvedDirectory names the directory each file is written into', () => {
  const plan = {
    paths: {
      composeDir: { input: '/opt/docker/sencho', realPath: '/mnt/vol/sencho' },
      agentDir: { input: '/opt/sencho-agent', realPath: '/data/agent' },
    },
  } as unknown as BootstrapPlan;

  it('gives the resolved path of the Agent and Compose directories, with or without a trailing slash', () => {
    expect(approvedDirectory(plan, '/opt/sencho-agent')).toBe('/data/agent');
    expect(approvedDirectory(plan, '/opt/sencho-agent/')).toBe('/data/agent');
    expect(approvedDirectory(plan, '/opt/docker/sencho')).toBe('/mnt/vol/sencho');
  });

  it('gives the literal path of any other directory (the apt directories must not be links)', () => {
    expect(approvedDirectory(plan, '/etc/apt/keyrings')).toBe('/etc/apt/keyrings');
    expect(approvedDirectory(plan, '/etc/apt/sources.list.d')).toBe('/etc/apt/sources.list.d');
    expect(approvedDirectory(plan, '/')).toBe('/');
  });

  it('falls back to the input when the preflight recorded no resolved path', () => {
    const unresolved = { paths: { composeDir: { input: '/opt/docker/sencho', realPath: null }, agentDir: { input: '/opt/sencho-agent', realPath: null } } } as unknown as BootstrapPlan;
    expect(approvedDirectory(unresolved, '/opt/sencho-agent')).toBe('/opt/sencho-agent');
  });
});

describe('B3: a stop before the rename, and a second stop during the cleanup', () => {
  const edit = 'operator edit made after the file was read';

  it('leaves the original at its name, and no slot, when the stop lands before the rename ran', () => {
    const target = path.join(root, 'compose.yaml');
    fs.writeFileSync(target, edit, { mode: 0o640 });
    const dir = path.join(root, 'stop-before');
    fs.mkdirSync(dir);
    // The shim stops the shell and exits without moving anything.
    fs.writeFileSync(path.join(dir, 'mv'), ['#!/bin/sh', 'case "$*" in -fT*.old.*) kill -TERM $PPID; exit 1 ;; esac', `exec "${execFileSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).trim()}" "$@"`].join('\n'), { mode: 0o755 });
    const result = runShell(writeCommand(target, { ...file, sha256: sha256('new') }, { sudo: false, replaces: sha256('what was read') }), 'new', { PATH: `${dir}:${process.env.PATH ?? ''}` });
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe(edit);
    expect(modeOf(target)).toBe('640');
    expect(fs.readdirSync(root).filter((entry) => entry !== 'stop-before')).toEqual(['compose.yaml']);
  });

  it('finishes putting the original back when a second stop lands while it is being put back', () => {
    const target = path.join(root, 'compose.yaml');
    fs.writeFileSync(target, edit, { mode: 0o640 });
    // No entry takes the name: the first stop alone is undone, and a second one lands during that.
    const stopOnly = path.join(root, 'stop-only');
    fs.mkdirSync(stopOnly);
    const realMv = execFileSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(stopOnly, 'mv'), ['#!/bin/sh', `"${realMv}" "$@"; rc=$?`, 'case "$*" in -fT*.old.*) kill -TERM $PPID ;; esac', 'exit $rc'].join('\n'), { mode: 0o755 });
    const second = signalingShim(root, 'ln', '*.old.*');
    const result = runShell(writeCommand(target, { ...file, sha256: sha256('new') }, { sudo: false, replaces: sha256('what was read') }), 'new', { PATH: `${stopOnly}:${second.PATH}` });
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe(edit);
    expect(fs.readdirSync(root).filter((entry) => !entry.startsWith('stop-') && !entry.startsWith('signal-'))).toEqual(['compose.yaml']);
  });
});

/**
 * A real directory put at an approved name is not a symlink and has the same
 * physical path, owner and mode as the approved one, so only the identity the
 * approval recorded (device, inode, owner and creation time) can tell it apart.
 */
describe('B1: a real directory put at the approved name is neither written, changed nor entered', () => {
  const dirSpec = { mode: '0700', owner, group };

  /** The approved directory is moved aside and an unrelated real directory, with data of the operator's, takes its name. */
  function substitute(dir: string): void {
    fs.renameSync(dir, `${dir}.approved`);
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'operator-data'), 'keep me', { mode: 0o644 });
  }

  function expectUntouched(dir: string): void {
    expect(fs.readdirSync(dir)).toEqual(['operator-data']);
    expect(fs.readFileSync(path.join(dir, 'operator-data'), 'utf8')).toBe('keep me');
    expect(modeOf(dir)).toBe('700');
    expect(modeOf(path.join(dir, 'operator-data'))).toBe('644');
  }

  it.each(WRITER_NAMES)('refuses to write %s into a substituted directory', (_label, name, mode) => {
    const dir = path.join(root, 'agent');
    fs.mkdirSync(dir, { mode: 0o755 });
    const command = writeCommand(path.join(dir, name), { mode, owner, group, sha256: sha256('ours') }, { sudo: false, replaces: null });
    substitute(dir);
    const result = runShell(command, 'ours');
    expect(result.status).toBe(WRITE_EXIT.notDirectory);
    expectUntouched(dir);
    expect(fs.readdirSync(`${dir}.approved`)).toEqual([]);
  });

  it.each(WRITER_NAMES)('refuses to replace %s in a substituted directory, and keeps the file that is there', (_label, name, mode) => {
    const dir = path.join(root, 'agent');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, name), 'old', { mode: 0o600 });
    const command = writeCommand(path.join(dir, name), { mode, owner, group, sha256: sha256('new') }, { sudo: false, replaces: sha256('old') });
    substitute(dir);
    fs.writeFileSync(path.join(dir, name), 'old', { mode: 0o600 });
    const result = runShell(command, 'new');
    expect(result.status).toBe(WRITE_EXIT.notDirectory);
    expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe('old');
    expect(fs.readdirSync(dir).sort()).toEqual([name, 'operator-data'].sort());
  });

  it('refuses a directory substituted while the script waits for its content', async () => {
    const dir = path.join(root, 'agent');
    fs.mkdirSync(dir, { mode: 0o755 });
    const shim = shimDir(root, `mv "${dir}" "${dir}.approved" && mkdir -m 0700 "${dir}" && printf 'keep me' > "${dir}/operator-data"`);
    const result = runShell(writeCommand(path.join(dir, 'compose.yaml'), { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null }), 'ours', shim.env);
    expect(result.status).toBe(WRITE_EXIT.notDirectory);
    expect(fs.readdirSync(dir)).toEqual(['operator-data']);
  });

  it('refuses to change an existing directory that is not the approved one (the mode of a private directory is not widened)', () => {
    const dir = path.join(root, 'keyrings');
    fs.mkdirSync(dir, { mode: 0o700 });
    const command = directoryCommand(dir, { mode: '0755', owner, group }, { sudo: false, allowExisting: true });
    substitute(dir);
    expect(runShell(command).status).toBe(WRITE_EXIT.notDirectory);
    expectUntouched(dir);
  });

  it('accepts the approved existing directory and changes its mode', () => {
    const dir = path.join(root, 'keyrings');
    fs.mkdirSync(dir, { mode: 0o700 });
    const result = runShell(directoryCommand(dir, { mode: '0755', owner, group }, { sudo: false, allowExisting: true }));
    expect(result.status).toBe(0);
    expect(modeOf(dir)).toBe('755');
  });

  it('reports the identity and path of every directory it made, the parents included', () => {
    const parent = path.join(root, 'srv');
    fs.mkdirSync(parent, { mode: 0o755 });
    const target = path.join(parent, 'a', 'b', 'agent');
    const result = runShell(directoryCommand(target, dirSpec, { sudo: false, allowExisting: false }));
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n');
    const real = fs.realpathSync(parent);
    expect(lines).toEqual([
      `SENCHO_DIR_MADE=${identityOf(path.join(parent, 'a'))}\t${path.join(real, 'a')}`,
      `SENCHO_DIR_MADE=${identityOf(path.join(parent, 'a', 'b'))}\t${path.join(real, 'a', 'b')}`,
      `SENCHO_DIR_MADE=${identityOf(target)}\t${path.join(real, 'a', 'b', 'agent')}`,
    ]);
  });

  it('reports the owner the directory has once it was handed over, so a later write into it is bound to what it is', () => {
    // Under sudo the script makes the directory as root and chowns it to the planned owner, which changes the
    // owner field of its identity. `chown` and `stat` shims stand in for that: after a chown, `stat` reports another owner.
    const shims = path.join(root, 'owner-shims');
    fs.mkdirSync(shims);
    const handed = path.join(shims, 'handed-over');
    fs.writeFileSync(path.join(shims, 'chown'), ['#!/bin/sh', 'for a; do :; done', `"${REAL_STAT}" -c %i -- "$a" >> "${handed}"`, 'exit 0'].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(shims, 'stat'), [
      '#!/bin/sh',
      `out=$("${REAL_STAT}" "$@") || exit $?`,
      `if [ "$2" = "%d:%i:%u:%w" ] && grep -qx "$("${REAL_STAT}" -c %i -- "$4")" "${handed}" 2>/dev/null; then`,
      `  printf '%s\\n' "$out" | awk -F: 'BEGIN { OFS = ":" } { $3 = "4242"; print }'`,
      'else printf \'%s\\n\' "$out"; fi',
    ].join('\n'), { mode: 0o755 });
    const env = { PATH: `${shims}:${process.env.PATH ?? ''}` };
    const parent = path.join(root, 'srv');
    fs.mkdirSync(parent, { mode: 0o755 });
    const target = path.join(parent, 'agent');
    const made = runShell(directoryCommand(target, dirSpec, { sudo: false, allowExisting: false }), madeDirectoriesInput(new Map()), env);
    expect(made.status).toBe(0);
    const [identity, madePath] = made.stdout.trim().split('\n').pop()!.slice('SENCHO_DIR_MADE='.length).split('\t');
    expect(identity.split(':')[2]).toBe('4242');
    const written = runShell(writeCommand(path.join(target, 'compose.yaml'), { mode: '0600', owner, group, sha256: sha256('ours') }, { sudo: false, replaces: null, directory: madePath, binding: identity }), 'ours', env);
    expect(written.status).toBe(0);
    expect(fs.readFileSync(path.join(target, 'compose.yaml'), 'utf8')).toBe('ours');
  });

  it.each([
    ['one new directory', ['agent']],
    ['a directory below a new parent', ['a', 'agent']],
  ])('creates nothing in a substituted nearest existing ancestor (%s)', (_label, below) => {
    const parent = path.join(root, 'srv');
    fs.mkdirSync(parent, { mode: 0o755 });
    const command = directoryCommand(path.join(parent, ...below), dirSpec, { sudo: false, allowExisting: false });
    substitute(parent);
    expect(runShell(command).status).toBe(WRITE_EXIT.notDirectory);
    expectUntouched(parent);
  });

  it('refuses a parent that appeared meanwhile, because it is not the ancestor the plan was bound to', () => {
    const parent = path.join(root, 'srv');
    fs.mkdirSync(parent, { mode: 0o755 });
    const command = directoryCommand(path.join(parent, 'mid', 'agent'), dirSpec, { sudo: false, allowExisting: false });
    fs.mkdirSync(path.join(parent, 'mid'), { mode: 0o700 });
    expect(runShell(command).status).toBe(WRITE_EXIT.notDirectory);
    expect(fs.readdirSync(path.join(parent, 'mid'))).toEqual([]);
    expect(modeOf(path.join(parent, 'mid'))).toBe('700');
  });

  describe('through the steps', () => {
    const composeDirIdentity = '64768:300:1000:2026-01-01';
    function planFor(dir: string, identity: string | null): BootstrapPlan {
      return { paths: { composeDir: { input: '/opt/docker/sencho', realPath: '/opt/docker/sencho', identity: composeDirIdentity }, agentDir: { input: dir, realPath: approvedPath(dir), identity } } } as unknown as BootstrapPlan;
    }
    const composeContext = (session: ExecSession): StepContext => ({ ...context(session, [NEW_TOKEN]), composeWithToken: () => composeWith(NEW_TOKEN) });

    function agentDirStep(dest: string): BootstrapPlanStep {
      return {
        id: 'create-agent-dir',
        title: 'Create the Agent installation directory',
        rationale: 'test',
        effect: 'directory-create',
        privilege: 'user',
        command: directoryCommand(dest, dirSpec, { sudo: false, allowExisting: false }),
        target: { path: dest, mode: '0700', owner, group, preserveExisting: false },
        disruptive: false,
        reversible: 'yes',
        pointOfNoReturn: false,
        timeoutMs: 10_000,
      };
    }

    it('binds every later write to the directory this run made, which the plan could not name', async () => {
      const dest = path.join(root, 'agent');
      const plan = planFor(dest, null);
      const ctx = composeContext(localSession());
      await runPlanStep(agentDirStep(dest), ctx, plan);
      expect(ctx.directories.get(approvedPath(dest))).toBe(approvedIdentity(dest));
      // The made directory is written into.
      expect((await runPlanStep(composeStep(path.join(dest, 'compose.yaml')), ctx, plan)).status).toBe('done');
      expect(fs.existsSync(path.join(dest, 'compose.yaml'))).toBe(true);
      // Another directory put at its name afterwards is not.
      fs.unlinkSync(path.join(dest, 'compose.yaml'));
      substitute(dest);
      const failure = await failureOf(() => runPlanStep(composeStep(path.join(dest, 'compose.yaml')), ctx, plan));
      expect(failure).toMatchObject({ kind: 'failed', code: 'DIRECTORY_CHANGED', changedNothing: true });
      expectUntouched(dest);
    });

    it('refuses to write into a Compose or Agent directory the plan holds no identity for, and writes nothing', async () => {
      const dest = path.join(root, 'agent');
      fs.mkdirSync(dest, { mode: 0o755 });
      const session = localSession();
      const failure = await failureOf(() => runPlanStep(composeStep(path.join(dest, 'compose.yaml')), composeContext(session), planFor(dest, null)));
      expect(failure).toMatchObject({ code: 'PLAN_INVALID', changedNothing: true });
      expect(session.commands.filter((command) => command.includes('sencho-write'))).toEqual([]);
      expect(fs.readdirSync(dest)).toEqual([]);
    });

    it('refuses to write into the agent directory when another directory took its name after the preflight', async () => {
      const dest = path.join(root, 'agent');
      fs.mkdirSync(dest, { mode: 0o755 });
      const plan = planFor(dest, approvedIdentity(dest));
      substitute(dest);
      const failure = await failureOf(() => runPlanStep(composeStep(path.join(dest, 'compose.yaml')), composeContext(localSession()), plan));
      expect(failure).toMatchObject({ kind: 'failed', code: 'DIRECTORY_CHANGED', changedNothing: true });
      expectUntouched(dest);
    });

    it('does not take a made directory on trust when the host did not say which one it is', async () => {
      const dest = path.join(root, 'agent');
      const session = scriptedSession(() => ({ exitCode: 0, stdout: '' }));
      const failure = await failureOf(() => runPlanStep(agentDirStep(dest), composeContext(session), planFor(dest, null)));
      expect(failure).toMatchObject({ kind: 'recovery', code: 'DIRECTORY_NOT_FINISHED' });
    });
  });
});

/**
 * The start script holds the approved directory and runs Compose against that,
 * never against the name it was approved under. Docker is a stub that records
 * where it ran and what it read.
 */
describe('B4: Compose starts only the approved project', () => {
  const COMPOSE_TEXT = composeWith(NEW_TOKEN);
  const CA_TEXT = '-----BEGIN CERTIFICATE-----\nMIIBhub\n-----END CERTIFICATE-----\n';
  const UNAPPROVED = 'services:\n  unapproved-workload:\n    image: evil\n';

  let agent: string;
  let stacks: string;
  let log: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    agent = path.join(root, 'srv', 'agent');
    stacks = path.join(root, 'stacks');
    log = path.join(root, 'docker.log');
    fs.mkdirSync(agent, { recursive: true, mode: 0o700 });
    fs.mkdirSync(stacks, { mode: 0o755 });
    fs.writeFileSync(path.join(agent, 'compose.yaml'), COMPOSE_TEXT, { mode: 0o600 });
    fs.writeFileSync(path.join(agent, 'sencho-hub-ca.pem'), CA_TEXT, { mode: 0o644 });
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    // Docker records its arguments, where it ran and the compose file it was pointed at; sudo only runs what it is given.
    fs.writeFileSync(path.join(bin, 'docker'), [
      '#!/bin/sh',
      `{ echo "args: $*"; echo "cwd: $(pwd -P)"; prev=; for a in "$@"; do [ "$prev" = -f ] && { echo "reads: $(cat "$a")"; }; prev=$a; done; } >> "${log}"`,
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'sudo'), ['#!/bin/sh', '[ "$1" = -n ] && shift', 'exec "$@"'].join('\n'), { mode: 0o755 });
    env = { PATH: `${bin}:${process.env.PATH ?? ''}` };
  });

  const identity = (dir: string) => approvedIdentity(dir);
  const dockerRuns = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('args:')).length : 0);

  function startStep(sudo: boolean, directories: { agent: string; stacks: string } = { agent, stacks }): BootstrapPlanStep {
    return {
      id: 'start-agent',
      title: 'Start the sencho-agent project',
      rationale: 'test',
      effect: 'container-start',
      privilege: sudo ? 'sudo' : 'user',
      command: startProjectCommand({ path: directories.agent, approved: approvedPath(directories.agent) }, { path: directories.stacks, approved: approvedPath(directories.stacks) }, sudo),
      disruptive: true,
      reversible: 'yes',
      pointOfNoReturn: true,
      timeoutMs: 10_000,
    };
  }

  function planOf(identities: { agent: string | null; stacks: string | null } = { agent: identity(agent), stacks: identity(stacks) }, withCa = true): BootstrapPlan {
    const caStep = { id: 'agent-hub-ca', file: { path: path.join(agent, 'sencho-hub-ca.pem'), mode: '0644', content: CA_TEXT, redacted: false } };
    return {
      paths: {
        composeDir: { input: stacks, realPath: approvedPath(stacks), identity: identities.stacks },
        agentDir: { input: agent, realPath: approvedPath(agent), identity: identities.agent },
      },
      stages: [{ id: 'agent_project', title: 'Agent files', steps: withCa ? [caStep] : [] }],
    } as unknown as BootstrapPlan;
  }

  const startContext = (): StepContext => ({ ...context(localSession({ env }), [NEW_TOKEN]), composeWithToken: () => COMPOSE_TEXT });

  it.each([[false], [true]])('runs Compose from the approved directory against the compose file in it (sudo: %s)', async (sudo) => {
    const outcome = await runPlanStep(startStep(sudo), startContext(), planOf());
    expect(outcome.status).toBe('done');
    expect(dockerRuns()).toBe(1);
    const recorded = fs.readFileSync(log, 'utf8');
    expect(recorded).toContain(`cwd: ${approvedPath(agent)}`);
    expect(recorded).toContain('--project-directory . -f ./compose.yaml up -d');
    expect(recorded).toContain(`reads: ${COMPOSE_TEXT.split('\n')[0]}`);
  });

  it('runs again the same way (a retried Start takes the same path)', async () => {
    const step = startStep(false);
    await runPlanStep(step, startContext(), planOf());
    await runPlanStep(step, startContext(), planOf());
    expect(dockerRuns()).toBe(2);
  });

  function swapAncestorForLink(): string {
    const parent = path.join(root, 'srv');
    const decoy = path.join(root, 'decoy');
    fs.mkdirSync(path.join(decoy, 'agent'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(decoy, 'agent', 'compose.yaml'), UNAPPROVED);
    fs.renameSync(parent, `${parent}.moved`);
    fs.symlinkSync(decoy, parent);
    return decoy;
  }

  function swapAgentForRealDirectory(): void {
    fs.renameSync(agent, `${agent}.approved`);
    fs.mkdirSync(agent, { mode: 0o700 });
    fs.writeFileSync(path.join(agent, 'compose.yaml'), UNAPPROVED);
  }

  it.each([[false], [true]])('hands nothing to Docker when an ancestor of the agent directory became a link to another project (sudo: %s)', async (sudo) => {
    const step = startStep(sudo);
    swapAncestorForLink();
    const failure = await failureOf(() => runPlanStep(step, startContext(), planOf()));
    expect(failure).toMatchObject({ kind: 'failed', code: 'DIRECTORY_CHANGED', changedNothing: true });
    expect(dockerRuns()).toBe(0);
  });

  it.each([[false], [true]])('hands nothing to Docker when another real directory took the agent directory\'s name (sudo: %s)', async (sudo) => {
    const step = startStep(sudo);
    const plan = planOf();
    swapAgentForRealDirectory();
    const failure = await failureOf(() => runPlanStep(step, startContext(), plan));
    expect(failure).toMatchObject({ kind: 'failed', code: 'DIRECTORY_CHANGED', changedNothing: true });
    expect(dockerRuns()).toBe(0);
  });

  it('reads the held directory, not the name, when the ancestor is swapped after the script entered it', async () => {
    const decoy = path.join(root, 'decoy');
    fs.mkdirSync(path.join(decoy, 'agent'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(decoy, 'agent', 'compose.yaml'), UNAPPROVED);
    const parent = path.join(root, 'srv');
    // The first hash the script takes is of the compose file, after it entered the directory: the swap lands there.
    const shims = path.join(root, 'shim-hash');
    fs.mkdirSync(shims);
    fs.writeFileSync(path.join(shims, 'sha256sum'), [
      '#!/bin/sh',
      `if [ ! -e "${shims}/done" ]; then : > "${shims}/done"; mv "${parent}" "${parent}.moved" && ln -s "${decoy}" "${parent}"; fi`,
      `exec "${REAL_SHA256SUM}" "$@"`,
    ].join('\n'), { mode: 0o755 });
    const session = localSession({ env: { PATH: `${shims}:${env.PATH}` } });
    const outcome = await runPlanStep(startStep(false), { ...context(session, [NEW_TOKEN]), composeWithToken: () => COMPOSE_TEXT }, planOf());
    expect(outcome.status).toBe('done');
    expect(fs.lstatSync(parent).isSymbolicLink()).toBe(true);
    const recorded = fs.readFileSync(log, 'utf8');
    expect(recorded).toContain(`reads: ${COMPOSE_TEXT.split('\n')[0]}`);
    expect(recorded).not.toContain('unapproved-workload');
  });

  it('hands nothing to Docker when the Compose directory it mounts is no longer the approved one', async () => {
    const step = startStep(false);
    const plan = planOf();
    fs.renameSync(stacks, `${stacks}.approved`);
    fs.mkdirSync(stacks, { mode: 0o755 });
    const failure = await failureOf(() => runPlanStep(step, startContext(), plan));
    expect(failure).toMatchObject({ code: 'DIRECTORY_CHANGED', changedNothing: true });
    expect(dockerRuns()).toBe(0);
  });

  it.each([
    ['compose.yaml has other content', () => fs.writeFileSync(path.join(agent, 'compose.yaml'), UNAPPROVED)],
    ['compose.yaml is a link', () => { fs.unlinkSync(path.join(agent, 'compose.yaml')); fs.writeFileSync(path.join(root, 'other.yaml'), COMPOSE_TEXT); fs.symlinkSync(path.join(root, 'other.yaml'), path.join(agent, 'compose.yaml')); }],
    ['the hub CA has other content', () => fs.writeFileSync(path.join(agent, 'sencho-hub-ca.pem'), 'not the CA')],
    ['the hub CA is gone', () => fs.unlinkSync(path.join(agent, 'sencho-hub-ca.pem'))],
  ])('hands nothing to Docker when %s', async (_label, tamper) => {
    const step = startStep(false);
    tamper();
    const failure = await failureOf(() => runPlanStep(step, startContext(), planOf()));
    expect(failure).toMatchObject({ kind: 'failed', code: 'FILE_CONFLICT', changedNothing: true });
    expect(dockerRuns()).toBe(0);
  });


  it('hands nothing to Docker when its input stops inside the last value (a dropped session must not read as "no hub CA")', async () => {
    const step = startStep(false);
    const full = startInput({ agentIdentity: identity(agent), composeIdentity: identity(stacks), composeSha256: sha256(COMPOSE_TEXT), caSha256: sha256('a different CA') });
    for (const cut of [full.length - 'end\n'.length, full.length - 'end\n'.length - 3, full.length - 1]) {
      const result = runShell(step.command as string, full.slice(0, cut), env);
      expect(result.status).toBe(START_EXIT.inputIncomplete);
    }
    expect(dockerRuns()).toBe(0);
  });

  it('hands nothing to Docker when the agent directory itself became a link to another project', async () => {
    const step = startStep(false);
    const plan = planOf();
    const decoy = path.join(root, 'decoy-agent');
    fs.mkdirSync(decoy, { mode: 0o700 });
    fs.writeFileSync(path.join(decoy, 'compose.yaml'), COMPOSE_TEXT);
    fs.writeFileSync(path.join(decoy, 'sencho-hub-ca.pem'), CA_TEXT);
    fs.renameSync(agent, `${agent}.approved`);
    fs.symlinkSync(decoy, agent);
    const failure = await failureOf(() => runPlanStep(step, startContext(), plan));
    expect(failure).toMatchObject({ kind: 'failed', code: 'DIRECTORY_CHANGED', changedNothing: true });
    expect(dockerRuns()).toBe(0);
  });

  /**
   * Docker opens compose.yaml, and the daemon the bind sources (the Compose
   * directory, the hub CA), by name after the script has checked them, and a
   * script cannot hold those names through Docker's own opening. A replacement
   * after a successful check needs somebody who can write in one of the places
   * those names are resolved in, so the script refuses to start where anyone but
   * root and the SSH user could: the Agent directory and everything above it,
   * everything above the Compose directory, and the two files.
   */
  describe('a place that anyone else could change is refused, because Docker opens it by name after the checks', () => {
    // The sudo shim only runs what it is given as the same user, so the root code path (`id -u` is 0, the SSH user is SUDO_UID) is entered through asRootFor.
    let elevated = false;
    beforeEach(() => { elevated = false; });
    const refusal = async (sudo: boolean, plan: BootstrapPlan = planOf()) => {
      if (sudo && !elevated) asRootFor(String(process.getuid?.() ?? 0));
      const before = dockerRuns();
      const failure = await failureOf(() => runPlanStep(startStep(sudo), startContext(), plan));
      expect(failure).toMatchObject({ kind: 'failed', code: 'CONTEXT_NOT_SEALED', changedNothing: true });
      expect(dockerRuns()).toBe(before);
    };
    /** `getent` answers for a group of this user's gid, with the members and the primary-group user the test names; a lookup of one account goes to the real one. */
    const REAL_GETENT = execFileSync('sh', ['-c', 'command -v getent'], { encoding: 'utf8' }).trim();
    const REAL_ID_FOR_GROUPS = execFileSync('sh', ['-c', 'command -v id'], { encoding: 'utf8' }).trim();
    const groupOf = (members: string, options: { primaryUid?: number; passwdFails?: boolean } = {}) => {
      const gid = process.getgid?.() ?? 0;
      // `stranger` is an account that is neither root nor this user, wherever the test runs; `ghost` is none at all.
      fs.writeFileSync(path.join(root, 'bin', 'id'), ['#!/bin/sh', '[ "$1 $2 $3" = "-u -- stranger" ] && { echo 54321; exit 0; }', '[ "$1 $2 $3" = "-u -- ghost" ] && exit 1', `exec "${REAL_ID_FOR_GROUPS}" "$@"`].join('\n'), { mode: 0o755 });
      fs.writeFileSync(path.join(root, 'bin', 'getent'), [
        '#!/bin/sh',
        `[ "$1" = group ] && { echo "shared:x:${gid}:${members}"; exit 0; }`,
        `if [ "$1" = passwd ] && [ -n "$2" ]; then exec "${REAL_GETENT}" passwd "$2"; fi`,
        options.passwdFails ? '[ "$1" = passwd ] && exit 2' : `[ "$1" = passwd ] && { ${options.primaryUid === undefined ? 'true' : `echo "someone:x:${options.primaryUid}:${gid}::/nonexistent:/bin/false"`}; echo "me:x:${process.getuid?.() ?? 0}:${gid}::/home/me:/bin/sh"; exit 0; }`,
        'exit 0',
      ].join('\n'), { mode: 0o755 });
    };
    const stacksBelow = (parent: string, mode: number) => {
      const shared = path.join(root, parent);
      fs.mkdirSync(shared, { mode: 0o755 });
      fs.renameSync(stacks, path.join(shared, 'stacks'));
      stacks = path.join(shared, 'stacks');
      fs.chmodSync(shared, mode);
      return shared;
    };

    it.each([[false], [true]])('refuses an Agent directory that others can write (sudo: %s)', async (sudo) => {
      fs.chmodSync(agent, 0o777);
      await refusal(sudo);
    });

    it.each([[false], [true]])('refuses a directory above the Agent directory that others can write (sudo: %s)', async (sudo) => {
      fs.chmodSync(path.join(root, 'srv'), 0o777);
      await refusal(sudo);
    });

    it.each([[false], [true]])('refuses a directory above the Compose directory that others can write (sudo: %s)', async (sudo) => {
      stacksBelow('shared', 0o777);
      await refusal(sudo);
    });

    it.each([[false], [true]])('refuses a compose file that others can write (sudo: %s)', async (sudo) => {
      fs.chmodSync(path.join(agent, 'compose.yaml'), 0o666);
      await refusal(sudo);
    });

    it.each([[false], [true]])('refuses a hub CA that others can write, but does not look at one the plan does not have (sudo: %s)', async (sudo) => {
      fs.chmodSync(path.join(agent, 'sencho-hub-ca.pem'), 0o666);
      await refusal(sudo);
      expect((await runPlanStep(startStep(sudo), startContext(), planOf(undefined, false))).status).toBe('done');
    });

    // Every place the start step relies on, on a retry that follows a start that succeeded, as the user and as root.
    const places: Array<[string, () => void]> = [
      ['the Agent directory', () => fs.chmodSync(agent, 0o777)],
      ['a directory above the Agent directory', () => fs.chmodSync(path.join(root, 'srv'), 0o777)],
      ['a directory above the Compose directory', () => { stacksBelow('shared', 0o777); }],
      ['compose.yaml', () => fs.chmodSync(path.join(agent, 'compose.yaml'), 0o666)],
      ['the hub CA', () => fs.chmodSync(path.join(agent, 'sencho-hub-ca.pem'), 0o666)],
    ];
    it.each(places.flatMap(([label, change]) => [[label, change, false], [label, change, true]] as const))('a retried start refuses %s once another user can change it (sudo: %s)', async (_label, change, sudo) => {
      if (sudo) asRootFor(String(process.getuid?.() ?? 0));
      expect((await runPlanStep(startStep(sudo), startContext(), planOf())).status).toBe('done');
      expect(dockerRuns()).toBe(1);
      change();
      const failure = await failureOf(() => runPlanStep(startStep(sudo), startContext(), planOf()));
      expect(failure).toMatchObject({ code: 'CONTEXT_NOT_SEALED', changedNothing: true });
      expect(dockerRuns()).toBe(1);
    });

    it.each([[false], [true]])('refuses a place others can write on a plan with no hub CA, for the Agent directory chain and the Compose directory chain (sudo: %s)', async (sudo) => {
      fs.unlinkSync(path.join(agent, 'sencho-hub-ca.pem'));
      fs.chmodSync(path.join(root, 'srv'), 0o777);
      await refusal(sudo, planOf(undefined, false));
      fs.chmodSync(path.join(root, 'srv'), 0o755);
      stacksBelow('shared', 0o777);
      await refusal(sudo, planOf(undefined, false));
    });

    it('names the directory it refused, on standard error', () => {
      const shared = stacksBelow('shared', 0o777);
      const result = runShell(startStep(false).command as string, startInput({ agentIdentity: identity(agent), composeIdentity: identity(stacks), composeSha256: sha256(COMPOSE_TEXT), caSha256: sha256(CA_TEXT) }), env);
      expect(result.status).toBe(START_EXIT.notSealed);
      expect(result.stderr).toContain(shared);
    });

    it('refuses on a retried start in the same way (the retry takes the same path)', async () => {
      const step = startStep(false);
      await runPlanStep(step, startContext(), planOf());
      expect(dockerRuns()).toBe(1);
      fs.chmodSync(path.join(root, 'srv'), 0o777);
      const failure = await failureOf(() => runPlanStep(step, startContext(), planOf()));
      expect(failure).toMatchObject({ code: 'CONTEXT_NOT_SEALED', changedNothing: true });
      expect(dockerRuns()).toBe(1);
    });

    it('accepts a group-writable directory whose group is this user\'s own and has no other member (a private group)', async () => {
      fs.chmodSync(agent, 0o770);
      groupOf('');
      expect((await runPlanStep(startStep(false), startContext(), planOf())).status).toBe('done');
      groupOf(os.userInfo().username);
      expect((await runPlanStep(startStep(false), startContext(), planOf())).status).toBe('done');
    });

    it('refuses a group-writable directory whose group has another member (listed, or by primary group) or whose lookup fails', async () => {
      fs.chmodSync(agent, 0o770);
      groupOf('stranger');
      await refusal(false);
      groupOf('', { primaryUid: 54321 });
      await refusal(false);
      groupOf('', { passwdFails: true });
      await refusal(false);
    });

    it('refuses a group-writable directory in a group that is not this user\'s own', async () => {
      const other = (process.getgroups?.() ?? []).find((candidate) => candidate !== process.getgid?.());
      if (other === undefined) return;
      fs.chmodSync(agent, 0o770);
      fs.chownSync(agent, process.getuid?.() ?? 0, other);
      groupOf('');
      await refusal(false);
    });

    it.each([[0o664], [0o620]])('refuses a compose file with group write permission (mode %o), and a hub CA with it', async (mode) => {
      fs.chmodSync(path.join(agent, 'compose.yaml'), mode);
      await refusal(false);
      fs.chmodSync(path.join(agent, 'compose.yaml'), 0o600);
      fs.chmodSync(path.join(agent, 'sencho-hub-ca.pem'), mode);
      await refusal(false);
    });

    /** `id -u` reports 0, as it does under sudo, and sudo says who it ran for in SUDO_UID. */
    const asRootFor = (sudoUid: string | undefined) => {
      const REAL_ID = execFileSync('sh', ['-c', 'command -v id'], { encoding: 'utf8' }).trim();
      fs.writeFileSync(path.join(root, 'bin', 'id'), ['#!/bin/sh', '[ "$*" = "-u" ] && { echo 0; exit 0; }', `exec "${REAL_ID}" "$@"`].join('\n'), { mode: 0o755 });
      if (sudoUid !== undefined) env = { ...env, SUDO_UID: sudoUid };
      elevated = true;
    };

    it('takes the user sudo ran for as the trusted account when the script runs as root (SUDO_UID), so the SSH user\'s own directories are accepted', async () => {
      asRootFor(String(process.getuid?.() ?? 0));
      expect((await runPlanStep(startStep(true), startContext(), planOf())).status).toBe('done');
    });

    it.each([['another user', '54321'], ['something that is not a number', 'root; rm -rf /'], ['nothing', undefined]])('does not trust the SSH user\'s directories as root when SUDO_UID is %s: root alone is trusted, and the user\'s own directory is not root\'s', async (_label, value) => {
      asRootFor(value);
      await refusal(true);
    });

    it('accepts the Agent directory this run made with the directory script, so a plan that created it is not refused at the start', async () => {
      const made = path.join(root, 'fresh', 'agent');
      fs.mkdirSync(path.join(root, 'fresh'), { mode: 0o755 });
      const command = directoryCommand(made, { mode: '0700', owner, group }, { sudo: false, allowExisting: false });
      const run = runShell(command, madeDirectoriesInput(new Map()));
      expect(run.status).toBe(0);
      fs.writeFileSync(path.join(made, 'compose.yaml'), COMPOSE_TEXT, { mode: 0o600 });
      agent = made;
      expect((await runPlanStep(startStep(false), startContext(), planOf(undefined, false))).status).toBe('done');
    });

    it('refuses a link in the Compose directory\'s name that someone else could repoint, though the directory it leads to is closed', async () => {
      // The compose file mounts the name as written: /<root>/holder/link/stacks. The holder directory decides who can change where "link" leads.
      const holder = path.join(root, 'holder');
      fs.mkdirSync(holder, { mode: 0o755 });
      fs.mkdirSync(path.join(root, 'data'), { mode: 0o755 });
      fs.renameSync(stacks, path.join(root, 'data', 'stacks'));
      fs.symlinkSync(path.join(root, 'data'), path.join(holder, 'link'));
      const named = path.join(holder, 'link', 'stacks');
      const step = startStep(false, { agent, stacks: named });
      const plan = { ...planOf({ agent: identity(agent), stacks: identity(path.join(root, 'data', 'stacks')) }), } as BootstrapPlan;
      (plan.paths.composeDir as { input: string; realPath: string }).input = named;
      (plan.paths.composeDir as { input: string; realPath: string }).realPath = approvedPath(named);
      expect((await runPlanStep(step, startContext(), plan)).status).toBe('done');
      fs.chmodSync(holder, 0o777);
      const failure = await failureOf(() => runPlanStep(step, startContext(), plan));
      expect(failure).toMatchObject({ code: 'CONTEXT_NOT_SEALED', changedNothing: true });
      expect(dockerRuns()).toBe(1);
    });

    // The Compose directory is named safe/alias/stacks; alias leads to open/hop, which leads to safe/real/stacks. Docker looks "hop" up in "open", which is on neither the physical path nor the name as written, so whoever can write in "open" can repoint the bind source after every check passed.
    describe('a place that only a link\'s target passes through (B4)', () => {
      const nested = (targets: 'absolute' | 'relative') => {
        const safe = path.join(root, 'safe');
        const open = path.join(root, 'open');
        fs.mkdirSync(path.join(safe, 'real'), { recursive: true, mode: 0o755 });
        fs.mkdirSync(open, { mode: 0o755 });
        fs.renameSync(stacks, path.join(safe, 'real', 'stacks'));
        const hop = targets === 'absolute' ? path.join(safe, 'real') : path.join('..', 'safe', 'real');
        const alias = targets === 'absolute' ? path.join(open, 'hop') : path.join('..', 'open', 'hop');
        fs.symlinkSync(hop, path.join(open, 'hop'));
        fs.symlinkSync(alias, path.join(safe, 'alias'));
        const named = path.join(safe, 'alias', 'stacks');
        const physical = path.join(safe, 'real', 'stacks');
        const plan = (withCa: boolean) => {
          const base = planOf({ agent: identity(agent), stacks: identity(physical) }, withCa) as unknown as { paths: { composeDir: { input: string; realPath: string } } };
          base.paths.composeDir.input = named;
          base.paths.composeDir.realPath = approvedPath(named);
          return base as unknown as BootstrapPlan;
        };
        return { open, named, plan, step: (sudo: boolean) => startStep(sudo, { agent, stacks: named }) };
      };
      const cases = (['absolute', 'relative'] as const).flatMap((targets) => [false, true].flatMap((sudo) => [true, false].map((withCa) => [targets, sudo, withCa] as const)));

      it.each(cases)('starts while every directory the name passes through is closed, and refuses once another user can change the one only a target passes through (%s targets, sudo: %s, hub CA: %s)', async (targets, sudo, withCa) => {
        const { open, plan, step } = nested(targets);
        if (sudo) asRootFor(String(process.getuid?.() ?? 0));
        if (!withCa) fs.unlinkSync(path.join(agent, 'sencho-hub-ca.pem'));
        expect((await runPlanStep(step(sudo), startContext(), plan(withCa))).status).toBe('done');
        expect(dockerRuns()).toBe(1);
        // A retried start, after the directory was opened.
        fs.chmodSync(open, 0o777);
        const retried = await failureOf(() => runPlanStep(step(sudo), startContext(), plan(withCa)));
        expect(retried).toMatchObject({ kind: 'failed', code: 'CONTEXT_NOT_SEALED', changedNothing: true });
        expect(dockerRuns()).toBe(1);
      });

      it.each(cases)('refuses before Docker on a first start when it is already open (%s targets, sudo: %s, hub CA: %s)', async (targets, sudo, withCa) => {
        const { open, plan, step } = nested(targets);
        if (sudo) asRootFor(String(process.getuid?.() ?? 0));
        if (!withCa) fs.unlinkSync(path.join(agent, 'sencho-hub-ca.pem'));
        fs.chmodSync(open, 0o777);
        const failure = await failureOf(() => runPlanStep(step(sudo), startContext(), plan(withCa)));
        expect(failure).toMatchObject({ kind: 'failed', code: 'CONTEXT_NOT_SEALED', changedNothing: true });
        expect(dockerRuns()).toBe(0);
      });

      it('names the directory only the target passes through', () => {
        const { open, named, step } = nested('absolute');
        fs.chmodSync(open, 0o777);
        const result = runShell(step(false).command as string, startInput({ agentIdentity: identity(agent), composeIdentity: identity(path.join(root, 'safe', 'real', 'stacks')), composeSha256: sha256(COMPOSE_TEXT), caSha256: sha256(CA_TEXT) }), env);
        expect(result.status).toBe(START_EXIT.notSealed);
        expect(result.stderr).toContain(approvedPath(open));
        expect(named).toContain('alias');
      });
    });

    it('accepts a sticky world-writable parent above the Compose directory when this user owns the Compose directory, and ignores the Compose directory\'s own mode', async () => {
      stacksBelow('sticky', 0o1777);
      fs.chmodSync(stacks, 0o777);
      expect((await runPlanStep(startStep(false), startContext(), planOf())).status).toBe('done');
    });

    it.skipIf(!IS_ROOT)('refuses a directory above the Agent directory owned by another user (root only)', async () => {
      fs.chownSync(path.join(root, 'srv'), 65534, 65534);
      await refusal(false);
    });

    it('stops before Docker for a directory whose group cannot be looked up', async () => {
      fs.chmodSync(agent, 0o770);
      fs.writeFileSync(path.join(root, 'bin', 'getent'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
      await refusal(false);
    });

    describe('what the message says', () => {
      const run = () => runShell(startStep(false).command as string, startInput({ agentIdentity: identity(agent), composeIdentity: identity(stacks), composeSha256: sha256(COMPOSE_TEXT), caSha256: sha256(CA_TEXT) }), env);
      it('says another user can change it, when one can', () => {
        fs.chmodSync(agent, 0o770);
        groupOf('stranger');
        const result = run();
        expect(result.status).toBe(START_EXIT.notSealed);
        expect(result.stderr).toMatch(/can be changed by another user/);
      });
      it.each([['a member the host cannot resolve', () => groupOf('ghost')], ['an account list that cannot be read', () => groupOf('', { passwdFails: true })]])('says it could not inspect it, not that it can be changed, when the host cannot say who is in the group: %s', (_label, arrange) => {
        fs.chmodSync(agent, 0o770);
        arrange();
        const result = run();
        expect(result.status).toBe(START_EXIT.notSealed);
        expect(result.stderr).toMatch(/could not inspect/);
        expect(result.stderr).not.toMatch(/can be changed by another user/);
      });
    });

    // Branches the file modes alone do not reach, driven by a shim for the one answer that differs.
    describe('what a shim for one answer changes', () => {
      const shim = (name: string, body: string) => fs.writeFileSync(path.join(root, 'bin', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      const realStat = REAL_STAT;

      it('accepts a group-writable directory whose group is root\'s, which is not the SSH user\'s own group, and refuses the same directory in any other group', async () => {
        fs.chmodSync(agent, 0o770);
        const asGroup = (gid: number) => shim('stat', `if [ "$2" = "%u %g %a" ] && [ "$4" = "${approvedPath(agent)}" ]; then set -- $("${realStat}" "$@"); echo "$1 ${gid} $3"; exit 0; fi\nexec "${realStat}" "$@"`);
        // A group nobody has a record of vouches for nothing; root's group needs no primary-group match.
        asGroup(54321);
        await refusal(false);
        asGroup(0);
        expect((await runPlanStep(startStep(false), startContext(), planOf())).status).toBe('done');
      });

      it.each([['compose.yaml', 'compose.yaml'], ['the hub CA', 'sencho-hub-ca.pem']])('refuses %s owned by a user other than root and the SSH user, whatever its mode', async (_label, file) => {
        shim('stat', `if [ "$2" = "%u %a" ] && [ "$4" = "./${file}" ]; then echo "54321 600"; exit 0; fi\nexec "${realStat}" "$@"`);
        await refusal(false);
        // The hub CA is looked at only when the plan has one; compose.yaml always is.
        if (file === 'compose.yaml') await refusal(false, planOf(undefined, false));
        else expect((await runPlanStep(startStep(false), startContext(), planOf(undefined, false))).status).toBe('done');
      });

      it('refuses a group-writable directory that has an access control list, even in this user\'s private group', async () => {
        fs.chmodSync(agent, 0o770);
        groupOf('');
        expect((await runPlanStep(startStep(false), startContext(), planOf())).status).toBe('done');
        shim('ls', `if [ "$1" = -ld ] && [ "$3" = "${approvedPath(agent)}" ]; then echo "drwxrwx---+ 2 me me 4096 Jan  1 00:00 ${approvedPath(agent)}"; exit 0; fi\nexec "${execFileSync('sh', ['-c', 'command -v ls'], { encoding: 'utf8' }).trim()}" "$@"`);
        await refusal(false);
      });
    });
  });

  it('starts a plan that has no hub CA, without looking for one', async () => {
    const step = startStep(false);
    fs.unlinkSync(path.join(agent, 'sencho-hub-ca.pem'));
    expect((await runPlanStep(step, startContext(), planOf(undefined, false))).status).toBe('done');
    expect(dockerRuns()).toBe(1);
  });

  it('refuses to start a project whose directories the plan holds no identity for', async () => {
    const step = startStep(false);
    const session = localSession({ env });
    const failure = await failureOf(() => runPlanStep(step, { ...context(session, [NEW_TOKEN]), composeWithToken: () => COMPOSE_TEXT }, planOf({ agent: null, stacks: identity(stacks) })));
    expect(failure).toMatchObject({ code: 'PLAN_INVALID', changedNothing: true });
    expect(session.commands).toEqual([]);
    expect(dockerRuns()).toBe(0);
  });

  it('starts the directory this run made, which the plan could only describe', async () => {
    const step = startStep(false);
    const ctx = startContext();
    ctx.directories.set(approvedPath(agent), identity(agent));
    expect((await runPlanStep(step, ctx, planOf({ agent: null, stacks: identity(stacks) }))).status).toBe('done');
    expect(dockerRuns()).toBe(1);
  });
});

/**
 * The apt directories are not inspected by the preflight, so they carry no
 * recorded identity: they are bound by their literal path and by being owned by
 * the user the script runs as.
 */
describe('B1: the apt directories are approved by their literal path and their owner', () => {
  const spec = { mode: '0755', owner, group };

  it('creates a missing keyring directory under an ancestor owned by the user, with nothing left behind', () => {
    const etc = path.join(root, 'etc');
    fs.mkdirSync(etc, { mode: 0o755 });
    const keyrings = path.join(etc, 'keyrings');
    const result = runShell(directoryCommand(keyrings, spec, { sudo: false, allowExisting: true, binding: 'system' }));
    expect(result.status).toBe(0);
    expect(modeOf(keyrings)).toBe('755');
    expect(fs.readdirSync(etc)).toEqual(['keyrings']);
  });

  it('adjusts an existing keyring directory owned by the user, and writes into it', () => {
    const keyrings = path.join(root, 'keyrings');
    fs.mkdirSync(keyrings, { mode: 0o700 });
    expect(runShell(directoryCommand(keyrings, spec, { sudo: false, allowExisting: true, binding: 'system' })).status).toBe(0);
    expect(modeOf(keyrings)).toBe('755');
    expect(runShell(writeCommand(path.join(keyrings, 'docker.asc'), { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null, binding: 'system' }), 'ours').status).toBe(0);
  });

  it('still refuses a keyring directory reached through a link, and one that is not on the path that was approved', () => {
    const real = path.join(root, 'real');
    fs.mkdirSync(real, { mode: 0o700 });
    const link = path.join(root, 'keyrings');
    fs.symlinkSync(real, link);
    expect(runShell(directoryCommand(link, spec, { sudo: false, allowExisting: true, binding: 'system' })).status).toBe(WRITE_EXIT.exists);
    expect(modeOf(real)).toBe('700');
    const other = path.join(root, 'other');
    fs.mkdirSync(other, { mode: 0o700 });
    expect(runShell(directoryCommand(other, spec, { sudo: false, allowExisting: true, binding: 'system', approved: path.join(root, 'elsewhere') })).status).toBe(WRITE_EXIT.notDirectory);
    expect(modeOf(other)).toBe('700');
  });

  it.skipIf(IS_ROOT)('refuses a directory it does not own (a root-owned system directory is the only one it adjusts under sudo)', () => {
    // /proc is a real directory owned by root, which this test user is not.
    const result = runShell(directoryCommand('/proc', spec, { sudo: false, allowExisting: true, binding: 'system', approved: '/proc' }));
    expect(result.status).toBe(WRITE_EXIT.notDirectory);
  });
});


describe('B1: the apt writers are bound by the owner of the directory they enter', () => {
  it.each([['docker.list', '0644'], ['docker.asc', '0644']])('writes %s into a directory owned by the user', (name, mode) => {
    const dir = path.join(root, 'apt');
    fs.mkdirSync(dir, { mode: 0o755 });
    expect(runShell(writeCommand(path.join(dir, name), { mode, owner, group, sha256: sha256('ours') }, { sudo: false, replaces: null, binding: 'system' }), 'ours').status).toBe(0);
    expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe('ours');
  });

  it.skipIf(IS_ROOT)('refuses to write docker.list or docker.asc into a directory another user owns, and replaces nothing there', () => {
    // /proc is a real directory owned by root, which this test user is not; the script stops before it makes anything.
    for (const name of ['docker.list', 'docker.asc']) {
      const command = writeCommand(path.join('/proc', name), { mode: '0644', owner, group, sha256: sha256('ours') }, { sudo: false, replaces: sha256('old'), directory: '/proc', binding: 'system' });
      expect(runShell(command, 'ours').status).toBe(WRITE_EXIT.notDirectory);
    }
  });
});

describe('B1: which identity a step enters a directory with', () => {
  const plan = (agent: string | null, compose: string | null) => ({
    paths: {
      agentDir: { input: '/srv/agent', realPath: '/data/agent', identity: agent },
      composeDir: { input: '/srv/stacks', realPath: null, identity: compose },
    },
  }) as unknown as BootstrapPlan;

  it('takes the identity the plan recorded for the Agent and Compose directories, by the path typed or the one it resolves to', () => {
    const ctx = { directories: new Map<string, string>() };
    expect(approvedBinding(plan('1:2:3:a', '1:4:3:c'), ctx, '/srv/agent')).toBe('1:2:3:a');
    expect(approvedBinding(plan('1:2:3:a', '1:4:3:c'), ctx, '/data/agent')).toBe('1:2:3:a');
    expect(approvedBinding(plan('1:2:3:a', '1:4:3:c'), ctx, '/srv/stacks/')).toBe('1:4:3:c');
  });

  it('prefers the identity the run recorded when it made the directory', () => {
    const ctx = { directories: new Map([['/data/agent', '9:9:9:made']]) };
    expect(approvedBinding(plan('1:2:3:a', null), ctx, '/srv/agent')).toBe('9:9:9:made');
  });

  it('refuses a Compose or Agent directory it holds no identity for, rather than falling back to an owner check', () => {
    expect(() => approvedBinding(plan(null, '1:4:3:c'), { directories: new Map() }, '/srv/agent')).toThrow(expect.objectContaining({ code: 'PLAN_INVALID', changedNothing: true }));
  });

  it('binds any other directory (the apt directories) by its owner', () => {
    expect(approvedBinding(plan('1:2:3:a', '1:4:3:c'), { directories: new Map() }, '/etc/apt/keyrings')).toBe('system');
  });
});

describe('B1: an identity is more than a device and an inode', () => {
  const dirSpec = { mode: '0700', owner, group };

  it('refuses a directory whose owner or birth time differs from the approved one, though its device and inode are the same', () => {
    const dir = path.join(root, 'agent');
    fs.mkdirSync(dir, { mode: 0o755 });
    const [device, inode, uid, ...birthParts] = identityOf(dir).split(':');
    const birth = birthParts.join(':');
    const write = (binding: string) => runShell(writeCommand(path.join(dir, 'compose.yaml'), { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null, binding }), 'ours');
    expect(write(`${device}:${inode}:${Number(uid) + 1}:${birth}`).status).toBe(WRITE_EXIT.notDirectory);
    expect(write(`${device}:${inode}:${uid}:${birth}x`).status).toBe(WRITE_EXIT.notDirectory);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(write(`${device}:${inode}:${uid}:${birth}`).status).toBe(0);
  });

  it('reads the same identity whatever time zone the session runs in', () => {
    const dir = path.join(root, 'agent');
    fs.mkdirSync(dir, { mode: 0o755 });
    // The approval took the identity in one zone (the helper pins UTC); the script may run in another.
    const command = writeCommand(path.join(dir, 'compose.yaml'), { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null });
    for (const zone of ['JST-9', 'EST5EDT']) {
      expect(runShell(command, 'ours', { TZ: zone }).status).toBe(0);
      fs.rmSync(path.join(dir, 'compose.yaml'));
    }
  });

  it('refuses a substitute that was given the approved directory\'s inode number back', (task) => {
    // On a filesystem without birth times every directory is refused, so the substitute is refused here whether or not its inode came back; the missing-creation-time cases below prove that variant on its own.
    const dir = path.join(root, 'agent');
    let reused = false;
    for (let attempt = 0; attempt < 300 && !reused; attempt += 1) {
      fs.mkdirSync(dir, { mode: 0o755 });
      const approved = identityOf(dir);
      const command = writeCommand(path.join(dir, 'compose.yaml'), { ...file, sha256: sha256('ours') }, { sudo: false, replaces: null, binding: approved });
      fs.rmdirSync(dir);
      fs.mkdirSync(dir, { mode: 0o700 });
      fs.writeFileSync(path.join(dir, 'operator-data'), 'keep me');
      const [device, inode] = approved.split(':');
      if (identityOf(dir).startsWith(`${device}:${inode}:`)) {
        reused = true;
        expect(runShell(command, 'ours').status).toBe(WRITE_EXIT.notDirectory);
        expect(fs.readdirSync(dir)).toEqual(['operator-data']);
        expect(modeOf(dir)).toBe('700');
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // Where the filesystem never hands an inode back this proved nothing: it is reported as skipped, not as passed.
    if (!reused) task.skip();
  });

  describe('two directories below a parent that does not exist yet', () => {
    const spec = { mode: '0755', owner, group };
    function arrange() {
      const srv = path.join(root, 'srv');
      fs.mkdirSync(srv, { mode: 0o755 });
      const compose = path.join(srv, 'sencho', 'stacks');
      const agent = path.join(srv, 'sencho', 'agent');
      // Both are approved before either exists: each is bound to /srv, the nearest directory that exists.
      return { srv, compose, agent, composeCommand: directoryCommand(compose, spec, { sudo: false, allowExisting: false }), agentCommand: directoryCommand(agent, dirSpec, { sudo: false, allowExisting: false }) };
    }
    const madeBy = (stdout: string) => new Map(stdout.trim().split('\n').map((line) => {
      const [identity, madePath] = line.slice('SENCHO_DIR_MADE='.length).split('\t');
      return [madePath, identity] as [string, string];
    }));

    it('makes the second one inside the parent the first one made, which only the run knows', () => {
      const { compose, agent, composeCommand, agentCommand } = arrange();
      const first = runShell(composeCommand);
      expect(first.status).toBe(0);
      expect(runShell(agentCommand, madeDirectoriesInput(madeBy(first.stdout))).status).toBe(0);
      expect(modeOf(compose)).toBe('755');
      expect(modeOf(agent)).toBe('700');
    });

    it('refuses the second one when the parent the first one made is not what it made', () => {
      const { srv, composeCommand, agentCommand } = arrange();
      const made = madeBy(runShell(composeCommand).stdout);
      const parent = path.join(srv, 'sencho');
      fs.renameSync(parent, `${parent}.made`);
      fs.mkdirSync(parent, { mode: 0o700 });
      fs.writeFileSync(path.join(parent, 'operator-data'), 'keep me');
      expect(runShell(agentCommand, madeDirectoriesInput(made)).status).toBe(WRITE_EXIT.notDirectory);
      expect(fs.readdirSync(parent)).toEqual(['operator-data']);
      expect(modeOf(parent)).toBe('700');
    });

    it('refuses the second one without the list of what the run made, because the parent is not the one the plan was bound to', () => {
      const { agent, composeCommand, agentCommand } = arrange();
      expect(runShell(composeCommand).status).toBe(0);
      expect(runShell(agentCommand, '').status).toBe(WRITE_EXIT.notDirectory);
      expect(fs.existsSync(agent)).toBe(false);
    });

    it('works through the steps: the registry the first step fills is what the second step is run with', async () => {
      const { compose, agent, composeCommand, agentCommand } = arrange();
      const step = (command: string, dest: string, mode: string): BootstrapPlanStep => ({
        id: 'create-dir', title: 'Create the directory', rationale: 'test', effect: 'directory-create', privilege: 'user', command,
        target: { path: dest, mode, owner, group, preserveExisting: false }, disruptive: false, reversible: 'yes', pointOfNoReturn: false, timeoutMs: 10_000,
      });
      const plan = { paths: { composeDir: { input: compose, realPath: approvedPath(compose), identity: null }, agentDir: { input: agent, realPath: approvedPath(agent), identity: null } } } as unknown as BootstrapPlan;
      const ctx = context(localSession());
      expect((await runPlanStep(step(composeCommand, compose, '0755'), ctx, plan)).status).toBe('done');
      expect((await runPlanStep(step(agentCommand, agent, '0700'), ctx, plan)).status).toBe('done');
      expect(ctx.directories.get(approvedPath(agent))).toBe(identityOf(agent));
      expect(ctx.directories.get(approvedPath(path.dirname(agent)))).toBe(identityOf(path.dirname(agent)));
    });
  });
});

/**
 * A filesystem that keeps no creation time reports `-` for it. The identity of a
 * directory generation is then device, inode and owner only, which a successor
 * that reused the inode shares, so every consumer of the binding refuses it
 * instead of accepting an identity that cannot tell the generations apart.
 * `stat` is shimmed to report no birth time, the way such a filesystem does, and
 * the binding handed to the script is the identity that shim yields: the one the
 * old code would have accepted.
 */
describe('B1: a directory whose creation time the host cannot give is bound by nothing', () => {
  const dirSpec = { mode: '0700', owner, group };
  const spec = { mode: '0600', owner, group };
  let env: NodeJS.ProcessEnv;
  const withoutBirth = (dir: string) => `${identityOf(dir).split(':').slice(0, 3).join(':')}:-`;

  beforeEach(() => {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    // Run the real stat with the birth time of the identity format blanked, as a filesystem without one answers.
    fs.writeFileSync(path.join(bin, 'stat'), [
      '#!/bin/sh',
      `last=; for a in "$@"; do last=$a; done`,
      'for a in "$@"; do shift; case $a in "%d:%i:%u:%w") a="%d:%i:%u:-" ;; esac; set -- "$@" "$a"; done',
      // Only the identity read of a directory made inside a staging directory (a relative name) loses its birth time when asked to.
      `exec "${REAL_STAT}" "$@"`,
    ].join('\n'), { mode: 0o755 });
    env = { PATH: `${bin}:${process.env.PATH ?? ''}` };
  });

  it('the shim reports what a filesystem without birth times reports', () => {
    expect(runShell(`stat -c "%d:%i:%u:%w" -- ${root}`, '', env).stdout.trim()).toMatch(/^\d+:\d+:\d+:-$/);
  });

  it('refuses to publish a file into a directory bound by such an identity (a new file, and a retry replacing one)', () => {
    const dir = path.join(root, 'agent');
    fs.mkdirSync(dir, { mode: 0o755 });
    const binding = withoutBirth(dir);
    // The shim answers with exactly the identity the script is bound by, so only the missing creation time can refuse it.
    expect(runShell(`stat -c "%d:%i:%u:%w" -- ${dir}`, '', env).stdout.trim()).toBe(binding);
    const fresh = writeCommand(path.join(dir, 'compose.yaml'), { ...spec, sha256: sha256('ours') }, { sudo: false, replaces: null, binding });
    expect(runShell(fresh, 'ours', env).status).toBe(WRITE_EXIT.notDirectory);
    expect(fs.readdirSync(dir)).toEqual([]);
    // The same command where the filesystem does report birth times: the guard, not the fixture, is what refused.
    expect(runShell(writeCommand(path.join(dir, 'compose.yaml'), { ...spec, sha256: sha256('ours') }, { sudo: false, replaces: null }), 'ours').status).toBe(0);
    fs.writeFileSync(path.join(dir, 'compose.yaml'), 'old');
    const replace = writeCommand(path.join(dir, 'compose.yaml'), { ...spec, sha256: sha256('ours') }, { sudo: false, replaces: sha256('old'), binding });
    expect(runShell(replace, 'ours', env).status).toBe(WRITE_EXIT.notDirectory);
    expect(fs.readFileSync(path.join(dir, 'compose.yaml'), 'utf8')).toBe('old');
  });

  it.each([
    ['one new directory', ['agent']],
    ['a directory below a new parent', ['a', 'agent']],
  ])('creates nothing below an ancestor bound by such an identity (%s)', (_label, below) => {
    const parent = path.join(root, 'srv');
    fs.mkdirSync(parent, { mode: 0o755 });
    expect(runShell(`stat -c "%d:%i:%u:%w" -- ${parent}`, '', env).stdout.trim()).toBe(withoutBirth(parent));
    const command = directoryCommand(path.join(parent, ...below), dirSpec, { sudo: false, allowExisting: false, binding: withoutBirth(parent) });
    expect(runShell(command, madeDirectoriesInput(new Map()), env).status).toBe(WRITE_EXIT.notDirectory);
    expect(fs.readdirSync(parent)).toEqual([]);
    // The same command with the real identity, on the real filesystem, creates the directory: the identity's missing creation time is what refused it.
    expect(runShell(directoryCommand(path.join(parent, ...below), dirSpec, { sudo: false, allowExisting: false }), madeDirectoriesInput(new Map())).status).toBe(0);
  });

  // A directory an earlier step of the run made is accepted by the identity the run recorded for it. With no creation time that record cannot tell it from a successor either, so it is refused, for a new directory and for a retry that meets an existing one.
  it.each([[false], [true]])('refuses a directory the run recorded as made, when the host gives it no creation time (retry of the create step: %s)', (allowExisting) => {
    const parent = path.join(root, 'srv');
    fs.mkdirSync(parent, { mode: 0o755 });
    const unrelated = path.join(root, 'unrelated');
    fs.mkdirSync(unrelated, { mode: 0o755 });
    // The plan's binding does not match the parent (it was made by an earlier step, so the plan could not name it): only the made list can accept it.
    const binding = identityOf(unrelated);
    const entry = (identity: string) => madeDirectoriesInput(new Map([[approvedPath(parent), identity]]));
    const command = directoryCommand(path.join(parent, 'agent'), dirSpec, { sudo: false, allowExisting, binding });
    const recorded = withoutBirth(parent);
    expect(runShell(command, entry(recorded), env).status).toBe(WRITE_EXIT.notDirectory);
    expect(fs.readdirSync(parent)).toEqual([]);
    // With the identity the run recorded on a filesystem that keeps creation times, the same list is what lets it through.
    expect(runShell(command, entry(identityOf(parent))).status).toBe(0);
  });

  describe.each([[false], [true]])('a directory made on a filesystem that gives no creation time for the top or the leaf (sudo: %s)', (sudo) => {
    // The identity read of one name inside the staging directory loses its creation time; `which` is that relative name.
    const arrange = (which: string) => {
      const parent = path.join(root, 'srv');
      fs.mkdirSync(parent, { mode: 0o755 });
      const bin = path.join(root, 'bin3');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'stat'), [
        '#!/bin/sh',
        'last=; for a in "$@"; do last=$a; done',
        `case "$(pwd -P)" in *"/.sencho-new."*) if [ "$last" = "${which}" ]; then for a in "$@"; do shift; case $a in "%d:%i:%u:%w") a="%d:%i:%u:-" ;; esac; set -- "$@" "$a"; done; fi ;; esac`,
        `exec "${REAL_STAT}" "$@"`,
      ].join('\n'), { mode: 0o755 });
      const sudoOnly = path.join(root, 'bin-sudo');
      fs.mkdirSync(sudoOnly);
      for (const dir of [bin, sudoOnly]) fs.writeFileSync(path.join(dir, 'sudo'), ['#!/bin/sh', '[ "$1" = -n ] && shift', 'exec "$@"'].join('\n'), { mode: 0o755 });
      return { parent, env: { PATH: `${bin}:${process.env.PATH ?? ''}` }, control: { PATH: `${sudoOnly}:${process.env.PATH ?? ''}` } };
    };
    it.each([
      ['a single new directory (the top is the leaf)', ['agent'], './agent'],
      ['only the top of a new tree', ['a', 'agent'], './a'],
      ['only the leaf of a new tree', ['a', 'agent'], './a/agent'],
    ])('puts nothing in place: %s', (_label, below, which) => {
      const { parent, env: shimmed, control } = arrange(which);
      const command = directoryCommand(path.join(parent, ...below), dirSpec, { sudo, allowExisting: false });
      const result = runShell(command, madeDirectoriesInput(new Map()), shimmed);
      expect(result.status).toBe(WRITE_EXIT.notCreated);
      expect(result.stderr).toMatch(/creation time/);
      expect(fs.readdirSync(parent)).toEqual([]);
      expect(runShell(command, madeDirectoriesInput(new Map()), control).status).toBe(0);
    });
  });

  it('refuses to adjust an existing directory bound by such an identity', () => {
    const dir = path.join(root, 'keyrings');
    fs.mkdirSync(dir, { mode: 0o755 });
    const command = directoryCommand(dir, { mode: '0755', owner, group }, { sudo: false, allowExisting: true, binding: withoutBirth(dir) });
    expect(runShell(command, madeDirectoriesInput(new Map()), env).status).toBe(WRITE_EXIT.notDirectory);
    expect(modeOf(dir)).toBe('755');
  });

  it('refuses to put a directory in place that it made on a filesystem without creation times, and leaves nothing behind', () => {
    const parent = path.join(root, 'srv');
    fs.mkdirSync(parent, { mode: 0o755 });
    const bin = path.join(root, 'bin2');
    fs.mkdirSync(bin);
    // The identity of what the script made inside its staging directory (a relative name) has no creation time; the directory it started from keeps its own.
    fs.writeFileSync(path.join(bin, 'stat'), [
      '#!/bin/sh',
      'last=; for a in "$@"; do last=$a; done',
      'case "$(pwd -P)" in *"/.sencho-new."*) case $last in ./*) for a in "$@"; do shift; case $a in "%d:%i:%u:%w") a="%d:%i:%u:-" ;; esac; set -- "$@" "$a"; done ;; esac ;; esac',
      `exec "${REAL_STAT}" "$@"`,
    ].join('\n'), { mode: 0o755 });
    const command = directoryCommand(path.join(parent, 'a', 'agent'), dirSpec, { sudo: false, allowExisting: false });
    const result = runShell(command, madeDirectoriesInput(new Map()), { PATH: `${bin}:${process.env.PATH ?? ''}` });
    expect(result.status).toBe(WRITE_EXIT.notCreated);
    expect(result.stderr).toMatch(/creation time/);
    expect(fs.readdirSync(parent)).toEqual([]);
    // Where the filesystem does keep creation times, the same command succeeds.
    expect(runShell(command, madeDirectoriesInput(new Map())).status).toBe(0);
  });

  it('is refused by the start script too, for the Agent directory and, separately, for the Compose directory', () => {
    const agent = path.join(root, 'srv', 'agent');
    const stacks = path.join(root, 'stacks');
    fs.mkdirSync(agent, { recursive: true, mode: 0o700 });
    fs.mkdirSync(stacks, { mode: 0o755 });
    fs.writeFileSync(path.join(agent, 'compose.yaml'), 'services: {}\n', { mode: 0o600 });
    const command = startProjectCommand({ path: agent, approved: approvedPath(agent) }, { path: stacks, approved: approvedPath(stacks) }, false);
    const input = (agentIdentity: string, composeIdentity: string) => startInput({ agentIdentity, composeIdentity, composeSha256: sha256('services: {}\n'), caSha256: null });
    // A shim that reports no birth time only while the shell is inside the directory named by `where`.
    const shimFor = (where: string) => {
      const bin = path.join(root, `bin-${where}`);
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'stat'), [
        '#!/bin/sh',
        `case "$(pwd -P)" in */${where}) for a in "$@"; do shift; case $a in "%d:%i:%u:%w") a="%d:%i:%u:-" ;; esac; set -- "$@" "$a"; done ;; esac`,
        `exec "${REAL_STAT}" "$@"`,
      ].join('\n'), { mode: 0o755 });
      return { PATH: `${bin}:${process.env.PATH ?? ''}` };
    };
    // Each identity handed over is the one the shim yields for that directory, so only the guard can refuse it.
    const agentResult = runShell(command, input(withoutBirth(agent), identityOf(stacks)), shimFor('agent'));
    expect(agentResult.status).toBe(START_EXIT.notDirectory);
    expect(agentResult.stderr).toMatch(/not the approved directory/);
    const composeResult = runShell(command, input(identityOf(agent), withoutBirth(stacks)), shimFor('stacks'));
    expect(composeResult.status).toBe(START_EXIT.notDirectory);
    expect(composeResult.stderr).toMatch(/not the approved Compose directory/);
    // Not a fixture artefact: with real birth times the same input goes all the way to Docker (a stub that exits 0).
    const stub = path.join(root, 'bin-docker');
    fs.mkdirSync(stub);
    fs.writeFileSync(path.join(stub, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const fine = runShell(command, input(identityOf(agent), identityOf(stacks)), { PATH: `${stub}:/usr/bin:/bin` });
    expect(fine.status).toBe(0);
  });

  describe('on the host side', () => {
    it('never records a made directory that has no creation time, so a step that made one stops for recovery', async () => {
      const dest = path.join(root, 'agent');
      const step: BootstrapPlanStep = {
        id: 'create-agent-dir', title: 'Create the Agent installation directory', rationale: 'test', effect: 'directory-create', privilege: 'user',
        command: directoryCommand(dest, dirSpec, { sudo: false, allowExisting: false }),
        target: { path: dest, mode: '0700', owner, group, preserveExisting: false }, disruptive: false, reversible: 'yes', pointOfNoReturn: false, timeoutMs: 10_000,
      };
      const plan = { paths: { composeDir: { input: '/opt/docker/sencho', realPath: '/opt/docker/sencho', identity: '64768:300:1000:2026-01-01' }, agentDir: { input: dest, realPath: approvedPath(dest), identity: null } } } as unknown as BootstrapPlan;
      const session = scriptedSession((command) => {
        const real = spawnSync('sh', ['-c', `LC_ALL=C ${command}`], { input: madeDirectoriesInput(new Map()), encoding: 'utf8' });
        // The host answers as one without creation times would.
        return { exitCode: real.status, stdout: real.stdout.replace(/(SENCHO_DIR_MADE=\d+:\d+:\d+:)\S+/g, '$1-'), stderr: '' };
      });
      const ctx = context(session);
      const failure = await failureOf(() => runPlanStep(step, ctx, plan));
      expect(failure).toMatchObject({ kind: 'recovery', code: 'DIRECTORY_NOT_FINISHED' });
      expect(ctx.directories.size).toBe(0);
    });

    it.each([['/srv/agent'], ['/c']])('refuses a recorded or planned identity without a creation time (%s)', (directory) => {
      const plan = { paths: { composeDir: { input: '/c', identity: '1:2:3:-' }, agentDir: { input: '/srv/agent', identity: '1:4:3:-' } } } as unknown as BootstrapPlan;
      expect(() => approvedBinding(plan, { directories: new Map() }, directory)).toThrow(expect.objectContaining({ code: 'PLAN_INVALID', changedNothing: true }));
      expect(() => approvedBinding(plan, { directories: new Map([[directory, '1:4:3:-']]) }, directory)).toThrow(expect.objectContaining({ code: 'PLAN_INVALID' }));
    });

    it('does not run the start step for a plan whose directories carry no creation time, and sends nothing to the host', async () => {
      const step: BootstrapPlanStep = {
        id: 'start-agent', title: 'Start', rationale: 'test', effect: 'container-start', privilege: 'user',
        command: startProjectCommand({ path: '/srv/agent', approved: '/srv/agent' }, { path: '/c', approved: '/c' }, false),
        disruptive: true, reversible: 'yes', pointOfNoReturn: true, timeoutMs: 10_000,
      };
      const session = scriptedSession(() => ({ exitCode: 0, stdout: '', stderr: '' }));
      for (const identities of [{ agent: '1:4:3:-', compose: '1:2:3:2026-01-01' }, { agent: '1:4:3:2026-01-01', compose: '1:2:3:-' }]) {
        const plan = { paths: { composeDir: { input: '/c', realPath: '/c', identity: identities.compose }, agentDir: { input: '/srv/agent', realPath: '/srv/agent', identity: identities.agent } }, stages: [] } as unknown as BootstrapPlan;
        const failure = await failureOf(() => runPlanStep(step, context(session), plan));
        expect(failure).toMatchObject({ code: 'PLAN_INVALID', changedNothing: true });
      }
      expect(session.commands).toEqual([]);
    });

    it.each([
      ['the parent has none and the leaf has one', /\/a$/, 'agent', false],
      ['the leaf has none and the parent has one', /\/agent$/, 'a', true],
    ] as const)('records only the made directories that have a creation time, when %s', async (_label, blanked, survivor, stops) => {
      const dest = path.join(root, 'a', 'agent');
      fs.mkdirSync(root, { recursive: true });
      const step: BootstrapPlanStep = {
        id: 'create-agent-dir', title: 'Create the Agent installation directory', rationale: 'test', effect: 'directory-create', privilege: 'user',
        command: directoryCommand(dest, dirSpec, { sudo: false, allowExisting: false }),
        target: { path: dest, mode: '0700', owner, group, preserveExisting: false }, disruptive: false, reversible: 'yes', pointOfNoReturn: false, timeoutMs: 10_000,
      };
      const plan = { paths: { composeDir: { input: '/opt/docker/sencho', realPath: '/opt/docker/sencho', identity: '64768:300:1000:2026-01-01' }, agentDir: { input: dest, realPath: approvedPath(dest), identity: null } } } as unknown as BootstrapPlan;
      const session = scriptedSession((command) => {
        const real = spawnSync('sh', ['-c', `LC_ALL=C ${command}`], { input: madeDirectoriesInput(new Map()), encoding: 'utf8' });
        const stdout = real.stdout.split('\n').map((line) => (line.startsWith('SENCHO_DIR_MADE=') && blanked.test(line.split('\t')[1] ?? '') ? line.replace(/^(SENCHO_DIR_MADE=\d+:\d+:\d+:)\S+/, '$1-') : line)).join('\n');
        return { exitCode: real.status, stdout, stderr: '' };
      });
      const ctx = context(session);
      if (stops) expect(await failureOf(() => runPlanStep(step, ctx, plan))).toMatchObject({ kind: 'recovery', code: 'DIRECTORY_NOT_FINISHED' });
      else expect((await runPlanStep(step, ctx, plan)).status).toBe('done');
      // Exactly the directory that has a creation time is recorded: the other one is not, and nothing is recorded with a `-`.
      expect([...ctx.directories.keys()]).toEqual([approvedPath(survivor === 'a' ? path.dirname(dest) : dest)]);
      for (const identity of ctx.directories.values()) expect(identity.endsWith(':-')).toBe(false);
    });
  });
});
