import { describe, expect, it } from 'vitest';
import { errorMessageForLog, redactImageReference, redactSensitiveText } from '../utils/safeLog';

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

  it.each([
    ['postgres', 'see postgres://bob:s3cretPASS@host/db', 'postgres://[redacted]@host/db'],
    ['redis', 'redis://default:hunter2@cache:6379/0 refused', 'redis://[redacted]@cache:6379/0 refused'],
    ['amqps', 'amqps://u:p4ss@mq.example.invalid/vhost', 'amqps://[redacted]@mq.example.invalid/vhost'],
    ['http', 'http://u:p4ss@example.invalid/x', 'http://[redacted]@example.invalid/x'],
    ['redis with an empty user', 'redis://:p4ss@cache:6379/0', 'redis://[redacted]@cache:6379/0'],
    ['a password holding a raw @', 'postgres://bob:p4ss@word@host/db', 'postgres://[redacted]@host/db'],
  ])('redacts a %s URL credential', (_scheme, input, expected) => {
    const text = redactSensitiveText(input);
    expect(text).toContain(expected);
    expect(text).not.toMatch(/s3cretPASS|hunter2|p4ss/);
  });

  it.each([
    'https://example.com:8443/x',
    'ssh://host:22',
    'ssh://git@github.com/org/repo.git',
    'registry:5000/team/app@sha256:0123456789abcdef',
    'docker://registry:5000/team/app:1.0',
    'mailto:bob@example.com',
  ])('leaves %s as it is', input => {
    expect(redactSensitiveText(input)).toBe(input);
  });

  it('redacts a credential behind a scheme longer than the usual bound', () => {
    expect(redactSensitiveText(`${'a'.repeat(40)}://u:pw@h/x`)).not.toContain('pw@');
  });

  it('redacts a long dotted run in linear time', () => {
    const started = Date.now();
    redactSensitiveText('a.'.repeat(100_000));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it.each([
    ['a long run with no dot', 'A'.repeat(60_000)],
    ['a run just past one JWT segment', 'A'.repeat(60_000) + '.'],
  ])('stays linear on %s, which is what a 60 kB Docker label looks like', (_shape, input) => {
    // A container label is attacker-controlled through any stack author; the
    // greedy JWT first segment used to retry at every offset without a dot,
    // turning this exact value into seconds of blocked event loop.
    const started = Date.now();
    redactSensitiveText(input);
    expect(Date.now() - started).toBeLessThan(1000);
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

  it.each([
    ['a percent-encoded user name', 'service "a6" uses "user%40x:SECRETQ6@host/app:latest"', 'SECRETQ6', '"[redacted]@host/app:latest"'],
    ['a literal @ in the password', 'service "a7" uses "u:p@SECRETQ7@host/app"', 'SECRETQ7', '"[redacted]@host/app"'],
    ['two literal @ in the password', 'pull failed for u:a@b@SECRETQ9@host:5000/app', 'SECRETQ9', '[redacted]@host:5000/app'],
    ['an encoded user name and a literal @', 'image=user%40x:p@SECRETQ8@reg.invalid/app:1', 'SECRETQ8', 'image=[redacted]@reg.invalid/app:1'],
    ['a user name with + and ~', 'pull failed for ci+bot~1:SECRETQ10@reg.invalid/app', 'SECRETQ10', '[redacted]@reg.invalid/app'],
    ['a literal @ before a bracketed IPv6 host', 'pull failed for u:p@SECRETQ11@[::1]:5000/app', 'SECRETQ11', '[redacted]@[::1]:5000/app'],
  ])('redacts a scheme-less image credential with %s', (_variant, input, secret, expected) => {
    const text = redactSensitiveText(input);
    expect(text).not.toContain(secret);
    expect(text).toContain(expected);
  });

  // A userinfo that is a lone token (a Git provider token in a URL, a registry
  // token), or that follows a protocol-relative //.
  it.each([
    ['a token-only URL userinfo', 'service "s0" uses "https://SECRETD1tok@host/app:latest"', 'SECRETD1tok', '"https://[redacted]@host/app:latest"'],
    ['a token-only URL with no path', 'cloning https://SECRETD3tok@github.com failed', 'SECRETD3tok', 'https://[redacted]@github.com failed'],
    ['a token-only scheme-less login', 'service "s0" uses "ghp_SECRETD8@ghcr.io/x/app:latest"', 'SECRETD8', '"[redacted]@ghcr.io/x/app:latest"'],
    ['a protocol-relative user and password', 'service "s0" uses "//u:SECRETD2@host/app:latest"', 'SECRETD2', '"//[redacted]@host/app:latest"'],
    ['a protocol-relative token', 'pull failed for //SECRETD4tok@host:5000/app', 'SECRETD4tok', '//[redacted]@host:5000/app'],
    ['a token-only login after an equals sign', 'image=SECRETD5tok@reg.invalid/app:1', 'SECRETD5tok', 'image=[redacted]@reg.invalid/app:1'],
  ])('redacts %s', (_variant, input, secret, expected) => {
    const text = redactSensitiveText(input);
    expect(text).not.toContain(secret);
    expect(text).toContain(expected);
  });

  // The lone-token form stops at a quote or a comma, so a URL with no userinfo
  // does not take the next value's @ as its own.
  it.each([
    ['a JSON array', '["https://github.com","ops@corp.example"]'],
    ['a comma list', 'a=https://github.com,b=ops@corp.example'],
    ['a quoted pair', "'https://github.com' 'ops@corp.example'"],
  ])('does not run a URL with no credential into the next value in %s', (_shape, input) => {
    expect(redactSensitiveText(input)).toBe(input);
  });

  it('redacts a token-only URL credential in JSON without touching the next value', () => {
    expect(redactSensitiveText('["https://SECRETD6tok@host/app","ops@corp.example"]'))
      .toBe('["https://[redacted]@host/app","ops@corp.example"]');
  });

  it.each([
    ['a URL', 'cloning http://SECRETD10a@SECRETD10b@host/x failed', 'SECRETD10', 'http://[redacted]@host/x failed'],
    ['a scheme-less token', 'uses SECRETD11a@SECRETD11b@host/x:1', 'SECRETD11', 'uses [redacted]@host/x:1'],
  ])('leaves no tail when a lone token holds a raw @ in %s', (_shape, input, secret, expected) => {
    const text = redactSensitiveText(input);
    expect(text).not.toContain(secret);
    expect(text).toContain(expected);
  });

  it('redacts a credential that follows a closing parenthesis', () => {
    expect(redactSensitiveText('see (a)user:SECRETD12@host/app')).toBe('see (a)[redacted]@host/app');
  });

  it.each([
    'service "s0" uses "https://SECRETD1tok@host/app:latest"',
    'service "s0" uses "ghp_SECRETD8@ghcr.io/x/app:latest"',
    'service "s0" uses "//u:SECRETD2@host/app:latest"',
  ])('is idempotent on the token-only and protocol-relative forms in %s', input => {
    const once = redactSensitiveText(input);
    expect(redactSensitiveText(once)).toBe(once);
  });

  it.each([
    ['a bare tag', 'nginx:latest'],
    ['a registry host and port', 'registry.example.com:5000/team/app:1.0'],
    ['a digest pin', 'ghcr.io/team/app:1.0@sha256:' + 'a'.repeat(64)],
    ['a digest pin with no tag', 'nginx@sha256:' + 'b'.repeat(64)],
  ])('redactImageReference leaves %s as it is', (_name, image) => {
    expect(redactImageReference(image)).toBe(image);
  });

  it.each([
    ['a token-only URL userinfo', 'https://SECRETD1tok@host/app:latest', '[redacted]@host/app:latest'],
    ['a token-only login', 'ghp_SECRETD8@ghcr.io/x/app:latest', '[redacted]@ghcr.io/x/app:latest'],
    ['a protocol-relative authority', '//u:SECRETD2@host/app:latest', '[redacted]@host/app:latest'],
    ['a space in the password', 'user:SECRETA8 @host/app:latest', '[redacted]@host/app:latest'],
    ['a slash in the password', 'https://u:p/SECRETA1w@host/app:latest', '[redacted]@host/app:latest'],
    ['a quote in the password', 'u:p"SECRETA2@host/app', '[redacted]@host/app'],
    ['a host with no path', 'u:SECRETA3@host', '[redacted]@host'],
    ['a literal @ in the password', 'u:p@SECRETQ7@host/app', '[redacted]@host/app'],
    ['a digest pin after the credential', 'u:SECRETA4@host/app:1@sha256:' + 'c'.repeat(64), '[redacted]@host/app:1@sha256:' + 'c'.repeat(64)],
  ])('redactImageReference drops %s and keeps the reference', (_name, image, expected) => {
    const out = redactImageReference(image);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/SECRET|u:p/);
  });

  // A digest shorter than any algorithm's output is not one, so the text before
  // its @ is read as a credential: the safe direction, and the reference's
  // repository is lost. Compose never prints one.
  it('redactImageReference reads a digest shorter than 32 hex characters as a credential', () => {
    expect(redactImageReference('app@sha256:abc')).toBe('[redacted]@sha256:abc');
  });

  it('redactImageReference is idempotent', () => {
    const once = redactImageReference('ghp_SECRETD8@ghcr.io/x/app:latest');
    expect(redactImageReference(once)).toBe(once);
  });

  it('redactImageReference runs in bounded time on a long run of @', () => {
    const started = Date.now();
    redactImageReference(`a${'@b'.repeat(100_000)}`);
    redactImageReference(`${'a'.repeat(100_000)}@sha256:`);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('keeps the image tail when a literal @ password is redacted', () => {
    expect(redactSensitiveText('uses u:p@SECRETQ7@host/team/app:1.0 and then nginx:latest'))
      .toBe('uses [redacted]@host/team/app:1.0 and then nginx:latest');
  });

  // The password may now hold an @, so it must not run across the quote or the
  // comma that ends one image reference and carry a digest pin into the next
  // credential-shaped text.
  it.each([
    ['a quote', '{"image":"app:1@sha256:abc","owner":"ops@corp.example/team"}', '{"image":"app:1@sha256:abc","owner":"[redacted]@corp.example/team"}'],
    ['a single quote', "['app:1.0@sha256:abc', 'mail@host/x']", "['app:1.0@sha256:abc', '[redacted]@host/x']"],
  ])('leaves a digest pin intact before %s and redacts only the later token-shaped address', (_variant, input, expected) => {
    expect(redactSensitiveText(input)).toBe(expected);
  });

  it('redacts a password after an ssh user but keeps the lone user', () => {
    expect(redactSensitiveText('ssh://git:SECRETD7@github.com/org/repo.git')).toBe('ssh://[redacted]@github.com/org/repo.git');
    expect(redactSensitiveText('git+ssh://git@github.com/org/repo.git')).toBe('git+ssh://git@github.com/org/repo.git');
  });

  it.each([
    'sftp://deploy@host:2222/srv',
    'SSH://git@github.com/org/repo.git',
    'ssh://git@10.0.0.5:2222/srv/repo.git',
  ])('keeps the lone login user of %s', input => {
    expect(redactSensitiveText(input)).toBe(input);
  });

  it('still redacts a lone token behind a scheme that merely ends in ssh', () => {
    expect(redactSensitiveText('xssh://SECRETD13tok@host/x')).toBe('xssh://[redacted]@host/x');
  });

  it.each([
    ['a comma-led run of credential shapes', ',a:b@'.repeat(20_000)],
    ['a comma-led run with no @', ',a:'.repeat(33_000)],
    ['a long password with many @', `x:${'p@'.repeat(50_000)}`],
    ['a comma-led run of lone tokens', ',a@'.repeat(50_000)],
    ['a run of lone tokens after //', '//a@'.repeat(50_000)],
    ['a long scheme userinfo with no @', `https://${'a!'.repeat(50_000)}`],
    ['a long run of @ in one token', ` ${'a@'.repeat(100_000)}`],
  ])('redacts %s in bounded time', (_shape, input) => {
    const started = Date.now();
    redactSensitiveText(input);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it.each([
    'service "a6" uses "user%40x:SECRETQ6@host/app:latest"',
    'service "a7" uses "u:p@SECRETQ7@host/app"',
    'pull failed for user%40x:p@SECRETQ8@host:5000/app',
  ])('is idempotent on %s, since a hub redacts text a node already redacted', input => {
    const once = redactSensitiveText(input);
    expect(redactSensitiveText(once)).toBe(once);
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

describe('errorMessageForLog', () => {
  it('redacts a credential-bearing image reference the error quotes', () => {
    const image = 'user:Ab/cD+eF9xyz=@registry.example.com/app:latest';
    const text = errorMessageForLog(new Error(`No such image: ${image}`), { imageRef: image });

    expect(text).not.toContain('Ab/cD+eF9xyz=');
    expect(text).toContain('[redacted]@registry.example.com/app:latest');
  });

  it('redacts the whole userinfo when the error echoes it without the host', () => {
    const image = 'user:Ab/cD+eF9xyz=@registry.example.com/app:latest';
    const text = errorMessageForLog(new Error('invalid userinfo user:Ab/cD+eF9xyz= for image'), { imageRef: image });

    expect(text).not.toContain('Ab/cD+eF9xyz=');
    expect(text).toContain('invalid userinfo [redacted] for image');
  });

  // Docker parses the reference before it reports it, so the HTTP 400 body for
  // this credential quotes only the repository name that starts after the first
  // `/`. The exact reference is absent and the text rule treats the `=` before
  // the `@` as a token boundary, which is why the helper has to remove the
  // userinfo tail on its own.
  it('redacts the rewritten userinfo fragment Docker quotes for an invalid reference', () => {
    const image = 'user:Ab/cD+eF9xyz=@registry.example.com/app:latest';
    const body =
      '(HTTP code 400) unexpected - invalid reference format: repository name (cD+eF9xyz=@registry.example.com/app) must be lowercase ';
    const text = errorMessageForLog(new Error(body), { imageRef: image });

    expect(text).not.toContain('eF9xyz');
    expect(text).not.toContain('cD+eF9xyz=');
    expect(text).toContain('must be lowercase');
    expect(text).toContain('[redacted]@registry.example.com/app');
  });

  it('redacts every slash-separated credential piece in a rewritten userinfo tail', () => {
    const image = 'user:Ab/cD/ef+GH=@registry.example.com/app:latest';
    const body =
      'invalid reference format: repository name (cD/ef+GH=@registry.example.com/app) must be lowercase';
    const text = errorMessageForLog(new Error(body), { imageRef: image });

    expect(text).not.toContain('ef+GH=');
    expect(text).not.toContain('cD');
    expect(text).toContain('must be lowercase');
  });

  it('removes a long rewritten userinfo tail in bounded time', () => {
    const image = `user:Ab${'/cD'.repeat(20_000)}=@registry.example.com/app:latest`;
    const body = `invalid reference format: repository name (${image.slice(image.indexOf('/') + 1)}@registry.example.com/app) must be lowercase`;
    const started = Date.now();
    const text = errorMessageForLog(new Error(body), { imageRef: image });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(text).not.toContain('cD/cD');
    expect(text).toContain('[redacted]@registry.example.com/app');
  });

  it('keeps a digest-pinned image reference the error quotes intact', () => {
    const image = 'ghcr.io/team/app:1.0@sha256:1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809';
    const text = errorMessageForLog(new Error(`No such image: ${image}`), { imageRef: image });

    expect(text).toBe(`No such image: ${image}`);
  });
});
