/**
 * Local smart-HTTP Git server for the Git Sources E2E specs.
 *
 * Builds fixture repositories with the system git binary and serves them over
 * HTTPS, so the full clone -> pull -> apply pipeline runs without network
 * egress. Implements the two smart-HTTP endpoints the git CLI needs
 * (GET info/refs advertise + POST upload-pack) directly; git-http-backend's
 * stream internals break on modern Node.
 *
 * Git Sources requires HTTPS URLs, so the server speaks TLS with the committed
 * dev-only CA (e2e/fixtures/git-ca.pem). The backend must trust that CA via
 * NODE_EXTRA_CA_CERTS (wired in CI and in the local validation lifecycle).
 * The key is a throwaway test certificate with no security value.
 *
 * Soft-skips when the system git binary is unavailable.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';

export function gitAvailable(): boolean {
  const probe = spawnSync('git', ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

/** Build a git repository with the given files on `branch`, returns the repo dir. */
export function buildFixtureRepo(files: Record<string, string>, branch = 'main'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-e2e-repo-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const run = (args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  };
  run(['init', '-b', branch]);
  run(['config', 'user.email', 'e2e@sencho.test']);
  run(['config', 'user.name', 'Sencho E2E']);
  run(['add', '-A']);
  run(['commit', '-m', 'fixture']);
  return dir;
}

/**
 * Serve the given repos (keyed by served name) over smart HTTPS. Returns the
 * base URL; repos are reachable at `<url>/<name>.git`.
 */
export function serveRepos(
  repoDirs: Record<string, string>,
  /**
   * Basename (without extension) of the certificate pair under e2e/fixtures to
   * present. Defaults to the shared dev CA that the app also trusts globally.
   * The per-source CA spec passes a pair signed by a CA that is deliberately
   * absent from process-wide trust, so that only a stored per-source bundle
   * can make its fetch succeed.
   */
  certBasename = 'git-server',
): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-e2e-git-'));
    for (const [name, dir] of Object.entries(repoDirs)) {
      const bare = path.join(root, `${name}.git`);
      const r = spawnSync('git', ['clone', '--bare', '--quiet', dir, bare], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git clone --bare failed: ${r.stderr}`);
      repoDirs[`${name}.git`] = bare;
    }

    const fixtures = path.join(process.cwd(), 'e2e', 'fixtures');
    const server = https.createServer(
      {
        cert: fs.readFileSync(path.join(fixtures, `${certBasename}.pem`)),
        key: fs.readFileSync(path.join(fixtures, `${certBasename}.key`)),
      },
      (req, res) => {
        const url = req.url ?? '/';
        const repoName = url.split('/')[1] ?? '';
        const bare = repoDirs[repoName];
        if (!bare) {
          res.statusCode = 404;
          res.end('unknown repo');
          return;
        }
        const pathname = url.slice(url.indexOf(repoName) + repoName.length).split('?')[0];
        if (pathname === '/info/refs' && (req.method === 'GET' || req.method === 'POST')) {
          const ps = spawn('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', bare]);
          let out = Buffer.alloc(0);
          let err = '';
          ps.stdout.on('data', (d: Buffer) => {
            out = Buffer.concat([out, d]);
          });
          ps.stderr.on('data', (d: Buffer) => {
            err += d.toString();
          });
          ps.on('error', (e) => {
            console.error('[gitServer.helper] upload-pack spawn failed:', e.message);
            res.statusCode = 500;
            res.end('git upload-pack failed to start');
          });
          ps.on('close', (code) => {
            if (code !== 0) {
              console.error('[gitServer.helper] upload-pack exited', code, err);
              res.statusCode = 500;
              res.end(err || 'git upload-pack failed');
              return;
            }
            res.setHeader('content-type', 'application/x-git-upload-pack-advertisement');
            res.end(Buffer.concat([Buffer.from('001e# service=git-upload-pack\n0000'), out]));
          });
          return;
        }
        if (pathname === '/git-upload-pack' && req.method === 'POST') {
          const ps = spawn('git', ['upload-pack', '--stateless-rpc', bare]);
          res.setHeader('content-type', 'application/x-git-upload-pack-result');
          ps.stdout.pipe(res);
          ps.on('error', (e) => {
            console.error('[gitServer.helper] upload-pack spawn failed:', e.message);
            if (!res.headersSent) {
              res.statusCode = 500;
              res.end('git upload-pack failed to start');
            }
          });
          ps.stdin.on('error', () => {
            // client aborted mid-stream; the response is already ending
          });
          req.pipe(ps.stdin);
          ps.stderr.on('data', (d: Buffer) => console.error('[gitServer.helper] upload-pack stderr:', d.toString()));
          return;
        }
        res.statusCode = 404;
        res.end('unsupported git endpoint');
      },
    );
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server did not bind'));
        return;
      }
      resolve({
        url: `https://127.0.0.1:${address.port}`,
        close: () => server.close(),
      });
    });
  });
}

/** The full-project fixture: compose + env file + config + build context. */
export function fullProjectFiles(): Record<string, string> {
  return {
    'compose.yaml': `services:
  web:
    image: nginx
    env_file: web.env
    configs: [app-conf]
    build:
      context: web
configs:
  app-conf:
    file: config/app.conf
`,
    'web.env': 'FOO=bar\n',
    'config/app.conf': 'server {}\n',
    'web/.dockerignore': 'node_modules\n',
    'web/Dockerfile': 'FROM nginx\n',
    'web/index.html': '<h1>fixture</h1>\n',
  };
}

/** Multi-file fixture: base + override under a project dir. */
export function multiFileFiles(): Record<string, string> {
  return {
    'deploy/base.yaml': 'services:\n  web:\n    image: nginx\n    env_file: web.env\n',
    'deploy/prod.yaml': 'services:\n  web:\n    environment:\n      - MODE=prod\n',
    'deploy/web.env': 'FOO=bar\n',
  };
}

/** Refusal fixture: an include that escapes the repository. */
export function refusalFiles(): Record<string, string> {
  return {
    'compose.yaml': 'include:\n  - ../outside.yaml\nservices: {}\n',
  };
}
