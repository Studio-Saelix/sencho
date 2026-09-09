import { vi } from 'vitest';
import { EventEmitter } from 'events';

// A fake `docker compose config` child process. The data and close events are
// deferred to a microtask so the mock resolves asynchronously, the way a real
// child's output arrives; the discovery code awaits that deferred resolution.
export function makeRenderProc(stdout: string, exitCode: number) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  Promise.resolve().then(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', exitCode);
  });
  return proc;
}
