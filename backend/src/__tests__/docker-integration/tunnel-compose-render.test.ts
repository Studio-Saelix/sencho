/**
 * Docker-backed: the tunnel facts the light summary reports must match a real
 * `docker compose config` render for the configuration shapes the summary
 * resolves itself (service env files, interpolation, YAML merge keys, and
 * COMPOSE_FILE layers) and report a stack whose env file is missing as unreadable.
 * Skipped automatically when Docker is unavailable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from '../helpers/setupTestDb';
import { parseEffectiveModel } from '../../services/preflight/effectiveModel';
import { deriveStackExposure } from '../../services/preflight/exposure';
import { detectTunnels, tunnelExposureByService } from '../../services/network/tunnelDetection';
import { computeNodeNetworkingSummary } from '../../services/network/networkingSummary';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 8_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();
const STACK = 'tunneltest';

function render(stackDir: string, files: string[]): unknown {
  const args = ['compose', '-p', STACK];
  for (const file of files) args.push('-f', file);
  args.push('config', '--format', 'json');
  return JSON.parse(execFileSync('docker', args, { cwd: stackDir, encoding: 'utf8', timeout: 20_000, windowsHide: true }));
}

function reachedServices(stackDir: string, files: string[]): string[] {
  const model = parseEffectiveModel(render(stackDir, files), STACK);
  return [...tunnelExposureByService(detectTunnels(model)).keys()].sort();
}

/**
 * Each case is a stack as authored. The oracle is `docker compose config`: the
 * services effective detection reaches on its output are the services the light
 * summary must report as exposed (and, with no intent set, unknown), and the
 * summary must not call the stack unreadable. The cases are the input variants
 * the summary adapts: port protocols, env-file assignments and formats, unset
 * variables, and repeated Tailscale flags. The oracle covers what Compose
 * renders; the flag cases also pass through `tailscaleForwardFlags` on both
 * sides, so Tailscale's own flag kinds are pinned by the flag-table test in
 * `tunnel-exposure.test.ts`, not here.
 */
interface ParityCase {
  name: string;
  files: Record<string, string>;
  /** Compose files to render, in order; `compose.yaml` alone by default. */
  layers?: string[];
  reached: string[];
  /** The stack is unknown-exposure without a tunnel path: it publishes a port, even on loopback. */
  publishes?: boolean;
  /** The stack is exposed without a tunnel path: it publishes a port beyond loopback. */
  exposes?: boolean;
}

const WIREGUARD = (ports: string, extra = '') => [
  'services:',
  '  wireguard:',
  '    image: lscr.io/linuxserver/wireguard:latest',
  '    ports:',
  ports,
  '  app:',
  '    image: busybox:1.36.1',
  extra,
].join('\n') + '\n';

const TAILSCALE = (service: string) => [
  'services:',
  '  ts:',
  '    image: tailscale/tailscale',
  service,
  '  app:',
  '    image: busybox:1.36.1',
  '',
].join('\n');

const CUSTOM = (service: string) => [
  'services:',
  '  edge:',
  '    image: example/edge:1',
  service,
  '  app:',
  '    image: busybox:1.36.1',
  '',
].join('\n');

