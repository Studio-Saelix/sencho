import { useContext } from 'react';
import { BuildInfoContext, type BuildInfoContextType } from '@/context/BuildInfoProvider';

/** Consumer of the single shared control-instance build identity. The shell,
 *  About, and Admiral Account all read the same fetched BuildInfo by reference
 *  instead of issuing their own fetches. */
export function useBuildInfo(): BuildInfoContextType {
  const context = useContext(BuildInfoContext);
  if (context === undefined) {
    throw new Error('useBuildInfo must be used within a BuildInfoProvider');
  }
  return context;
}