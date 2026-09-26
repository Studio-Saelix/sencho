import * as YAML from 'yaml';

/**
 * Sencho Mesh Compose override generator.
 *
 * Produces a YAML override applied with `docker compose -f compose.yml -f
 * mesh.override.yml up` that:
 *   - injects cross-node alias entries into each opted-in service's
 *     `/etc/hosts`, resolving every alias to the Sencho container's
 *     static IP on the internal `sencho_mesh` Docker network;
 *   - attaches each service to `sencho_mesh` so that IP is reachable
 *     from inside the user's container.
 *
 * The user's source compose file is never mutated; the override lives in
 * Sencho's data dir and is regenerated whenever the alias set changes.
 */

export const SENCHO_MESH_NETWORK = 'sencho_mesh';

export interface MeshAlias {
    /** `<service>.<stack>.<nodeName>.sencho` */
    host: string;
}

/**
 * Network shape of one service as declared in the user's compose file.
 * Drives how the override attaches the service to `sencho_mesh` without
 * changing the service's existing connectivity.
 */
export interface MeshServiceNetworkShape {
    /** Raw `network_mode` value (`host`, `none`, `service:vpn`, `container:x`, ...). */
    networkMode?: string;
    /** True when the service declares its own `networks:` key. */
    declaresNetworks: boolean;
}

export interface MeshOverrideInput {
    /** Service names from the user's compose file (the override echoes them). */
    services: string[];
    /**
     * Per-service network shape from the compose file. A service missing
     * from the map is treated as using Compose's implicit `default` network.
     */
    serviceShapes?: Record<string, MeshServiceNetworkShape>;
    /** Aliases this stack should be able to resolve. Order is normalized in output. */
    aliases: MeshAlias[];
    /** Sencho's static IP on the `sencho_mesh` Docker network. */
    senchoIp: string;
}

/**
 * Returns a YAML string suitable for `-f mesh.override.yml`. Stable output
 * ordering so file content does not churn between deploys.
 */
export function generateOverrideYaml(input: MeshOverrideInput): string {
    const sortedServices = [...input.services].sort();
    const sortedAliases = [...input.aliases].sort((a, b) => a.host.localeCompare(b.host));

    const services: Record<string, unknown> = {};
    for (const svc of sortedServices) {
        const shape = input.serviceShapes?.[svc];
        // `network_mode` (host, none, service:vpn, container:x) cannot be
        // combined with `networks:` or `extra_hosts`; Compose rejects the
        // deploy. Such services share another namespace and are left alone.
        if (shape?.networkMode) continue;
        // A service without its own `networks:` key sits on the implicit
        // `default` network. Listing only `sencho_mesh` in the override would
        // replace that attachment and cut the service off from the rest of
        // its stack and from any reverse proxy reaching it there, so keep it.
        const networks = shape?.declaresNetworks
            ? [SENCHO_MESH_NETWORK]
            : ['default', SENCHO_MESH_NETWORK];
        const entry: Record<string, unknown> = { networks };
        if (sortedAliases.length > 0) {
            entry.extra_hosts = sortedAliases.map((a) => `${a.host}:${input.senchoIp}`);
        }
        services[svc] = entry;
    }

    const doc: Record<string, unknown> = {
        services,
        networks: { [SENCHO_MESH_NETWORK]: { external: true } },
    };

    return YAML.stringify(doc, { lineWidth: 0 });
}

/**
 * Build alias hostnames for every opted-in service across the fleet. Pure
 * helper consumed by MeshService and the override generator.
 */
export function buildAliasHosts(opts: {
    nodeName: string;
    stackName: string;
    services: Array<{ service: string; ports: number[] }>;
}): string[] {
    return opts.services.map((s) => `${s.service}.${opts.stackName}.${opts.nodeName}.sencho`);
}