const PARITY: ParityCase[] = [
  // Interpolated and differently written port protocols (a UDP WireGuard port on loopback).
  { name: 'short-form UDP on loopback', files: { 'compose.yaml': WIREGUARD('      - "127.0.0.1:51820:51820/udp"') }, reached: ['app'] },
  { name: 'long-form UDP on loopback', files: { 'compose.yaml': WIREGUARD('      - { target: 51820, published: 51820, host_ip: 127.0.0.1, protocol: udp }') }, reached: ['app'] },
  { name: 'long-form protocol from the project environment', files: { 'compose.yaml': WIREGUARD('      - { target: 51820, published: 51820, host_ip: 127.0.0.1, protocol: "${PROTO}" }'), '.env': 'PROTO=udp\n' }, reached: ['app'] },
  { name: 'short-form protocol from the project environment', files: { 'compose.yaml': WIREGUARD('      - "127.0.0.1:51820:51820/${PROTO}"'), '.env': 'PROTO=udp\n' }, reached: ['app'] },
  { name: 'long-form protocol with a default', files: { 'compose.yaml': WIREGUARD('      - { target: 51820, published: 51820, host_ip: 127.0.0.1, protocol: "${PROTO:-udp}" }') }, reached: ['app'] },
  { name: 'long-form upper-case UDP', files: { 'compose.yaml': WIREGUARD('      - { target: 51820, published: 51820, host_ip: 127.0.0.1, protocol: UDP }') }, reached: ['app'] },
  { name: 'long-form protocol that resolves to TCP', files: { 'compose.yaml': WIREGUARD('      - { target: 51820, published: 51820, host_ip: 127.0.0.1, protocol: "${PROTO}" }'), '.env': 'PROTO=tcp\n' }, reached: [], publishes: true },

  // Env-file assignments Compose resolves in order.
  {
    name: 'a required reference to an earlier assignment in the same env file',
    files: { 'compose.yaml': TAILSCALE('    env_file: ./ts.env'), 'ts.env': 'TS_AUTHKEY=tskey-secret\nARGS=--advertise-exit-node\nTS_EXTRA_ARGS=${ARGS:?must set ARGS}\n' },
    reached: ['app'],
  },
  {
    name: 'a required reference resolved through the project environment',
    files: { 'compose.yaml': TAILSCALE('    env_file: ./ts.env'), 'ts.env': 'TS_AUTHKEY=tskey-secret\nTS_EXTRA_ARGS=${ARGS:?must set ARGS}\n', '.env': 'ARGS=--advertise-routes=10.0.0.0/8\n' },
    reached: ['app'],
  },
  { name: 'a bare provider key in an env file with no value to inherit', files: { 'compose.yaml': CUSTOM('    env_file: ./edge.env'), 'edge.env': 'TUNNEL_TOKEN\n' }, reached: [] },
  { name: 'a bare provider key in an env file that inherits a project value', files: { 'compose.yaml': CUSTOM('    env_file: ./edge.env'), 'edge.env': 'TUNNEL_TOKEN\n', '.env': 'TUNNEL_TOKEN=tunnel-secret\n' }, reached: ['app'] },
  { name: 'a provider key assigned an empty value', files: { 'compose.yaml': CUSTOM('    env_file: ./edge.env'), 'edge.env': 'TUNNEL_TOKEN=\n' }, reached: ['app'] },
  {
    name: 'a raw env file keeps the quotes around a flag',
    files: { 'compose.yaml': TAILSCALE('    env_file:\n      - path: ./ts.env\n        format: raw'), 'ts.env': "TS_AUTHKEY=tskey-secret\nTS_EXTRA_ARGS='--advertise-exit-node'\n" },
    reached: [],
  },
  {
    name: 'a raw env file with an unquoted flag',
    files: { 'compose.yaml': TAILSCALE('    env_file:\n      - path: ./ts.env\n        format: raw'), 'ts.env': 'TS_AUTHKEY=tskey-secret\nTS_EXTRA_ARGS=--advertise-exit-node\n' },
    reached: ['app'],
  },

  // `environment` entries with no value.
  {
    name: 'an unresolved environment key overrides an env-file provider key',
    files: { 'compose.yaml': CUSTOM('    env_file: ./edge.env\n    environment:\n      TUNNEL_TOKEN:'), 'edge.env': 'TUNNEL_TOKEN=tunnel-secret\n' },
    reached: [],
  },
  {
    name: 'an unresolved environment key set to null removes an env-file forwarding key',
    files: { 'compose.yaml': TAILSCALE('    env_file: ./ts.env\n    environment:\n      TS_ROUTES: ~'), 'ts.env': 'TS_AUTHKEY=tskey-secret\nTS_ROUTES=10.0.0.0/8\n' },
    reached: [],
  },
  {
    name: 'a value-less environment entry in list form that the project environment answers',
    files: { 'compose.yaml': CUSTOM('    environment:\n      - TUNNEL_TOKEN'), '.env': 'TUNNEL_TOKEN=tunnel-secret\n' },
    reached: ['app'],
  },
  { name: 'a value-less environment entry in list form that nothing answers', files: { 'compose.yaml': CUSTOM('    environment:\n      - TUNNEL_TOKEN') }, reached: [] },
  { name: 'a value-less environment key in map form that nothing answers', files: { 'compose.yaml': CUSTOM('    environment:\n      TUNNEL_TOKEN:') }, reached: [] },
  {
    name: 'a later layer unsets a key an earlier layer set',
    files: { 'compose.yaml': CUSTOM('    environment:\n      TUNNEL_TOKEN: tunnel-secret'), 'override.yaml': 'services:\n  edge:\n    environment:\n      TUNNEL_TOKEN:\n' },
    layers: ['compose.yaml', 'override.yaml'],
    reached: [],
  },
  {
    name: 'a later layer sets a key an earlier layer left unset',
    files: { 'compose.yaml': CUSTOM('    environment:\n      TUNNEL_TOKEN:'), 'override.yaml': 'services:\n  edge:\n    environment:\n      TUNNEL_TOKEN: tunnel-secret\n' },
    layers: ['compose.yaml', 'override.yaml'],
    reached: ['app'],
  },

  // Duplicate environment entries, several env files, and literal dollar signs.
  { name: 'a list key with a value, then the same key with none', files: { 'compose.yaml': CUSTOM('    environment:\n      - TUNNEL_TOKEN=tunnel-secret\n      - TUNNEL_TOKEN') }, reached: [] },
  { name: 'a list key with no value, then the same key with a value', files: { 'compose.yaml': CUSTOM('    environment:\n      - TUNNEL_TOKEN\n      - TUNNEL_TOKEN=tunnel-secret') }, reached: ['app'] },
  {
    name: 'a second env file that overrides the flag the first set',
    files: { 'compose.yaml': TAILSCALE('    env_file:\n      - ./ts.env\n      - ./ts2.env'), 'ts.env': 'TS_AUTHKEY=tskey-secret\nTS_EXTRA_ARGS=--advertise-exit-node\n', 'ts2.env': 'TS_EXTRA_ARGS=--accept-dns=false\n' },
    reached: [],
  },
  {
    name: 'a second env file that assigns the name the first left bare',
    files: { 'compose.yaml': CUSTOM('    env_file:\n      - ./edge.env\n      - ./edge2.env'), 'edge.env': 'TUNNEL_TOKEN\n', 'edge2.env': 'TUNNEL_TOKEN=tunnel-secret\n' },
    reached: ['app'],
  },
  {
    name: 'a bare name in the second env file that inherits the first file\'s value',
    files: { 'compose.yaml': CUSTOM('    env_file:\n      - ./edge.env\n      - ./edge2.env'), 'edge.env': 'TUNNEL_TOKEN=tunnel-secret\n', 'edge2.env': 'TUNNEL_TOKEN\n' },
    reached: ['app'],
  },
  {
    name: 'a literal dollar sign after a disabled flag in a raw env file',
    files: { 'compose.yaml': TAILSCALE('    env_file:\n      - path: ./ts.env\n        format: raw'), 'ts.env': 'TS_AUTHKEY=tskey-secret\nTS_EXTRA_ARGS=--advertise-exit-node=true --advertise-exit-node=false --hostname=a$b\n' },
    reached: [],
  },
  {
    name: 'a literal dollar sign after a disabled flag in a single-quoted value',
    files: { 'compose.yaml': TAILSCALE('    env_file: ./ts.env'), 'ts.env': "TS_AUTHKEY=tskey-secret\nTS_EXTRA_ARGS='--advertise-exit-node=true --advertise-exit-node=false --hostname=a$b'\n" },
    reached: [],
  },
  {
    name: 'a raw env file that starts with a byte order mark',
    files: { 'compose.yaml': CUSTOM('    env_file:\n      - path: ./edge.env\n        format: raw'), 'edge.env': '\ufeffTUNNEL_TOKEN=tunnel-secret\n' },
    reached: ['app'],
  },
  {
    name: 'a null TS_EXTRA_ARGS over an env file value',
    files: { 'compose.yaml': TAILSCALE('    env_file: ./ts.env\n    environment:\n      TS_EXTRA_ARGS:'), 'ts.env': 'TS_AUTHKEY=tskey-secret\nTS_EXTRA_ARGS=--advertise-exit-node\n' },
    reached: [],
  },

  // Repeated forwarding flags with a boolean between them.
  {
    name: 'a disabled exit node after an intervening boolean flag',
    files: { 'compose.yaml': TAILSCALE('    environment:\n      TS_AUTHKEY: tskey-secret\n      TS_EXTRA_ARGS: "--advertise-exit-node=true --accept-dns --advertise-exit-node=false"') },
    reached: [],
  },
  {
    name: 'emptied routes after an intervening boolean flag',
    files: { 'compose.yaml': TAILSCALE('    environment:\n      TS_AUTHKEY: tskey-secret\n      TS_EXTRA_ARGS: "--advertise-routes=10.0.0.0/8 --accept-routes --advertise-routes="') },
    reached: [],
  },
  {
    name: 'a flag that is the value of the flag before it',
    files: { 'compose.yaml': TAILSCALE('    environment:\n      TS_AUTHKEY: tskey-secret\n      TS_EXTRA_ARGS: "--advertise-exit-node --hostname --advertise-exit-node=false"') },
    reached: ['app'],
  },
  {
    name: 'a disabled exit node after a boolean flag, in an env file',
    files: { 'compose.yaml': TAILSCALE('    env_file: ./ts.env'), 'ts.env': 'TS_AUTHKEY=tskey-secret\nTS_EXTRA_ARGS=--advertise-exit-node --accept-dns --advertise-exit-node=false\n' },
    reached: [],
  },
];

