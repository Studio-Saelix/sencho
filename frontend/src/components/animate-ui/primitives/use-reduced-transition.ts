import { useReducedMotion } from '@/hooks/use-theme';

const INSTANT = { duration: 0 } as const;

/**
 * Returns an instant (zero-duration) transition when the "Reduced motion"
 * appearance setting is on, otherwise the supplied transition. This reads our
 * app setting (not framer-motion's useReducedMotion, which only reflects the OS
 * prefers-reduced-motion). `MotionConfig`'s reducedMotion only neutralizes
 * transform/layout animations, so overlay primitives that fade or blur
 * (opacity/filter) still animate; this collapses those too.
 */
export function useReducedTransition<T>(transition: T): T | typeof INSTANT {
  return useReducedMotion() ? INSTANT : transition;
}
