import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runDockerCompose } from '../helpers/dockerComposeRunner';

describe('runDockerCompose working-directory guard', () => {
  let tmpDir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-compose-runner-'));
    prevDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tmpDir;
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses a working directory outside the managed, secrets, and temp roots', async () => {
    const result = await runDockerCompose(['version'], path.dirname(tmpDir), 5_000);
    expect(result.code).toBe(-1);
    expect(result.stderr).toBe('Invalid working directory');
  });

  it('accepts the decrypt overlay area under the data directory', async () => {
    const overlayCwd = path.join(
      tmpDir,
      'git-secrets',
      '1',
      'demo',
      '01234567-89ab-4cde-8fab-0123456789ab',
    );
    fs.mkdirSync(overlayCwd, { recursive: true });

    // Move the temp root away from the data dir so only the git-secrets branch
    // can accept this working directory.
    const prevTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = path.join(tmpDir, 'unrelated-tmp');
    try {
      const result = await runDockerCompose(['version'], overlayCwd, 5_000);
      expect(result.stderr).not.toBe('Invalid working directory');
    } finally {
      if (prevTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmpdir;
    }
  });

  it('still accepts the managed area and the temp root', async () => {
    const managedCwd = path.join(tmpDir, 'git-managed', '1', 'demo');
    fs.mkdirSync(managedCwd, { recursive: true });
    const managed = await runDockerCompose(['version'], managedCwd, 5_000);
    expect(managed.stderr).not.toBe('Invalid working directory');

    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-runner-tmp-'));
    try {
      const tmp = await runDockerCompose(['version'], tmpCwd, 5_000);
      expect(tmp.stderr).not.toBe('Invalid working directory');
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});