/**
 * Host ports Docker assigns at start are still published. Each DYNAMIC_PORTS form
 * renders with no `published` value, or `"0"`, and the authored reader must keep
 * it as the rendered adapter does. IPV6_FIXED_PORTS are the fixed-port forms the
 * authored reader once mis-parsed, and the `expose` and TCP cases are controls,
 * so a dynamic form is not read as every port, or as none.
 */
const DYNAMIC_PORTS: Array<[string, string]> = [
  ['a container-only short entry', '"51820/udp"'],
  ['an interface with an empty host port', '"127.0.0.1::51820/udp"'],
  ['an interface with host port 0', '"127.0.0.1:0:51820/udp"'],
  ['a long entry with no published port', '{ target: 51820, protocol: udp }'],
  ['a long entry published at 0', '{ target: 51820, published: 0, protocol: udp }'],
  ['an empty host port with no interface', '":51820/udp"'],
  ['a bracketed IPv6 interface with an empty host port', '"[::1]::51820/udp"'],
  ['an unbracketed IPv6 interface with an empty host port', '"::1::51820/udp"'],
  ['an upper-case protocol', '"51820/UDP"'],
];

const IPV6_FIXED_PORTS: Array<[string, string]> = [
  ['a bracketed IPv6 interface with a fixed host port', '"[::1]:51820:51820/udp"'],
  ['an unbracketed IPv6 interface with a fixed host port', '"::1:51820:51820/udp"'],
  ['a long entry on an IPv6 interface', '{ target: 51820, published: 51820, host_ip: "::1", protocol: udp }'],
];

