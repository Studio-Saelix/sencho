/**
 * Shared Compose-container lookup for mesh routing. Both
 * `MeshService.resolveContainerIp` (same-node fast path) and the
 * `TcpStreamSwitchboard` (inbound `tcp_open` handler) need to translate
 * a stack/service pair to a single deterministic IPv4 address; their
 * earlier implementations diverged on the network-preference rule,
 * which caused flaky resolution on containers attached to multiple
 * networks (compose `_default` plus `sencho_mesh`, for example).
 *
 * `pickContainerIp` is the canonical preference rule. `lookupContainerIp`
 * runs the conventional-name fast path first (`<stack>-<service>-1`)
 * before falling back to a compose-label container list.
 */
interface ContainerInspectInfo {
    NetworkSettings?: {
        Networks?: Record<string, { IPAddress?: string } | undefined>;
        IPAddress?: string;
    };
}

interface ContainerListItem {
    Id: string;
}

interface DockerodeLike {
    getContainer(id: string): { inspect(): Promise<ContainerInspectInfo> };
    listContainers(opts: unknown): Promise<unknown[]>;
}

/**
 * Pick a deterministic IPv4 for a container. Prefer the compose default
 * network (`<stack>_default` or any network named `<stack>_*`), then any
 * other attached network, then the legacy `NetworkSettings.IPAddress`.
 * Without this preference order, `Object.values(Networks)` ordering on
 * multi-network containers varies across daemon versions and can make
 * same-node forwarding flaky on a redeploy.
 */
export function pickContainerIp(stackName: string, info: ContainerInspectInfo): string | null {
    const networks = info.NetworkSettings?.Networks ?? {};
    const composeDefault = networks[`${stackName}_default`];
    if (composeDefault?.IPAddress) return composeDefault.IPAddress;
    for (const [name, net] of Object.entries(networks)) {
        if (name.startsWith(`${stackName}_`) && net?.IPAddress) return net.IPAddress;
    }
    for (const net of Object.values(networks)) {
        if (net?.IPAddress) return net.IPAddress;
    }
    return info.NetworkSettings?.IPAddress || null;
}

/**
 * Resolve a stack + service to a container IPv4. Tries the conventional
 * compose name first, then falls back to a label-filtered list. Returns
 * null when no container matches or the matching container has no IP on
 * any attached network.
 *
 * Errors propagate. Callers that only need a single string-or-null
 * surface should wrap with a try/catch (`MeshService.resolveContainerIp`
 * does this); callers that need to distinguish "Docker errored" from
 * "no container matched" use the thrown error to pick the right code.
 */
export async function lookupContainerIp(
    docker: DockerodeLike,
    stack: string,
    service: string,
): Promise<string | null> {
    const conventional = `${stack}-${service}-1`;
    const fast = await docker.getContainer(conventional).inspect().catch(() => null);
    const fastIp = fast ? pickContainerIp(stack, fast) : null;
    if (fastIp) return fastIp;

    const containers = (await docker.listContainers({
        all: true,
        filters: {
            label: [
                `com.docker.compose.project=${stack}`,
                `com.docker.compose.service=${service}`,
            ],
        },
    })) as ContainerListItem[];
    if (containers.length === 0) return null;
    const info = await docker.getContainer(containers[0].Id).inspect().catch(() => null);
    return info ? pickContainerIp(stack, info) : null;
}
