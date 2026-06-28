import { useReducedMotion } from 'motion/react';

const INSTANT = { duration: 0 } as const;

/**
 * Returns an instant (zero-duration) transition when reduced motion is active,
 * otherwise the supplied transition. `MotionConfig`'s reducedMotion only
 * neutralizes transform/layout animations, so overlay primitives that fade or
 * blur (opacity/filter) still animate; this collapses those too, honoring the
 * "Reduced motion" appearance setting.
 */
export function useReducedTransition<T>(transition: T): T | typeof INSTANT {
  return useReducedMotion() ? INSTANT : transition;
}