const DYNAMIC_PORT_CASES: ParityCase[] = [
  ...[...DYNAMIC_PORTS, ...IPV6_FIXED_PORTS].map(([name, port]): ParityCase => ({
    name: `WireGuard published through ${name}`,
    files: { 'compose.yaml': WIREGUARD(`      - ${port}`) },
    reached: ['app'],
  })),
  {
    name: 'a plain app with an auto-assigned port is exposed and unclassified without any tunnel',
    files: { 'compose.yaml': 'services:\n  app:\n    image: busybox:1.36.1\n    ports:\n      - "8080"\n' },
    reached: [],
    publishes: true,
    exposes: true,
  },
  {
    name: 'a plain app with a loopback auto-assigned port is unclassified but not exposed',
    files: { 'compose.yaml': 'services:\n  app:\n    image: busybox:1.36.1\n    ports:\n      - "127.0.0.1::8080"\n' },
    reached: [],
    publishes: true,
  },
  { name: 'WireGuard with a dynamic TCP port is not a server', files: { 'compose.yaml': WIREGUARD('      - "127.0.0.1::51820"') }, reached: [], publishes: true },
  {
    name: 'WireGuard with `expose` only is not published',
    files: { 'compose.yaml': 'services:\n  wireguard:\n    image: lscr.io/linuxserver/wireguard:latest\n    expose:\n      - "51820/udp"\n  app:\n    image: busybox:1.36.1\n' },
    reached: [],
  },
];

