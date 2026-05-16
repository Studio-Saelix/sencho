import { describe, expect, it } from 'vitest';
import * as YAML from 'yaml';
import { buildAliasHosts, generateOverrideYaml, SENCHO_MESH_NETWORK } from '../services/MeshComposeOverride';

const SENCHO_IP = '172.30.0.2';

describe('generateOverrideYaml', () => {
    it('emits services with extra_hosts pointing to the Sencho mesh IP', () => {
        const yaml = generateOverrideYaml({
            services: ['web', 'cache'],
            aliases: [
                { host: 'db.api.opsix.sencho' },
                { host: 'etl.worker.opsix.sencho' },
            ],
            senchoIp: SENCHO_IP,
        });
        const parsed = YAML.parse(yaml) as Record<string, unknown>;
        const services = parsed.services as Record<string, { extra_hosts: string[]; networks: string[] }>;
        expect(Object.keys(services).sort()).toEqual(['cache', 'web']);
        for (const svc of ['web', 'cache']) {
            expect(services[svc].extra_hosts).toEqual([
                `db.api.opsix.sencho:${SENCHO_IP}`,
                `etl.worker.opsix.sencho:${SENCHO_IP}`,
            ]);
        }
    });

    it('attaches every service to the sencho_mesh network', () => {
        const yaml = generateOverrideYaml({
            services: ['web', 'cache', 'worker'],
            aliases: [{ host: 'db.api.opsix.sencho' }],
            senchoIp: SENCHO_IP,
        });
        const parsed = YAML.parse(yaml) as Record<string, unknown>;
        const services = parsed.services as Record<string, { networks: string[] }>;
        for (const svc of ['web', 'cache', 'worker']) {
            expect(services[svc].networks).toEqual([SENCHO_MESH_NETWORK]);
        }
    });

    it('declares sencho_mesh as an external network at the top level', () => {
        const yaml = generateOverrideYaml({
            services: ['web'],
            aliases: [],
            senchoIp: SENCHO_IP,
        });
        const parsed = YAML.parse(yaml) as Record<string, unknown>;
        const networks = parsed.networks as Record<string, { external: boolean }>;
        expect(networks[SENCHO_MESH_NETWORK]).toEqual({ external: true });
    });

    it('still attaches services to the network when no aliases exist yet', () => {
        const yaml = generateOverrideYaml({
            services: ['web'],
            aliases: [],
            senchoIp: SENCHO_IP,
        });
        const parsed = YAML.parse(yaml) as Record<string, unknown>;
        const services = parsed.services as Record<string, { extra_hosts?: string[]; networks: string[] }>;
        expect(services.web.extra_hosts).toBeUndefined();
        expect(services.web.networks).toEqual([SENCHO_MESH_NETWORK]);
    });

    it('produces stable output regardless of input ordering', () => {
        const a = generateOverrideYaml({
            services: ['web', 'cache'],
            aliases: [
                { host: 'b.x.y.sencho' },
                { host: 'a.x.y.sencho' },
            ],
            senchoIp: SENCHO_IP,
        });
        const b = generateOverrideYaml({
            services: ['cache', 'web'],
            aliases: [
                { host: 'a.x.y.sencho' },
                { host: 'b.x.y.sencho' },
            ],
            senchoIp: SENCHO_IP,
        });
        expect(a).toBe(b);
    });

    it('uses the senchoIp argument verbatim in extra_hosts entries', () => {
        const customIp = '10.42.7.99';
        const yaml = generateOverrideYaml({
            services: ['web'],
            aliases: [{ host: 'svc.stack.node.sencho' }],
            senchoIp: customIp,
        });
        expect(yaml).toContain(`svc.stack.node.sencho:${customIp}`);
    });
});

describe('buildAliasHosts', () => {
    it('maps services to alias hostnames', () => {
        const out = buildAliasHosts({
            nodeName: 'opsix',
            stackName: 'api',
            services: [{ service: 'db', ports: [5432] }, { service: 'cache', ports: [6379] }],
        });
        expect(out).toEqual(['db.api.opsix.sencho', 'cache.api.opsix.sencho']);
    });
});
