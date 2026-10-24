import { describe, expect, it } from 'vitest';
import { redactSensitiveText } from '../utils/safeLog';

describe('redactSensitiveText', () => {
  it('redacts credentials from durable log text', () => {
    const text = redactSensitiveText(
      'connect https://user:pass@example.invalid failed Authorization: Bearer abc.def.ghi token=secret123 password=hunter2',
    );

    expect(text).toContain('https://[redacted]@example.invalid');
    expect(text).toContain('Authorization: [redacted]');
    expect(text).toContain('token=[redacted]');
    expect(text).toContain('password=[redacted]');
    expect(text).not.toContain('user:pass');
    expect(text).not.toContain('abc.def.ghi');
    expect(text).not.toContain('secret123');
    expect(text).not.toContain('hunter2');
  });

  it('strips Linux-style homedir usernames while keeping the /home/ prefix', () => {
    const text = redactSensitiveText('compose error reading /home/user-linux/docker/compose.yaml');

    expect(text).not.toContain('user-linux');
    expect(text).toContain('/home/<user>/docker/compose.yaml');
  });

  it('strips macOS-style homedir usernames while keeping the /Users/ prefix', () => {
    const text = redactSensitiveText('failed to open /Users/user.macos/Projects/app/.env');

    expect(text).not.toContain('user.macos');
    expect(text).toContain('/Users/<user>/Projects/app/.env');
  });

  it('strips Windows-style homedir usernames while preserving the drive letter', () => {
    const text = redactSensitiveText(
      'ENOENT: no such file or directory, open \'D:\\Users\\user.windows\\Sencho\\compose.yaml\'',
    );

    expect(text).not.toContain('user.windows');
    expect(text).toContain('D:\\Users\\<user>\\Sencho\\compose.yaml');
  });

  it('strips Windows-style homedir usernames when the drive letter is lowercase', () => {
    const text = redactSensitiveText('failed: c:\\Users\\user.lowercase\\app\\compose.yaml');

    expect(text).not.toContain('user.lowercase');
    expect(text).toContain('c:\\Users\\<user>\\app\\compose.yaml');
  });

  it('redacts Basic auth credentials embedded after Authorization header', () => {
    const text = redactSensitiveText(
      'upstream 401: Authorization: Basic dXNlcjpwYXNzd29yZA== rejected by registry',
    );

    expect(text).not.toContain('dXNlcjpwYXNzd29yZA');
    expect(text).toContain('[redacted]');
  });

  it('redacts a bare Basic auth scheme without an Authorization header', () => {
    const text = redactSensitiveText('curl error: header Basic c2VjcmV0OnZhbHVl was rejected');

    expect(text).not.toContain('c2VjcmV0OnZhbHVl');
    expect(text).toContain('Basic [redacted]');
  });

  // Compose echoes an image reference back in its own errors, and an image
  // reference can carry registry credentials with no URL scheme in front.
  it('redacts scheme-less registry credentials that lead an image reference', () => {
    const text = redactSensitiveText(
      'service "web" refers to user:s3cr3tpass@registry.example.invalid/team/app:latest, which could not be pulled',
    );

    expect(text).not.toContain('s3cr3tpass');
    expect(text).toContain('[redacted]@registry.example.invalid/team/app:latest');
  });

  it('redacts scheme-less registry credentials that carry an explicit port', () => {
    const text = redactSensitiveText('pull failed for dep:pa55word@10.0.0.5:5000/team/app:1.0');

    expect(text).not.toContain('pa55word');
    expect(text).toContain('[redacted]@10.0.0.5:5000/team/app:1.0');
  });

  it('redacts a credential whose password contains a colon', () => {
    const text = redactSensitiveText('pull failed for user:a:b:c@reg.invalid/team/app:latest');

    expect(text).not.toContain('a:b:c');
    expect(text).toContain('[redacted]@reg.invalid/team/app:latest');
  });

  it('redacts a credential that follows an equals sign without losing the key', () => {
    const text = redactSensitiveText('image=user:s3cr3t@reg.invalid/team/app:1.0 rejected');

    expect(text).not.toContain('s3cr3t@');
    expect(text).toContain('image=[redacted]@reg.invalid/team/app:1.0');
  });

  it('leaves a URL path that merely looks like a credential intact', () => {
    const text = redactSensitiveText('upstream rejected https://h.invalid/a:b@c/d');

    expect(text).toBe('upstream rejected https://h.invalid/a:b@c/d');
  });

  // A digest pin is the text a GitOps diagnosis is built from. Redacting it
  // would both destroy the repository and tag and wrongly imply a secret was
  // present.
  it('redacts a credential pointing at a bracketed IPv6 registry host', () => {
    const text = redactSensitiveText('pull failed for user:s3cr3t@[::1]:5000/team/app:1.0');

    expect(text).not.toContain('s3cr3t');
    expect(text).toContain('[redacted]@[::1]:5000/team/app:1.0');
  });

  it('leaves a digest-pinned image reference intact', () => {
    const text = redactSensitiveText('pinned ghcr.io/studio-saelix/sencho:0.97.1@sha256:1a2b3c4d5e6f failed to pull');

    expect(text).toContain('ghcr.io/studio-saelix/sencho:0.97.1@sha256:1a2b3c4d5e6f');
    expect(text).not.toContain('[redacted]');
  });

  it('leaves an untagged digest reference intact', () => {
    const text = redactSensitiveText('resolved lscr.io/linuxserver/swag@sha256:abc123 to the wrong platform');

    expect(text).toContain('lscr.io/linuxserver/swag@sha256:abc123');
    expect(text).not.toContain('[redacted]');
  });

  it('leaves a tag-only image reference intact', () => {
    const text = redactSensitiveText('pulling lscr.io/linuxserver/plex:latest');

    expect(text).toBe('pulling lscr.io/linuxserver/plex:latest');
  });

  it('leaves a registry host with a port intact when no credential is present', () => {
    const text = redactSensitiveText('contacting 10.0.0.5:5000/v2/ for the manifest list');

    expect(text).toBe('contacting 10.0.0.5:5000/v2/ for the manifest list');
  });

  it('redacts a keyword secret that is quoted on both sides of its separator', () => {
    const text = redactSensitiveText('config rejected: {"POSTGRES_PASSWORD": "s3cr3tvalue", "port": 5432}');

    expect(text).not.toContain('s3cr3tvalue');
    expect(text).toContain('[redacted]');
    // The neighbouring non-secret field survives, so the redaction is targeted.
    expect(text).toContain('5432');
  });

  it('redacts a single-quoted keyword secret', () => {
    const text = redactSensitiveText("config rejected: {'api_key': 'abcd1234efgh'}");

    expect(text).not.toContain('abcd1234efgh');
    expect(text).toContain('[redacted]');
  });
});