const HOST_CONNECTORS: Array<[string, string]> = [
  ['Cloudflare', '    image: cloudflare/cloudflared:latest\n    command: tunnel run\n    network_mode: host\n    environment:\n      TUNNEL_TOKEN: tunnel-secret'],
  ['Tailscale', '    image: tailscale/tailscale\n    network_mode: host\n    environment:\n      TS_AUTHKEY: tskey-secret'],
  ['WireGuard', '    image: ghcr.io/wg-easy/wg-easy:15\n    network_mode: host'],
];

const HOST_APP_PORTS: Array<[string, string]> = [
  ['a container-only entry', '"8080"'],
  ['an interface with an empty host port', '"127.0.0.1::8080"'],
  ['an interface with host port 0', '"127.0.0.1:0:8080"'],
  ['a long entry with no published port', '{ target: 8080 }'],
  ['a long entry published at 0', '{ target: 8080, published: 0 }'],
  ['a fixed port', '"127.0.0.1:8080:8080"'],
];

const HOST_NETWORK_PORT_CASES: ParityCase[] = HOST_CONNECTORS.flatMap(([provider, edge]) =>
  HOST_APP_PORTS.map(([name, port]): ParityCase => ({
    name: `a ${provider} host-network connector reaches an app published through ${name}`,
    files: { 'compose.yaml': `services:\n  edge:\n${edge}\n  app:\n    image: busybox:1.36.1\n    ports:\n      - ${port}\n` },
    reached: ['app'],
  })));

/**
 * A raw env file is trimmed the way Go trims a line: U+0085 (NEL) is leading
 * space to Compose and not to JavaScript's `trimStart`. Every key the summary
 * reads from a raw file must survive it. A connector in the namespace of `app`
 * reaches it by any provider key; the forwarding keys need a bridge network.
 */
const NEL = '\u0085';
const RAW_KEYS: Array<{ name: string; image: string; line: string; namespace: boolean }> = [
  { name: 'TUNNEL_TOKEN', image: 'example/edge:1', line: 'TUNNEL_TOKEN=tunnel-secret', namespace: true },
  { name: 'TUNNEL_TOKEN_FILE', image: 'example/edge:1', line: 'TUNNEL_TOKEN_FILE=/run/secrets/token', namespace: true },
  { name: 'TS_AUTHKEY', image: 'example/edge:1', line: 'TS_AUTHKEY=tskey-secret', namespace: true },
  { name: 'TS_AUTH_KEY', image: 'example/edge:1', line: 'TS_AUTH_KEY=tskey-secret', namespace: true },
  { name: 'WG_HOST', image: 'example/edge:1', line: 'WG_HOST=vpn.example.com', namespace: true },
  { name: 'PEERS on a WireGuard image', image: 'lscr.io/linuxserver/wireguard:latest', line: 'PEERS=3', namespace: true },
  { name: 'TS_ROUTES', image: 'tailscale/tailscale', line: 'TS_ROUTES=10.0.0.0/8', namespace: false },
  { name: 'TS_SERVE_CONFIG', image: 'tailscale/tailscale', line: 'TS_SERVE_CONFIG=/config/serve.json', namespace: false },
  { name: 'TS_DEST_IP', image: 'tailscale/tailscale', line: 'TS_DEST_IP=10.0.0.5', namespace: false },
  { name: 'TS_EXTRA_ARGS', image: 'tailscale/tailscale', line: 'TS_EXTRA_ARGS=--advertise-exit-node', namespace: false },
];

const rawEdge = (image: string, namespace: boolean): string => [
  'services:',
  '  edge:',
  `    image: ${image}`,
  '    env_file:',
  '      - path: ./edge.env',
  '        format: raw',
  '  app:',
  '    image: busybox:1.36.1',
  ...(namespace ? ['    network_mode: service:edge'] : []),
  '',
].join('\n');

