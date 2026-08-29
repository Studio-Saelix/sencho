import {
  HOST_CONSOLE_CAPABILITY,
  HOST_CONSOLE_COMMUNITY_CAPABILITY,
} from '@/lib/capabilities';
import type { NodeMode } from '@/context/NodeContext';
import { formatVersion } from '@/lib/version';

export type HostConsoleCapabilityState = 'loading' | 'allowed' | 'locked';

export interface HostConsoleCapabilityInput {
  /** False until NodeContext resolves an active node (cold load). Never treat as local. */
  nodeResolved: boolean;
  /** True when the resolved active node is a remote Distributed API Proxy or Pilot node. */
  isRemote: boolean;
  /** Hub license: Admiral may accept legacy `host-console` on remotes. */
  isPaid: boolean;
  /**
   * False while LicenseContext is still loading. Legacy-remote allowance
   * must wait so a cold load does not flash LockCard as Community.
   */
  licenseReady: boolean;
  /**
   * Cached `/api/meta` for the active node. Null means metadata has not been
   * fetched yet (or the node is unresolved). Must not be confused with
   * optimistic `hasCapability()` which returns true while meta is absent.
   */
  activeNodeMeta: { capabilities: readonly string[] } | null;
}

/**
 * Whether Host Console content may mount for the active node.
 *
 * Unresolved nodes stay in `loading`. Local nodes are treated as compatible
 * once RBAC passed (same build). Remote nodes wait for metadata, then require
 * `host-console-community`, or (Admiral only) legacy `host-console`.
 */
export function resolveHostConsoleCapability(
  input: HostConsoleCapabilityInput,
): HostConsoleCapabilityState {
  const { nodeResolved, isRemote, isPaid, licenseReady, activeNodeMeta } = input;
  if (!nodeResolved) return 'loading';
  if (!isRemote) return 'allowed';
  if (!activeNodeMeta) return 'loading';

  const caps = activeNodeMeta.capabilities;
  if (caps.includes(HOST_CONSOLE_COMMUNITY_CAPABILITY)) return 'allowed';
  if (!caps.includes(HOST_CONSOLE_CAPABILITY)) return 'locked';
  // Legacy host-console only: Admiral hubs may open it; wait for license first.
  if (!licenseReady) return 'loading';
  return isPaid ? 'allowed' : 'locked';
}

export interface HostConsoleLockMessageInput {
  /** Active node mode. Pilot Agent tunnels do not carry Host Console yet. */
  nodeMode: NodeMode | undefined;
  nodeName: string;
  version: string | null | undefined;
}

/**
 * Lock-card copy for a node whose Host Console capability is missing.
 *
 * Pilot Agent nodes cannot advertise the Host Console capability because the
 * interactive console path is not wired through the Pilot tunnel, so an
 * upgrade would not enable it. They get transport-specific copy instead of the
 * generic "upgrade the node" instruction. Every other mode (proxy remote or
 * missing metadata) keeps the generic upgrade message: version-aware when a
 * real version is present, otherwise a no-capability hint.
 */
export function resolveHostConsoleLockMessage(
  input: HostConsoleLockMessageInput,
): { title: string; body: string } {
  const { nodeMode, nodeName, version } = input;

  if (nodeMode === 'pilot_agent') {
    return {
      title: 'Host Console is not available through Pilot Agent yet',
      body: 'Host Console is currently available on the local node and Distributed API Proxy remotes.',
    };
  }

  const formatted = formatVersion(version);
  const versionHint = formatted
    ? `${nodeName} is running ${formatted}.`
    : `${nodeName} does not advertise this capability.`;
  return {
    title: 'Host Console is not available on this node',
    body: `${versionHint} Upgrade the node to use this feature.`,
  };
}
