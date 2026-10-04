/**
 * Docker-backed integration: decrypted dotenv values must survive Compose's
 * env_file parser byte for byte, including newlines and shell metacharacters.
 * Skipped automatically when Docker is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { decryptSopsAgeDocument } from '../../services/gitops/sops/decode';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], {
      stdio: 'ignore',
      timeout: 8_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();
const IMAGE = 'busybox:1.36.1';

describe.skipIf(!hasDocker)('decrypted dotenv values survive the Compose env_file parser', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-sops-dotenv-'));
  });

  afterAll(() => {
    if (hasDocker) {
      try {
        execFileSync('docker', ['compose', '-f', 'compose.yaml', 'down', '--remove-orphans'], {
          cwd: tmpDir,
          stdio: 'ignore',
          timeout: 60_000,
        });
      } catch {
        // Best effort: the project may never have been created.
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('delivers newlines and metacharacters byte for byte', async () => {
    const fixturesDir = path.join(__dirname, '..', 'fixtures', 'sops');
    const identity = fs.readFileSync(path.join(fixturesDir, 'test-only-identity.txt'), 'utf8').trim();
    const newline = await decryptSopsAgeDocument(
      fs.readFileSync(path.join(fixturesDir, 'newline.enc.env'), 'utf8'),
      identity,
    );
    const metachar = await decryptSopsAgeDocument(
      fs.readFileSync(path.join(fixturesDir, 'metachar.enc.env'), 'utf8'),
      identity,
    );
    fs.writeFileSync(path.join(tmpDir, '.env'), newline + metachar);
    fs.writeFileSync(
      path.join(tmpDir, 'compose.yaml'),
      [
        'services:',
        '  probe:',
        `    image: ${IMAGE}`,
        '    env_file: ./.env',
        '    entrypoint: ["sh","-c"]',
        '',
      ].join('\n'),
    );

    const out = execFileSync(
      'docker',
      [
        'compose', '-f', 'compose.yaml', 'run', '--rm', '-T', 'probe',
        'printf "%s\\n" "$NL"; printf "%s\\n" "$DOLLAR"; printf "%s\\n" "$QUOTE"; printf "%s\\n" "$SPACE"; printf "%s\\n" "$HASH"; printf "%s\\n" "$TAB"; printf "%s\\n" "$CR"; printf "%s\\n" "$PLAIN"',
      ],
      { cwd: tmpDir, encoding: 'utf8', timeout: 120_000 },
    );
    expect(out).toBe('line1\nline2\na$B\nsay "hi"\n padded\na #b\na\tb\na\rb\nx\n');
  }, 180_000);
});
