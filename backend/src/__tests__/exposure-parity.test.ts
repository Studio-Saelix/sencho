/**
 * Parity between the detected-exposure classifier and the surfaces that already
 * judge the same facts: the Compose Doctor exposure rules, the live Networking
 * findings, and the two exposed-stack counters. The classifier is not merged
 * into those engines (their fingerprints, acknowledgements and counts stay
 * exactly as they were), so this file pins them to it. Every deliberate
 * difference is named in a test of its own below.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import DockerController from '../services/DockerController';
import { DatabaseService } from '../services/DatabaseService';
import { parseEffectiveModel, type EffectiveModel } from '../services/preflight/effectiveModel';
import { runRules } from '../services/preflight/rules';
import type { PreflightContext } from '../services/preflight/types';
import { assembleStackNetworkFacts } from '../services/network/composeNetworkInspector';
import { buildNodeNetworkingFindings } from '../services/network/networkingFindings';
import { buildOverview } from '../services/network/networkingAggregate';
import { computeNodeNetworkingSummary } from '../services/network/networkingSummary';
import { intentConflicts, type DetectedPath, type DetectedServiceExposure } from '../services/network/exposureClassification';
import type { StackNetworkFacts } from '../services/network/types';

let tmpDir: string;
const STACK = 'parity';

type RawService = Record<string, unknown>;

function render(services: Record<string, RawService>): EffectiveModel {
  const withDefaults = Object.fromEntries(Object.entries(services).map(([name, svc]) => [
    name,
    svc.network_mode !== undefined ? svc : { ...svc, networks: { default: null } },
  ]));
  return parseEffectiveModel({ name: STACK, services: withDefaults, networks: { default: { name: `${STACK}_default` } } }, STACK);
}

const app: RawService = { image: 'nginx:alpine' };
const cfToken = { TUNNEL_TOKEN: 'secret-value' };

interface ParityCase {
  name: string;
  model: EffectiveModel;
  compose: string;
}

const CASES: ParityCase[] = [
  {
    name: 'a broad published port',
    model: render({ web: { ...app, ports: ['8080:80'] } }),
    compose: 'services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "8080:80"\n',
  },
  {
    name: 'a loopback-only published port',
    model: render({ web: { ...app, ports: ['127.0.0.1:8080:80'] } }),
    compose: 'services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "127.0.0.1:8080:80"\n',
  },
  {
    name: 'a broad and a loopback port together',
    model: render({ web: { ...app, ports: ['8080:80', '127.0.0.1:9000:9000'] } }),
    compose: 'services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "8080:80"\n      - "127.0.0.1:9000:9000"\n',
  },
  {
    name: 'host networking',
    model: render({ web: { ...app, network_mode: 'host' } }),
    compose: 'services:\n  web:\n    image: nginx:alpine\n    network_mode: host\n',
  },
  {
    name: 'a connector shared namespace',
    model: render({
      cf: { image: 'cloudflare/cloudflared:latest', environment: cfToken },
      app: { ...app, network_mode: 'service:cf' },
    }),
    compose: 'services:\n  cf:\n    image: cloudflare/cloudflared:latest\n    environment:\n      TUNNEL_TOKEN: secret-value\n  app:\n    image: nginx:alpine\n    network_mode: service:cf\n',
  },
  {
    name: 'a connector shared network',
    model: render({
      cf: { image: 'cloudflare/cloudflared:latest', environment: cfToken },
      app,
    }),
    compose: 'services:\n  cf:\n    image: cloudflare/cloudflared:latest\n    environment:\n      TUNNEL_TOKEN: secret-value\n  app:\n    image: nginx:alpine\n',
  },
  {
    name: 'a Tailscale node on its own',
    model: render({ ts: { image: 'tailscale/tailscale', environment: { TS_AUTHKEY: 'tskey-secret' } } }),
    compose: 'services:\n  ts:\n    image: tailscale/tailscale\n    environment:\n      TS_AUTHKEY: tskey-secret\n',
  },
  {
    name: 'a Tailscale subnet router',
    model: render({
      ts: { image: 'tailscale/tailscale', environment: { TS_AUTHKEY: 'tskey-secret', TS_ROUTES: '10.0.0.0/24' } },
      app,
    }),
    compose: 'services:\n  ts:\n    image: tailscale/tailscale\n    environment:\n      TS_AUTHKEY: tskey-secret\n      TS_ROUTES: 10.0.0.0/24\n  app:\n    image: nginx:alpine\n',
  },
  {
    name: 'a shared namespace chain',
    model: render({
      web: { ...app, ports: ['8080:80'] },
      mid: { ...app, network_mode: 'service:web' },
      top: { ...app, network_mode: 'service:mid' },
    }),
    compose: 'services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "8080:80"\n  mid:\n    image: nginx:alpine\n    network_mode: service:web\n  top:\n    image: nginx:alpine\n    network_mode: service:mid\n',
  },
];

function ctx(model: EffectiveModel, over: Partial<PreflightContext> = {}): PreflightContext {
  return {
    stackName: STACK, platform: 'linux', model, renderable: true, renderError: null, unsetEnvVars: [],
    literalDollarWarnings: [], missingEnvFiles: [], sourceServiceNames: model.services.map(s => s.name),
    sourceReadable: true, nodePorts: [], existingNetworkNames: new Set(), existingVolumeNames: new Set(),
    existingContainers: [], nodeStateAvailable: true, bindChecks: [],
    stackIntent: null, serviceIntents: {}, accessUrlPorts: new Set(), hasAccessUrls: false,
    exposureAvailable: true, isSelfStack: false, meshManaged: false, healthchecks: {}, composeVersionSkew: null,
    ...over,
  };
}

function factsOf(model: EffectiveModel): StackNetworkFacts {
  return assembleStackNetworkFacts(STACK, model, null, null);
}

function detectedOf(facts: StackNetworkFacts): Map<string, DetectedServiceExposure> {
  const out = new Map<string, DetectedServiceExposure>();
  for (const service of facts.services) if (service.detected) out.set(service.name, service.detected);
  return out;
}

/** The conflict entries a declared intent really contradicts: `via`/connector
 *  paths are notes, and fewer engines count them. */
