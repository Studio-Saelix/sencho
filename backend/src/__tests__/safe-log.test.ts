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
    ['an encoded @ before the host', 'user:pw%40registry.example.com/app:latest', '[redacted]@registry.example.com/app:latest'],
    ['an encoded @ after a literal @', 'user@pw%40host/app', '[redacted]@host/app'],
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

  it.each([
    ['a space', 'user:Ab cD+eF9xyz=@registry.example.com/app:latest', 'Ab cD+eF9xyz='],
    ['a quote', 'user:p"ss/cD+eF9xyz=@registry.example.com/app:latest', 'p"ss'],
    ['a literal @', 'user:p@ss/word@registry.example.com/app:latest', 'p@ss/word'],
  ])('redacts an image credential with %s when the error echoes the whole reference', (_name, image, secret) => {
    const text = errorMessageForLog(new Error(`No such image: ${image}`), { imageRef: image });

    expect(text).not.toContain(secret);
    expect(text).toContain('[redacted]@registry.example.com/app:latest');
  });

  it('redacts a token-only userinfo the error quotes', () => {
    const image = 'ghp_SECRETD8@ghcr.io/x/app:latest';
    const text = errorMessageForLog(new Error(`No such image: ${image}`), { imageRef: image });

    expect(text).not.toContain('SECRETD8');
    expect(text).toContain('[redacted]@ghcr.io/x/app:latest');
  });

  it('redacts the whole credential-shaped userinfo when the error quotes it without the host', () => {
    const image = 'user:Ab/cD+eF9xyz=@registry.example.com/app:latest';
    const text = errorMessageForLog(new Error('invalid userinfo user:Ab/cD+eF9xyz= for image'), { imageRef: image });

    expect(text).not.toContain('Ab/cD+eF9xyz=');
    expect(text).toContain('invalid userinfo [redacted] for image');
  });

  it('redacts a long token-only userinfo when the error quotes it without the host', () => {
    const image = 'ghp_SECRETD8@ghcr.io/x/app:latest';
    const text = errorMessageForLog(new Error('invalid userinfo ghp_SECRETD8 for image'), { imageRef: image });

    expect(text).not.toContain('SECRETD8');
    expect(text).toContain('invalid userinfo [redacted] for image');
  });

  // The HTTP 400 body Docker 29.9.3 returns for this credential quotes only the
  // repository name that starts after the first `/`. The exact reference is
  // absent and the text rule treats the `=` before the `@` as a token boundary,
  // which is why the helper has to remove the userinfo tail on its own.
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

  // Docker 29.9.3 parses the reference before it validates case and quotes the
  // parsed repository name, cut at the first `:`. The quote starts after the
  // credential's first `/` when Docker reads that component as a domain and at
  // the start of the reference otherwise. A colon inside the password truncates
  // the quote before the host's `@`, so the anchored fragment above can no
  // longer match it.
  it.each([
    [
      'a long prefix',
      'user:Ab/cD+eF9xyz=:x@registry.example.com/app:latest',
      'cD+eF9xyz=',
      '(HTTP code 400) unexpected - invalid reference format: repository name (cD+eF9xyz=) must be lowercase ',
    ],
    [
      'a mixed-case word',
      'user:deploy/SuperSecret:x@registry.example.com/app:latest',
      'SuperSecret',
      'invalid reference format: repository name (SuperSecret) must be lowercase',
    ],
    [
      'a short prefix',
      'user:deploy/Pass:x@registry.example.com/app:latest',
      'Pass',
      'invalid reference format: repository name (Pass) must be lowercase',
    ],
    [
      'a multi-segment tail',
      'user:Ab/cD/ef:gh@registry.example.com/app:latest',
      'cD/ef',
      'invalid reference format: repository name (cD/ef) must be lowercase',
    ],
    [
      'a literal @ in the prefix',
      'user:p/ss@Word:x@registry.example.com/app:latest',
      'ss@Word',
      'invalid reference format: repository name (ss@Word) must be lowercase',
    ],
    [
      'a space in the prefix',
      'user:Ab/Super Secret:x@registry.example.com/app:latest',
      'Super Secret',
      'invalid reference format: repository name (Super Secret) must be lowercase',
    ],
    [
      'a second colon after the prefix',
      'user:Ab/cD+eF9xyz=:x:y@registry.example.com/app:latest',
      'cD+eF9xyz=',
      'invalid reference format: repository name (cD+eF9xyz=) must be lowercase',
    ],
    [
      'a token-only first segment',
      'tokenonly/SuperSecret:x@registry.example.com/app:latest',
      'SuperSecret',
      'invalid reference format: repository name (tokenonly/SuperSecret) must be lowercase',
    ],
    [
      'a token-only first segment with a multi-segment tail',
      'tokenonly/foo/Pass:x@registry.example.com/app:latest',
      'Pass',
      'invalid reference format: repository name (tokenonly/foo/Pass) must be lowercase',
    ],
    [
      'an uppercase first segment',
      'TokenOnly/Pass:x@registry.example.com/app:latest',
      'Pass',
      'invalid reference format: repository name (Pass) must be lowercase',
    ],
    [
      'a digest pin',
      'user:Ab/cD+eF9xyz=:x@registry.example.com/app:latest@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'cD+eF9xyz=',
      'invalid reference format: repository name (cD+eF9xyz=) must be lowercase',
    ],
  ])('redacts the colon-cut repository name Docker quotes for %s', (_name, image, secret, body) => {
    const text = errorMessageForLog(new Error(body), { imageRef: image });

    expect(text).not.toContain(secret);
    expect(text).toContain('repository name ([redacted])');
    expect(text).toContain('must be lowercase');
  });

  it('does not rewrite a short colon-cut prefix outside the quoted repository name', () => {
    const image = 'user:deploy/Pass:x@registry.example.com/app:latest';
    const body =
      'invalid reference format: repository name (Pass) must be lowercase; retry Pass later';
    const text = errorMessageForLog(new Error(body), { imageRef: image });

    expect(text).toContain('repository name ([redacted])');
    expect(text).toContain('retry Pass later');
  });

  it('is idempotent on a colon-cut repository name', () => {
    const image = 'user:Ab/cD+eF9xyz=:x@registry.example.com/app:latest';
    const body =
      '(HTTP code 400) unexpected - invalid reference format: repository name (cD+eF9xyz=) must be lowercase ';
    const once = errorMessageForLog(new Error(body), { imageRef: image });

    expect(once).not.toContain('cD+eF9xyz=');
    expect(once).toContain('repository name ([redacted])');
    expect(errorMessageForLog(new Error(once), { imageRef: image })).toBe(once);
  });

  it('removes a long colon-cut repository name in bounded time', () => {
    const quotedTail = `cD${'/cD'.repeat(20_000)}=`;
    const image = `user:Ab/${quotedTail}:x@registry.example.com/app:latest`;
    const body = `invalid reference format: repository name (${quotedTail}) must be lowercase`;
    const started = Date.now();
    const text = errorMessageForLog(new Error(body), { imageRef: image });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(text).not.toContain(quotedTail);
    expect(text).toContain('repository name ([redacted])');
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

  // A short password piece must only be replaced where it is echoed as part of
  // the reference, not inside every word that happens to contain it.
  it('does not rewrite unrelated words when a short password piece repeats', () => {
    const image = 'user:Ab/c@registry.example.com/app:latest';
    const body = 'invalid reference format: repository name (c@registry.example.com/app) must be lowercase';
    const text = errorMessageForLog(new Error(body), { imageRef: image });

    expect(text).toContain('reference format');
    expect(text).toContain('lowercase');
    expect(text).not.toContain('c@registry');
    expect(text).toContain('[redacted]@registry.example.com/app');
  });

  it('does not rewrite a short token-only userinfo elsewhere in the message', () => {
    const image = 'bot@ghcr.io/x/app:latest';
    const body =
      'unauthorized: bot access denied; retry bot later; No such image: bot@ghcr.io/x/app:latest';
    const text = errorMessageForLog(new Error(body), { imageRef: image });

    expect(text).toContain('bot access denied');
    expect(text).toContain('retry bot later');
    expect(text).not.toContain('bot@ghcr.io');
    expect(text).toContain('[redacted]@ghcr.io/x/app:latest');
  });

  it('removes a long rewritten userinfo tail in bounded time', () => {
    const image = `user:Ab${'/cD'.repeat(20_000)}=@registry.example.com/app:latest`;
    const tail = image.slice(image.indexOf('/') + 1, image.lastIndexOf('@'));
    const body = `invalid reference format: repository name (${tail}@registry.example.com/app) must be lowercase`;
    const started = Date.now();
    const text = errorMessageForLog(new Error(body), { imageRef: image });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(text).not.toContain('cD/cD');
    expect(text).toContain('[redacted]@registry.example.com/app');
  });

  it('is idempotent on a rewritten userinfo tail', () => {
    const image = 'user:Ab/cD+eF9xyz=@registry.example.com/app:latest';
    const body =
      'invalid reference format: repository name (cD+eF9xyz=@registry.example.com/app) must be lowercase';
    const once = errorMessageForLog(new Error(body), { imageRef: image });

    expect(errorMessageForLog(new Error(once), { imageRef: image })).toBe(once);
  });

  // Docker decodes the image request path once before its reference parser
  // runs, and the parser normalizes a familiar Docker Hub name. The daemon can
  // therefore quote a spelling the Compose file never held.
  it.each([
    [
      'an encoded slash',
      'user:Ab%2fSuperSecret:x@registry.example.com/app:latest',
      'SuperSecret',
      'invalid reference format: repository name (SuperSecret) must be lowercase',
    ],
    [
      'an encoded letter',
      'user:Ab/Super%53ecret:x@registry.example.com/app:latest',
      'SuperSecret',
      'invalid reference format: repository name (SuperSecret) must be lowercase',
    ],
    [
      'an encoded colon',
      'user:Ab/SuperSecret%3ax@registry.example.com/app:latest',
      'SuperSecret',
      'invalid reference format: repository name (SuperSecret) must be lowercase',
    ],
    [
      'a closing parenthesis in the quoted name',
      'user:Ab%2fx)SuperSecret:y@registry.example.com/app:latest',
      'SuperSecret',
      'invalid reference format: repository name (x)SuperSecret) must be lowercase',
    ],
    [
      'normalization plus an encoded slash',
      'docker.io/Ab%2fPass:x@registry.example.com/app:latest',
      'Pass',
      'invalid reference format: repository name (Ab/Pass) must be lowercase',
    ],
    [
      'an encoded token-only multi-segment prefix',
      't%6fkenonly/foo%2fSuperSecret:x@registry.example.com/app:latest',
      'tokenonly/foo/SuperSecret',
      'invalid reference format: repository name (tokenonly/foo/SuperSecret) must be lowercase',
    ],
    [
      'an encoded digest pin',
      `user:Ab%2fSuperSecret:x@registry.example.com/app:latest@sha256:${'a'.repeat(64)}`,
      'SuperSecret',
      'invalid reference format: repository name (SuperSecret) must be lowercase',
    ],
  ])('redacts the Docker-decoded repository name for %s', (_name, image, secret, body) => {
    const text = errorMessageForLog(new Error(body), { imageRef: image });

    expect(text).not.toContain(secret);
    expect(text).not.toContain('%2f');
    expect(text).not.toContain('%53');
    expect(text).toContain('repository name ([redacted])');
    expect(text).toContain('must be lowercase');
  });

  it.each([
    ['a canonical Docker Hub name', 'docker.io/Pass:x@registry.example.com'],
    ['the legacy Docker Hub index domain', 'index.docker.io/Pass:x@registry.example.com'],
  ])('redacts the normalized repository name for %s', (_name, image) => {
    const body = 'invalid reference format: repository name (library/Pass) must be lowercase';
    const text = errorMessageForLog(new Error(body), { imageRef: image });

    expect(text).not.toContain('Pass');
    expect(text).toContain('repository name ([redacted])');
    expect(text).toContain('must be lowercase');
  });

  // A percent escape can decode to a byte that is not valid UTF-8. Docker's
  // JSON error body rewrites that byte as U+FFFD, so the quoted name no longer
  // equals any spelling the helper can reconstruct. The structured field must
  // still lose the credential.
  it('redacts a quoted repository name the decoder cannot reproduce', () => {
    const image = 'user:Ab%2f%FFSuperSecret:x@registry.example.com/app:latest';
    const body = 'invalid reference format: repository name (\uFFFDSuperSecret) must be lowercase';
    const text = errorMessageForLog(new Error(body), { imageRef: image });

    expect(text).not.toContain('SuperSecret');
    expect(text).toContain('repository name ([redacted])');
    expect(text).toContain('must be lowercase');
  });

  it('leaves a quoted repository name intact when the reference carries no credential', () => {
    const image = 'registry.example.com/App:latest';
    const body = 'invalid reference format: repository name (App) must be lowercase';
    const text = errorMessageForLog(new Error(body), { imageRef: image });

    expect(text).toContain('repository name (App)');
  });

  // A credential can contain the literal redaction marker. Treating that text
  // as proof the field was already redacted left the credential tail in the
  // log, so only the marker followed by a validated part of the
  // credential-free reference may keep its context.
  it.each([
    [
      'before the credential',
      'user:Ab/[redacted]SuperSecret:x@registry.example.com/app:latest',
      '[redacted]SuperSecret',
      'SuperSecret',
    ],
    [
      'between the credential pieces',
      'user:Ab/Super[redacted]Secret:x@registry.example.com/app:latest',
      'Super[redacted]Secret',
      'Secret',
    ],
    [
      'after the credential',
      'user:Ab/SuperSecret[redacted]:x@registry.example.com/app:latest',
      'SuperSecret[redacted]',
      'SuperSecret',
    ],
    [
      'in a token-only userinfo',
      '[redacted]SuperSecret@ghcr.io/x/app:latest',
      '[redacted]SuperSecret',
      'SuperSecret',
    ],
    [
      'behind an encoded slash',
      'user:Ab%2f[redacted]SuperSecret:x@registry.example.com/app:latest',
      '[redacted]SuperSecret',
      'SuperSecret',
    ],
    [
      'as an encoded marker',
      'user:Ab/%5Bredacted%5DSuperSecret:x@registry.example.com/app:latest',
      '[redacted]SuperSecret',
      'SuperSecret',
    ],
    [
      'as an encoded marker between the credential pieces',
      'user:Ab/Super%5Bredacted%5DSecret:x@registry.example.com/app:latest',
      'Super[redacted]Secret',
      'Secret',
    ],
    [
      'as an encoded marker after the credential',
      'user:Ab/SuperSecret%5Bredacted%5D:x@registry.example.com/app:latest',
      'SuperSecret[redacted]',
      'SuperSecret',
    ],
    [
      'on a digest-pinned credential',
      `user:Ab/[redacted]SuperSecret:x@registry.example.com/app:latest@sha256:${'a'.repeat(64)}`,
      '[redacted]SuperSecret',
      'SuperSecret',
    ],
    [
      'beside an embedded close parenthesis',
      'user:Ab/[redacted]x)SuperSecret:y@registry.example.com/app:latest',
      '[redacted]x)SuperSecret',
      'SuperSecret',
    ],
    [
      'in a normalized Docker Hub name',
      'docker.io/[redacted]Pass:x@registry.example.com',
      'library/[redacted]Pass',
      'Pass',
    ],
    [
      'after an invalid byte Docker rewrites',
      'user:Ab%2f%FF[redacted]SuperSecret:x@registry.example.com/app:latest',
      '\uFFFD[redacted]SuperSecret',
      'SuperSecret',
    ],
  ])('redacts a quoted name whose credential contains the marker for %s', (_name, image, quoted, secret) => {
    const body = `invalid reference format: repository name (${quoted}) must be lowercase`;
    const text = errorMessageForLog(new Error(body), { imageRef: image });

    expect(text).not.toContain(secret);
    expect(text).toContain('repository name ([redacted])');
    expect(text).toContain('must be lowercase');
  });

  // Without a known suffix the closing parenthesis is ambiguous: the name can
  // hold one, and a marker inside it must not make the scan stop at the wrong
  // one and leave the tail behind.
  it.each([
    ['a marker before the credential', 'repository name ([redacted]x)SuperSecret)', 'SuperSecret'],
    ['a marker between the credential pieces', 'repository name (Super[redacted]Secret)', 'Secret'],
    ['a marker after the credential', 'repository name (SuperSecret[redacted])', 'SuperSecret'],
  ])('redacts a marker-bearing quoted name with no known suffix for %s', (_name, quoted, secret) => {
    const image = 'user:Ab/[redacted]SuperSecret:x@registry.example.com/app:latest';
    const text = errorMessageForLog(new Error(`invalid reference format: ${quoted}`), { imageRef: image });

    expect(text).not.toContain(secret);
    expect(text).toContain('repository name ([redacted])');
  });

  it('redacts past a marker-bearing field with no suffix to a later field', () => {
    const image = 'user:Ab/[redacted]Foo:x@registry.example.com/app:latest';
    const body =
      'invalid reference format: repository name ([redacted]Foo) retry: repository name (x)SuperSecret)';
    const text = errorMessageForLog(new Error(body), { imageRef: image });

    expect(text).not.toContain('SuperSecret');
    expect(text).not.toContain('[redacted]Foo');
    expect(text).toContain('repository name ([redacted])');
  });

  it('redacts every field when a marker-bearing field makes the suffix scan span them', () => {
    const image = 'user:Ab/[redacted]Foo:x@registry.example.com/app:latest';
    const body =
      'invalid reference format: repository name ([redacted]Foo) must be lowercase: repository name (x)SuperSecret) must be lowercase';
    const text = errorMessageForLog(new Error(body), { imageRef: image });

    expect(text).not.toContain('SuperSecret');
    expect(text).not.toContain('[redacted]Foo');
    expect(text).toContain('repository name ([redacted])');
    expect(text).toContain('must be lowercase');
  });

  it('redacts a cause message whose field follows an already-redacted field', () => {
    const image = 'user:Ab/cD+eF9xyz=@registry.example.com/app:latest';
    const error = new Error(
      'invalid reference format: repository name (cD+eF9xyz=@registry.example.com/app) must be lowercase',
      {
        cause: new Error(
          'invalid reference format: repository name ([redacted]x)SuperSecret) must be lowercase',
        ),
      },
    );
    const text = errorMessageForLog(error, { imageRef: image });

    expect(text).not.toContain('eF9xyz');
    expect(text).not.toContain('SuperSecret');
    expect(text).toContain('must be lowercase');
  });

  it('is idempotent after redacting a marker-bearing quoted name', () => {
    const image = 'user:Ab/[redacted]SuperSecret:x@registry.example.com/app:latest';
    const body = 'invalid reference format: repository name ([redacted]SuperSecret) must be lowercase';
    const once = errorMessageForLog(new Error(body), { imageRef: image });

    expect(once).not.toContain('SuperSecret');
    expect(errorMessageForLog(new Error(once), { imageRef: image })).toBe(once);
  });

  it('redacts a colon-free token the daemon splits with a decoded slash', () => {
    const image = 'ghp_ab%2fSuperSecret@registry.example.com/app:latest';
    const body =
      'invalid reference format: repository name (ghp_ab/SuperSecret@registry.example.com/app) must be lowercase';
    const text = errorMessageForLog(new Error(body), { imageRef: image });

    expect(text).not.toContain('SuperSecret');
    expect(text).toContain('[redacted]@registry.example.com/app');
    expect(text).toContain('must be lowercase');
  });

  it('redacts a percent-decoded reference the error echoes', () => {
    const image = 'user:Ab%2fSuperSecret:x@registry.example.com/app:latest';
    const text = errorMessageForLog(
      new Error('No such image: user:Ab/SuperSecret:x@registry.example.com/app:latest'),
      { imageRef: image },
    );

    expect(text).not.toContain('SuperSecret');
    expect(text).toContain('[redacted]@registry.example.com/app:latest');
  });

  it('redacts an echoed reference whose invalid byte became U+FFFD', () => {
    const image = 'user:Ab%2f%FFSuperSecret:x@registry.example.com/app:latest';
    const text = errorMessageForLog(
      new Error('No such image: user:Ab/\uFFFDSuperSecret:x@registry.example.com/app:latest'),
      { imageRef: image },
    );

    expect(text).not.toContain('SuperSecret');
    expect(text).toContain('[redacted]@registry.example.com/app:latest');
  });

  it('redacts an echoed reference whose truncated multi-byte sequence became U+FFFD', () => {
    const image = 'user:Ab%2f%E2%82SuperSecret:x@registry.example.com/app:latest';
    const text = errorMessageForLog(
      new Error('No such image: user:Ab/\uFFFD\uFFFDSuperSecret:x@registry.example.com/app:latest'),
      { imageRef: image },
    );

    expect(text).not.toContain('SuperSecret');
    expect(text).not.toContain('user:Ab/');
    expect(text).toContain('No such image: [redacted]@registry.example.com/app:latest');
  });

  it('decodes the valid escapes of an image with a malformed one', () => {
    const image = 'user:Ab%2fSuperSecret:x@registry.example.com/app%zz:latest';
    const text = errorMessageForLog(
      new Error('invalid userinfo user:Ab/SuperSecret:x for image'),
      { imageRef: image },
    );

    expect(text).not.toContain('SuperSecret');
    expect(text).toContain('invalid userinfo [redacted] for image');
  });

  it('redacts a decoded userinfo the error quotes without the host', () => {
    const image = 'user:Ab%2fSuperSecret:x@registry.example.com/app:latest';
    const text = errorMessageForLog(
      new Error('invalid userinfo user:Ab/SuperSecret:x for image'),
      { imageRef: image },
    );

    expect(text).not.toContain('SuperSecret');
    expect(text).toContain('invalid userinfo [redacted] for image');
  });

  it('is idempotent on a Docker-decoded repository name', () => {
    const image = 'user:Ab%2fSuperSecret:x@registry.example.com/app:latest';
    const body = 'invalid reference format: repository name (SuperSecret) must be lowercase';
    const once = errorMessageForLog(new Error(body), { imageRef: image });

    expect(once).toContain('repository name ([redacted])');
    expect(errorMessageForLog(new Error(once), { imageRef: image })).toBe(once);
  });

  it('redacts a hostile run of repository-name phrases in bounded time', () => {
    const image = 'user:Ab%2fSuperSecret:x@registry.example.com/app:latest';
    const body = `${'repository name (a'.repeat(50_000)}repository name (SuperSecret) must be lowercase`;
    const started = Date.now();
    const text = errorMessageForLog(new Error(body), { imageRef: image });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(text).not.toContain('SuperSecret');
    expect(text).toContain('repository name ([redacted]) must be lowercase');
  });

  it('redacts a hostile run of unterminated repository-name phrases in bounded time', () => {
    const image = 'user:Ab%2fSuperSecret:x@registry.example.com/app:latest';
    const body = `repository name (SuperSecret) must be lowercase${'repository name (a'.repeat(50_000)}`;
    const started = Date.now();
    const text = errorMessageForLog(new Error(body), { imageRef: image });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(text).not.toContain('SuperSecret');
  });

  it('removes a long percent-encoded repository name in bounded time', () => {
    const encodedTail = `cD${'%2fcD'.repeat(20_000)}=`;
    const decodedTail = encodedTail.replace(/%2f/g, '/');
    const image = `user:Ab/${encodedTail}:x@registry.example.com/app:latest`;
    const body = `invalid reference format: repository name (${decodedTail}) must be lowercase`;
    const started = Date.now();
    const text = errorMessageForLog(new Error(body), { imageRef: image });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(text).not.toContain(decodedTail);
    expect(text).toContain('repository name ([redacted])');
  });

  it('keeps a digest-pinned image reference the error quotes intact', () => {
    const image = 'ghcr.io/team/app:1.0@sha256:1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809';
    const text = errorMessageForLog(new Error(`No such image: ${image}`), { imageRef: image });

    expect(text).toBe(`No such image: ${image}`);
  });

  it('keeps a digest pin on a credential-bearing reference it redacts', () => {
    const digest = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const image = `user:Ab/cD+eF9xyz=:x@registry.example.com/app:latest@${digest}`;
    const text = errorMessageForLog(new Error(`No such image: ${image}`), { imageRef: image });

    expect(text).not.toContain('cD+eF9xyz=');
    expect(text).toContain(`[redacted]@registry.example.com/app:latest@${digest}`);
  });
});
