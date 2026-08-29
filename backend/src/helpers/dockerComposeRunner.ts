import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import { managedAreaBase } from '../services/gitops/managedPaths';

export function runDockerCompose(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const resolvedCwd = path.resolve(cwd);
  const managedBase = path.resolve(managedAreaBase());
  const tmpBase = path.resolve(os.tmpdir());
  // Canonical inline js/path-injection barrier, kept in the same scope as the
  // spawn cwd sink below. CodeQL does not credit a barrier separated from the
  // sink by the Promise-executor closure, so spawn is hoisted out of it.
  if (
    !resolvedCwd.startsWith(managedBase + path.sep)
    && !resolvedCwd.startsWith(tmpBase + path.sep)
  ) {
    return Promise.resolve({ code: -1, stdout: '', stderr: 'Invalid working directory' });
  }
  const child = spawn('docker', args, { cwd: resolvedCwd });
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
      resolve({ code: -1, stdout, stderr: stderr + '\nValidation timed out.' });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message });
    });
  });
}