function contradicted(intent: 'internal' | 'same-node', paths: readonly DetectedPath[], reasons: readonly string[]): boolean {
  return intentConflicts(intent, paths)
    .some(entry => entry.level !== 'note' && reasons.includes(entry.reason));
}

/** The count both the node overview and the Fleet summary use: a non-loopback
 *  own path or a tunnel path. `via` and connector paths are evidence, not
 *  exposure another stack or node can reach. */
function countsAsExposed(value: DetectedServiceExposure): boolean {
  return value.paths.some(path => path.kind === 'tunnel'
    || ((path.kind === 'host-network' || (path.kind === 'host-port' && path.scope === 'host-published')) && path.via === undefined));
}

function liveMismatch(intent: 'internal' | 'same-node', facts: StackNetworkFacts): Set<string> {
  DatabaseService.getInstance().setStackExposureIntent(1, STACK, '', intent, null);
  const findings = buildNodeNetworkingFindings(1, null, [facts], []);
  DatabaseService.getInstance().deleteStackExposureIntents(1, STACK);
  return new Set(findings.filter(f => f.kind === 'exposure-intent-mismatch').map(f => f.service ?? ''));
}

function doctorRuleServices(model: EffectiveModel, intent: 'internal' | 'same-node'): Set<string> {
  const findings = runRules(ctx(model, {
    stackIntent: intent,
    serviceIntents: {},
  }));
  return new Set(findings
    .filter(f => f.ruleId === 'exposure-internal-published' || f.ruleId === 'exposure-internal-tunneled')
    .map(f => f.service ?? ''));
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
});

afterAll(() => cleanupTestDb(tmpDir));

