/**
 * A failed swap step says why in the node log.
 *
 * The probe reports a refusal as `{"error": ...}` on stdout and writes nothing to
 * stderr, so a log line that read stderr alone ended after the colon.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { format } from 'util';
import { scriptedHelper } from './__helpers__/overwriteFixture';
import { runSwapStep } from '../services/recovery/volumeSwap';

const INTENT_ID = '4f3a2b1c-0d9e-4a8b-9c7d-6e5f4a3b2c1d';

afterEach(() => vi.restoreAllMocks());

async function stepLogs(answer: Parameters<typeof scriptedHelper>[0]): Promise<{ ok: boolean; lines: string[] }> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const helper = scriptedHelper(answer);
  const result = await runSwapStep({
    runner: helper.helper,
    operationId: 'op-1',
    volumeName: 'live-volume',
    intentId: INTENT_ID,
    action: 'prepare',
  });
  return { ok: result.ok, lines: warn.mock.calls.map((call) => format(...call)) };
}

describe('a swap step that exits non-zero', () => {
  it('logs the refusal the probe printed on stdout', async () => {
    const { ok, lines } = await stepLogs({
      swapAnswers: [{
        action: 'prepare',
        exitCode: 1,
        stdoutLine: JSON.stringify({ error: 'a work directory exists without a journal' }),
      }],
    });
    expect(ok).toBe(false);
    const line = lines.find((text) => text.includes('Swap helper prepare'));
    expect(line).toContain(INTENT_ID);
    expect(line).toContain('exited 1');
    expect(line).toContain('a work directory exists without a journal');
  });

  it('logs stderr too, and strips control characters from both', async () => {
    const { lines } = await stepLogs({
      swapAnswers: [{
        action: 'prepare',
        exitCode: 1,
        stderr: 'warning: bad\u001b[2Jname\n',
        stdoutLine: JSON.stringify({ error: 'refused\u0000' }),
      }],
    });
    const line = lines.find((text) => text.includes('Swap helper prepare'));
    expect(line).toContain('refused');
    expect(line).toContain('warning: bad');
    expect(line).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
  });

  it('logs nothing about a step that succeeded', async () => {
    const { ok, lines } = await stepLogs({ swapAnswers: [{ action: 'prepare', exitCode: 0, status: 'planned' }] });
    expect(ok).toBe(true);
    expect(lines).toEqual([]);
  });
});