const RAW_WHITESPACE_CASES: ParityCase[] = [
  ...[['a leading NEL', NEL], ['a space then NEL', ` ${NEL}`]].flatMap(([what, lead]) => RAW_KEYS.map(({ name, image, line, namespace }): ParityCase => ({
    name: `${name} after ${what} in a raw env file`,
    files: { 'compose.yaml': rawEdge(image, namespace), 'edge.env': `${lead}${line}\n` },
    reached: ['app'],
  }))),
  // Controls: spaces both Compose and JavaScript trim. The zero-width space below is one neither trims.
  ...[['ASCII indentation', '  '], ['a no-break space', '\u00a0'], ['a line separator', '\u2028'], ['an ideographic space', '\u3000']].map(([what, lead]): ParityCase => ({
    name: `a key after ${what} in a raw env file`,
    files: { 'compose.yaml': rawEdge('example/edge:1', true), 'edge.env': `${lead}TUNNEL_TOKEN=tunnel-secret\n` },
    reached: ['app'],
  })),
  {
    name: 'a key after a NEL-indented comment in a raw env file',
    files: { 'compose.yaml': rawEdge('example/edge:1', true), 'edge.env': `${NEL}# note\nTUNNEL_TOKEN=tunnel-secret\n` },
    reached: ['app'],
  },
  ...[NEL, ` ${NEL}`].map((lead): ParityCase => ({
    name: `a key after ${lead === NEL ? 'a leading NEL' : 'a space then NEL'} in a dotenv env file`,
    files: { 'compose.yaml': 'services:\n  edge:\n    image: example/edge:1\n    env_file: ./edge.env\n  app:\n    image: busybox:1.36.1\n    network_mode: service:edge\n', 'edge.env': `${lead}TUNNEL_TOKEN=tunnel-secret\n` },
    reached: ['app'],
  })),
  {
    name: 'a zero-width space is part of the key, not leading space',
    files: { 'compose.yaml': rawEdge('example/edge:1', true), 'edge.env': '\u200bTUNNEL_TOKEN=tunnel-secret\n' },
    reached: [],
  },
];

