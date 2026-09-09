import { createPaneLayoutPreference } from './use-pane-layout-preference';

export type SidebarMode = 'fixed' | 'resizable';

export const SIDEBAR_MODE_KEY = 'sencho.appearance.sidebarMode';
export const SIDEBAR_WIDTH_KEY = 'sencho.appearance.sidebarWidth';
export const SIDEBAR_MODES = ['fixed', 'resizable'] as const;
export const SIDEBAR_WIDTH = { min: 248, max: 440, default: 256 } as const;
export const SIDEBAR_WIDTH_DEFAULT = SIDEBAR_WIDTH.default;

const sidebarPreference = createPaneLayoutPreference({
  modeKey: SIDEBAR_MODE_KEY,
  widthKey: SIDEBAR_WIDTH_KEY,
  width: SIDEBAR_WIDTH,
  modeField: 'sidebarMode',
  widthField: 'sidebarWidth',
});

export const isSidebarMode = (value: unknown): value is SidebarMode => (
  value === 'fixed' || value === 'resizable'
);
export const sanitizeSidebarWidth = sidebarPreference.sanitizeWidth;
export const currentSidebarMode = sidebarPreference.currentMode;
export const currentSidebarWidth = sidebarPreference.currentWidth;
export const applySidebarModeValue = sidebarPreference.applyMode;
export const applySidebarWidthValue = sidebarPreference.applyWidth;

export function useSidebarLayout() {
  const { mode, width, setMode, setWidth } = sidebarPreference.usePaneLayout();
  return {
    sidebarMode: mode,
    sidebarWidth: width,
    setSidebarMode: setMode,
    setSidebarWidth: setWidth,
  };
}
