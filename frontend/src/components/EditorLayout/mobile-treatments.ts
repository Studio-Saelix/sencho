import type { ActiveView } from './hooks/useViewNavigationState';

// How a top-level view behaves below the md breakpoint.
//   bespoke      a dedicated phone screen (masthead-led, in components/mobile/)
//   responsive   the desktop view reflowed via max-md: utilities, no bespoke layout
//   desktop-only  a heavy authoring/terminal surface that stays desktop-first
//   detail        the full-screen stack-detail surface (the editor view)
export type MobileTreatment = 'bespoke' | 'responsive' | 'desktop-only' | 'detail';

// Single source of truth for the mobile treatment of every top-level view.
//
// The `Record<ActiveView, ...>` shape is the guard: adding a new `ActiveView`
// without classifying it here fails `tsc`, so no view can ship without a
// deliberate decision about its phone behavior. `mobile-treatments.test.ts`
// ties the 'bespoke' entries to `BESPOKE_MOBILE_VIEWS` and to the bespoke
// screens actually wired in EditorLayout, so the declaration cannot drift from
// the implementation.
export const MOBILE_TREATMENTS: Record<ActiveView, MobileTreatment> = {
  dashboard: 'bespoke',
  fleet: 'bespoke',
  'scheduled-ops': 'bespoke',
  settings: 'bespoke',
  editor: 'detail',
  resources: 'responsive',
  security: 'bespoke',
  templates: 'bespoke',
  'global-observability': 'responsive',
  'auto-updates': 'bespoke',
  'audit-log': 'responsive',
  'host-console': 'desktop-only',
};

// The content surfaces that render a bespoke phone screen instead of the
// reflowed desktop workspace. Derived from MOBILE_TREATMENTS so it cannot drift
// from the declared treatments. EditorLayout drops the global TopBar for these
// and renders their masthead-led screen.
export const BESPOKE_MOBILE_VIEWS: ReadonlySet<ActiveView> = new Set(
  (Object.keys(MOBILE_TREATMENTS) as ActiveView[]).filter(
    view => MOBILE_TREATMENTS[view] === 'bespoke',
  ),
);
