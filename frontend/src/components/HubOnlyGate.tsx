import { type ReactNode } from 'react';
import { useNodes } from '@/context/NodeContext';

interface HubOnlyGateProps {
  children: ReactNode;
}

/**
 * Short-circuits to null when the active node is remote so the wrapped
 * lazy chunk is never fetched. Must wrap *outside* any `LazyView`
 * (Suspense + lazy), otherwise the gated chunk would download just to
 * render a preview before the redirect in `useViewNavigationState`
 * fires. Same load-bearing constraint as `CapabilityGate`.
 */
export function HubOnlyGate({ children }: HubOnlyGateProps) {
  const { activeNode } = useNodes();
  if (activeNode?.type === 'remote') return null;
  return <>{children}</>;
}
