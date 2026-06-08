import { describe, it, expect } from 'vitest';
import { buildFleetDossier, type FleetDossierInput } from './fleetDossier';
import { EMPTY_DOSSIER_FIELDS, type StackDossierFields } from './dossierMarkdown';
import type { AnatomyMarkdownInput } from './anatomyMarkdown';

const fields = (over: Partial<StackDossierFields> = {}): StackDossierFields => ({ ...EMPTY_DOSSIER_FIELDS, ...over });

const plexAnatomy: AnatomyMarkdownInput = {
  stackName: 'plex',
  services: ['plex'],
  ports: { plex: [{ host: '32400', container: '32400', proto: 'tcp' }] },
  volumes: { plex: [{ host: './config', container: '/config' }] },
  restart: 'unless-stopped',
  envFile: '.env',
  envVarCount: 3,
  missingVars: ['CLAIM_TOKEN'],
  networkName: 'media',
  gitSource: null,
};

const input = (): FleetDossierInput => ({
  generatedAt: '2026-06-07T00:00:00.000Z',
  senchoVersion: '0.90.0',
  nodes: [
    {
      id: 1,
      name: 'local',
      type: 'local',
      reachable: true,
      stacks: [
        {
          stackName: 'plex',
          anatomy: plexAnatomy,
          dossier: fields({
            purpose: 'Media server',
            access_urls: 'https://plex.example',
            static_ip: '10.0.10.4',
            vlan: '10',
            firewall_notes: '32400 open on LAN',
          }),
        },
        { stackName: 'broken', anatomy: null, dossier: fields({ purpose: 'unparseable but documented' }) },
      ],
    },
    { id: 2, name: 'media-node', type: 'remote', reachable: false, skipReason: 'node offline' },
  ],
});

describe('buildFleetDossier', () => {
  it('emits index, network, a node page per node, and a stack page per reachable stack', () => {
    const files = buildFleetDossier(input());
    expect(Object.keys(files).sort()).toEqual([
      'index.md',
      'network.md',
      'nodes/local.md',
      'nodes/media-node.md',
      'stacks/local--broken.md',
      'stacks/local--plex.md',
    ]);
  });

  it('lists nodes and an explicit skipped section with reasons in index.md', () => {
    const md = buildFleetDossier(input())['index.md'];
    expect(md).toContain('# Homelab Dossier');
    expect(md).toContain('_Generated 2026-06-07T00:00:00.000Z · Sencho 0.90.0_');
    expect(md).toContain('| [local](nodes/local.md) | local | reachable | 2 |');
    expect(md).toContain('| [media-node](nodes/media-node.md) | remote | unreachable | - |');
    expect(md).toContain('## Skipped nodes');
    expect(md).toContain('- **media-node** (remote): node offline');
  });

  it('omits the skipped section when every node is reachable', () => {
    const data = input();
    data.nodes = [data.nodes[0]];
    expect(buildFleetDossier(data)['index.md']).not.toContain('## Skipped nodes');
  });

  it('reuses the stack dossier generator for a parseable stack', () => {
    const md = buildFleetDossier(input())['stacks/local--plex.md'];
    expect(md).toContain('# plex');
    expect(md).toContain('| plex | 32400 | 32400 | tcp |');
    expect(md).toContain('## Operator notes');
    expect(md).toContain('- **Purpose:** Media server');
  });

  it('emits a stub page with operator notes when compose cannot be parsed', () => {
    const md = buildFleetDossier(input())['stacks/local--broken.md'];
    expect(md).toContain('# broken');
    expect(md).toContain('compose.yaml could not be parsed');
    expect(md).toContain('- **Purpose:** unparseable but documented');
  });

  it('aggregates port, volume, network, env, access-URL, and infra maps in network.md', () => {
    const md = buildFleetDossier(input())['network.md'];
    expect(md).toContain('## Port map');
    expect(md).toContain('| local | plex | plex | 32400 | 32400 | tcp |');
    expect(md).toContain('## Volume map');
    expect(md).toContain('| local | plex | plex | ./config | /config |');
    expect(md).toContain('## Network map');
    expect(md).toContain('| local | plex | media |');
    expect(md).toContain('## Environment checklist');
    expect(md).toContain('| local | plex | .env | 3 | CLAIM_TOKEN |');
    expect(md).toContain('## Access URLs');
    expect(md).toContain('| local | plex | https://plex.example |');
    expect(md).toContain('## VLAN / static IP / firewall');
    expect(md).toContain('| local | plex | 10.0.10.4 | 10 | 32400 open on LAN |');
  });

  it('renders _none_ for empty map sections', () => {
    const md = buildFleetDossier({
      generatedAt: 't', senchoVersion: 'v',
      nodes: [{ id: 1, name: 'n', type: 'local', reachable: true, stacks: [] }],
    })['network.md'];
    expect(md).toContain('## Port map\n\n_none_');
  });

  it('disambiguates colliding node slugs with the node id', () => {
    const files = buildFleetDossier({
      generatedAt: 't', senchoVersion: 'v',
      nodes: [
        { id: 1, name: 'Media Node', type: 'local', reachable: true, stacks: [] },
        { id: 2, name: 'media node', type: 'remote', reachable: false, skipReason: 'x' },
      ],
    });
    expect(files['nodes/media-node.md']).toBeDefined();
    expect(files['nodes/media-node-2.md']).toBeDefined();
  });

  it('aggregates rows from every reachable node and stack in network.md', () => {
    const md = buildFleetDossier({
      generatedAt: 't', senchoVersion: 'v',
      nodes: [
        {
          id: 1, name: 'alpha', type: 'local', reachable: true,
          stacks: [{ stackName: 'plex', anatomy: plexAnatomy, dossier: fields() }],
        },
        {
          id: 2, name: 'beta', type: 'remote', reachable: true,
          stacks: [{
            stackName: 'grafana',
            anatomy: { ...plexAnatomy, stackName: 'grafana', ports: { grafana: [{ host: '3000', container: '3000', proto: 'tcp' }] }, volumes: {}, networkName: 'grafana_net' },
            dossier: fields(),
          }],
        },
        { id: 3, name: 'gamma', type: 'remote', reachable: false, skipReason: 'node offline' },
      ],
    })['network.md'];
    // One port row from each reachable node; the offline node contributes nothing.
    expect(md).toContain('| alpha | plex | plex | 32400 | 32400 | tcp |');
    expect(md).toContain('| beta | grafana | grafana | 3000 | 3000 | tcp |');
    expect(md).not.toContain('gamma');
  });

  it('escapes pipe characters in node and stack names so tables stay intact', () => {
    const files = buildFleetDossier({
      generatedAt: 't', senchoVersion: 'v',
      nodes: [{
        id: 1, name: 'node|x', type: 'local', reachable: true,
        stacks: [{ stackName: 'app', anatomy: { ...plexAnatomy, stackName: 'app' }, dossier: fields() }],
      }],
    });
    expect(files['index.md']).toContain('node\\|x');
    expect(files['network.md']).toContain('| node\\|x | app |');
  });

  it('never leaks .env values and is deterministic', () => {
    const data = input();
    // Even if anatomy somehow carried no values, prove the export contains only key names/counts.
    const a = buildFleetDossier(data);
    const b = buildFleetDossier(input());
    expect(a['network.md']).toBe(b['network.md']);
    expect(a['index.md']).toBe(b['index.md']);
    expect(JSON.stringify(a)).not.toMatch(/CLAIM_TOKEN\s*=/);
  });
});