describe('parity with the Compose Doctor exposure rules', () => {
  for (const item of CASES) {
    it(item.name, () => {
      const facts = factsOf(item.model);
      const detected = detectedOf(facts);
      for (const intent of ['internal', 'same-node'] as const) {
        const doctor = doctorRuleServices(item.model, intent);
        for (const service of facts.services) {
          const expected = contradicted(intent, detected.get(service.name)?.paths ?? [], ['host-port', 'loopback-port', 'tunnel']);
          expect(doctor.has(service.name)).toBe(expected);
        }
      }
    });
  }

  it('keeps host networking out of the exposure rules: the network-mode-host rule owns it', () => {
    const model = render({ web: { ...app, network_mode: 'host' } });
    expect(doctorRuleServices(model, 'internal').has('web')).toBe(false);
    const findings = runRules(ctx(model, { stackIntent: 'internal' }));
    expect(findings.map(f => f.ruleId)).toContain('network-mode-host');
  });
});

describe('parity with the live Networking findings', () => {
  for (const item of CASES) {
    it(item.name, () => {
      const facts = factsOf(item.model);
      const detected = detectedOf(facts);
      for (const intent of ['internal', 'same-node'] as const) {
        const flagged = liveMismatch(intent, facts);
        for (const service of facts.services) {
          const expected = contradicted(intent, detected.get(service.name)?.paths ?? [], ['host-port', 'tunnel']);
          expect(flagged.has(service.name)).toBe(expected);
        }
      }
    });
  }

  it('leaves an internal loopback-only port to Doctor, which reads it more strictly', () => {
    const model = render({ web: { ...app, ports: ['127.0.0.1:9000:9000'] } });
    const detected = detectedOf(factsOf(model));
    expect(detected.get('web')?.conflicts.internal).toEqual([{ level: 'conflict', reason: 'loopback-port', paths: [0] }]);
    expect(doctorRuleServices(model, 'internal').has('web')).toBe(true);
    expect(liveMismatch('internal', factsOf(model)).has('web')).toBe(false);
  });

  it('keeps a temporary broad bind a live card and a note here', () => {
    const model = render({ web: { ...app, ports: ['8080:80'] } });
    const detected = detectedOf(factsOf(model));
    expect(detected.get('web')?.conflicts.temporary).toEqual([{ level: 'note', reason: 'broad-bind', paths: [0] }]);
    DatabaseService.getInstance().setStackExposureIntent(1, STACK, '', 'temporary', null);
    const findings = buildNodeNetworkingFindings(1, null, [factsOf(model)], []);
    DatabaseService.getInstance().deleteStackExposureIntents(1, STACK);
    expect(findings.filter(f => f.kind === 'exposure-intent-mismatch')).toHaveLength(1);
  });

  it('keeps a reverse-proxy broad bind a note here and the unconditional broad-bind rule in Doctor', () => {
    const model = render({ web: { ...app, ports: ['8080:80'] } });
    expect(detectedOf(factsOf(model)).get('web')?.conflicts['reverse-proxy']).toEqual([{ level: 'note', reason: 'broad-bind', paths: [0] }]);
    expect(runRules(ctx(model, { stackIntent: 'reverse-proxy' })).map(f => f.ruleId)).toContain('port-exposed-all-interfaces');
  });
});

describe('parity with the exposed-stack counters', () => {
  let stackDir: string;

  beforeEach(() => {
    stackDir = path.join(process.env.COMPOSE_DIR as string, STACK);
    fs.mkdirSync(stackDir, { recursive: true });
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockResolvedValue({ containers: [], networks: [], volumes: [] }),
    } as unknown as DockerController);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    DatabaseService.getInstance().deleteStackExposureIntents(1, STACK);
    DatabaseService.getInstance().deleteMeshStack(1, STACK);
    fs.rmSync(stackDir, { recursive: true, force: true });
  });

  for (const item of CASES) {
    it(item.name, async () => {
      const facts = factsOf(item.model);
      const expected = [...detectedOf(facts).values()].some(countsAsExposed);

      const overview = buildOverview(1, [STACK], null, [facts], [], []);
      expect(overview.exposedStackCount).toBe(expected ? 1 : 0);

      fs.writeFileSync(path.join(stackDir, 'compose.yaml'), item.compose);
      const summary = await computeNodeNetworkingSummary(1);
      expect(summary.exposed.stacks.includes(STACK)).toBe(expected);
      // Connector paths are the node's own reach, never a stack exposure.
      expect(summary.unreadable?.stacks ?? []).toEqual([]);
    });
  }
});
