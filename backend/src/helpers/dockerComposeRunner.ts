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
  const allowedCwd = resolvedCwd.startsWith(managedBase + path.sep)
    || resolvedCwd.startsWith(tmpBase + path.sep)
    ? resolvedCwd
    : null;
  if (!allowedCwd) {
    return Promise.resolve({ code: -1, stdout: '', stderr: 'Invalid working directory' });
  }
  return new Promise((resolve) => {
    const child = spawn('docker', args, { cwd: allowedCwd });
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
