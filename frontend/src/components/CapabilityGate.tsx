import { type ReactNode } from 'react';
import { Unplug } from 'lucide-react';
import { useNodes } from '@/context/NodeContext';
import type { Capability } from '@/lib/capabilities';
import { isValidVersion } from '@/lib/version';
import { LockCard } from './ui/LockCard';

interface CapabilityGateProps {
  capability: Capability;
  featureName?: string;
  /** Overrides the default "Upgrade the node to use this feature." body. Use
   *  when the capability is gated on something other than node version (for
   *  example, a scanner binary that must be installed separately). */
  resolution?: string;
  children: ReactNode;
}

/**
 * Renders children only when the active node advertises the required
 * capability. When it does not, returns a clean lock card explaining the
 * version mismatch instead of rendering the gated UI.
 *
 * Short-circuiting is load-bearing: callers wrap CapabilityGate around
 * lazy-loaded views, and rendering the gated children to "blur and
 * overlay" them would still trigger the chunk fetch (and ship the JSX
 * to anyone who opens DevTools). The lock card has no children
 * dependency and adds no chunk weight, so a node that lacks the
 * capability never downloads the gated module.
 */
export function CapabilityGate({ capability, featureName = 'This feature', resolution, children }: CapabilityGateProps) {
  const { hasCapability, activeNode, activeNodeMeta } = useNodes();

  if (hasCapability(capability)) return <>{children}</>;

  const nodeName = activeNode?.name ?? 'this node';
  const versionHint = isValidVersion(activeNodeMeta?.version)
    ? `${nodeName} is running v${activeNodeMeta.version}.`
    : `${nodeName} does not advertise this capability.`;
  const body = resolution ?? `${versionHint} Upgrade the node to use this feature.`;

  return (
    <LockCard
      icon={Unplug}
      title={`${featureName} is not available on this node`}
      body={body}
    />
  );
}
