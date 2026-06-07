import { useEffect, useState } from 'react';

// Matches Tailwind's `max-md` variant exactly (md starts at 768px), so a JS
// branch keyed on this hook and a `max-md:` class always agree on which side
// of the breakpoint we are. Below this width Sencho renders its mobile shell;
// at or above it the desktop sidebar + workspace layout is untouched.
const MOBILE_QUERY = '(max-width: 767.98px)';

/**
 * True when the viewport is narrower than the `md` breakpoint.
 *
 * This is a single-instance SPA (no SSR), so the initial state reads
 * `matchMedia` synchronously to avoid a desktop→mobile flash on first paint.
 * The `window`/`matchMedia` guards keep it safe under jsdom and any non-DOM
 * render path.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(MOBILE_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    // Sync once in case the width changed between the initial render and effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
