import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { READ_EXIT, WRITE_EXIT, startProjectCommand } from '../services/nodeBootstrap/executionCommands';
import { approvedIdentity, approvedPath, directoryCommand, writeCommand } from './__helpers__/bootstrapCommands';
import { StepFailure, TOKEN_PLACEHOLDER, approvedDirectory, runPlanStep, type StepContext } from '../services/nodeBootstrap/stepRunner';
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

const PLAN = { paths: { composeDir: { input: '/opt/docker/sencho', identity: '64768:300' }, agentDir: { input: '/opt/sencho-agent', identity: '64768:200' } } } as unknown as BootstrapPlan;

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

describe('B1: directory creation makes missing parents the way install -d did', () => {
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
    const plan = { paths: { composeDir: { input: '/opt/docker/sencho', realPath: '/opt/docker/sencho', identity: '64768:300' }, agentDir: { input: dir, realPath: approved, identity: identityBefore } } } as unknown as BootstrapPlan;
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
    const plan = { paths: { composeDir: { input: '/opt/docker/sencho', realPath: '/opt/docker/sencho', identity: '64768:300' }, agentDir: { input: dir, realPath: approvedPath(dir), identity: approvedIdentity(dir) } } } as unknown as BootstrapPlan;
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
 * approval recorded (device and inode) can tell it apart.
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

  it('accepts the approved existing directory and reports its identity', () => {
    const dir = path.join(root, 'keyrings');
    fs.mkdirSync(dir, { mode: 0o700 });
    const result = runShell(directoryCommand(dir, { mode: '0755', owner, group }, { sudo: false, allowExisting: true }));
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`SENCHO_DIR_IDENTITY=${approvedIdentity(dir)}`);
    expect(modeOf(dir)).toBe('755');
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
    const composeDirIdentity = '64768:300';
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