describe.skipIf(!hasDocker)('the tunnel summary reads the same effective inputs Compose renders', () => {
  let tmpDir: string;
  let stackDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    stackDir = path.join(process.env.COMPOSE_DIR as string, STACK);
    fs.mkdirSync(stackDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(stackDir, { recursive: true, force: true });
    cleanupTestDb(tmpDir);
  });

  it('reads a Tailscale provider key and forwarding flag from a service env_file', async () => {
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), [
      'services:',
      '  ts:',
      '    image: tailscale/tailscale',
      '    env_file: ./ts.env',
      '  app:',
      '    image: busybox:1.36.1',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(stackDir, 'ts.env'), 'TS_AUTHKEY=tskey-secret\nTS_EXTRA_ARGS=--advertise-exit-node\n');

    expect(reachedServices(stackDir, ['compose.yaml'])).toEqual(['app']);
    const exposure = deriveStackExposure(parseEffectiveModel(render(stackDir, ['compose.yaml']), STACK), STACK, Date.now());
    expect(exposure.services.find(service => service.service === 'app')).toMatchObject({ publiclyExposed: true, reason: 'tunnel' });
    const summary = await computeNodeNetworkingSummary(1);
    expect(summary.exposed.stacks).toContain(STACK);
    expect(summary.unreadable?.stacks).not.toContain(STACK);
  });

  it('interpolates an image reference the same way Compose does', async () => {
    fs.writeFileSync(path.join(stackDir, '.env'), 'CF_IMAGE=cloudflare/cloudflared:latest\n');
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), [
      'services:',
      '  cf:',
      '    image: ${CF_IMAGE}',
      '    command: tunnel run',
      '  app:',
      '    image: busybox:1.36.1',
      '',
    ].join('\n'));

    expect(reachedServices(stackDir, ['compose.yaml'])).toEqual(['app']);
    const exposure = deriveStackExposure(parseEffectiveModel(render(stackDir, ['compose.yaml']), STACK), STACK, Date.now());
    expect(exposure.services.find(service => service.service === 'app')).toMatchObject({ publiclyExposed: true, reason: 'tunnel' });
    const summary = await computeNodeNetworkingSummary(1);
    expect(summary.exposed.stacks).toContain(STACK);
    expect(summary.unreadable?.stacks).not.toContain(STACK);
  });

  it('reads every layer COMPOSE_FILE selects', async () => {
    fs.writeFileSync(path.join(stackDir, '.env'), 'COMPOSE_FILE=compose.yaml:override.yaml\n');
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), [
      'services:',
      '  app:',
      '    image: busybox:1.36.1',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(stackDir, 'override.yaml'), [
      'services:',
      '  ts:',
      '    image: tailscale/tailscale',
      '    environment:',
      '      TS_AUTHKEY: tskey-secret',
      '      TS_EXTRA_ARGS: --advertise-exit-node',
      '',
    ].join('\n'));

    expect(reachedServices(stackDir, ['compose.yaml', 'override.yaml'])).toEqual(['app']);
    const exposure = deriveStackExposure(parseEffectiveModel(render(stackDir, ['compose.yaml', 'override.yaml']), STACK), STACK, Date.now());
    expect(exposure.services.find(service => service.service === 'app')).toMatchObject({ publiclyExposed: true, reason: 'tunnel' });
    const summary = await computeNodeNetworkingSummary(1);
    expect(summary.exposed.stacks).toContain(STACK);
    expect(summary.unreadable?.stacks).not.toContain(STACK);
  });

  it('reads a service built from a YAML merge key the way Compose renders it', async () => {
    fs.rmSync(path.join(stackDir, '.env'), { force: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), [
      'x-cf: &cf',
      '  image: cloudflare/cloudflared:latest',
      '  command: tunnel run',
      'services:',
      '  tun:',
      '    <<: *cf',
      '  app:',
      '    image: busybox:1.36.1',
      '    network_mode: service:tun',
      '',
    ].join('\n'));

    expect(reachedServices(stackDir, ['compose.yaml'])).toEqual(['app']);
    const summary = await computeNodeNetworkingSummary(1);
    expect(summary.exposed.stacks).toContain(STACK);
    expect(summary.unreadable?.stacks).not.toContain(STACK);
  });

  it('reports an input Compose itself cannot render as unreadable, never as unexposed', async () => {
    fs.rmSync(path.join(stackDir, '.env'), { force: true });
    fs.rmSync(path.join(stackDir, 'override.yaml'), { force: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), [
      'services:',
      '  ts:',
      '    image: tailscale/tailscale',
      '    env_file: ./missing.env',
      '  app:',
      '    image: busybox:1.36.1',
      '',
    ].join('\n'));

    expect(() => render(stackDir, ['compose.yaml'])).toThrow();
    const summary = await computeNodeNetworkingSummary(1);
    expect(summary.unreadable?.stacks).toContain(STACK);
    expect(summary.exposed.stacks).not.toContain(STACK);
  });

  it.each([...PARITY, ...DYNAMIC_PORT_CASES, ...HOST_NETWORK_PORT_CASES, ...RAW_WHITESPACE_CASES])('$name', async ({ files, layers = ['compose.yaml'], reached, publishes = false, exposes = false }) => {
    fs.rmSync(stackDir, { recursive: true, force: true });
    fs.mkdirSync(stackDir, { recursive: true });
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(stackDir, file), content);
    if (layers.length > 1) fs.appendFileSync(path.join(stackDir, '.env'), `COMPOSE_FILE=${layers.join(':')}\n`);

    expect(reachedServices(stackDir, layers)).toEqual(reached);
    const summary = await computeNodeNetworkingSummary(1);
    expect(summary.unreadable?.stacks).not.toContain(STACK);
    if (reached.length > 0 || exposes) expect(summary.exposed.stacks).toContain(STACK);
    else expect(summary.exposed.stacks).not.toContain(STACK);
    if (reached.length > 0 || publishes) expect(summary.unknownExposure.stacks).toContain(STACK);
    else expect(summary.unknownExposure.stacks).not.toContain(STACK);
  });
});
