import { createPaneLayoutPreference } from './use-pane-layout-preference';

export type AnatomyMode = 'fixed' | 'resizable';

export const ANATOMY_MODE_KEY = 'sencho.appearance.anatomyMode';
export const ANATOMY_WIDTH_KEY = 'sencho.appearance.anatomyWidth';
export const ANATOMY_MODES = ['fixed', 'resizable'] as const;
export const ANATOMY_WIDTH = { min: 320, max: 960, default: 640 } as const;
export const ANATOMY_WIDTH_DEFAULT = ANATOMY_WIDTH.default;

const anatomyPreference = createPaneLayoutPreference({
  modeKey: ANATOMY_MODE_KEY,
  widthKey: ANATOMY_WIDTH_KEY,
  width: ANATOMY_WIDTH,
  modeField: 'anatomyMode',
  widthField: 'anatomyWidth',
});

export const isAnatomyMode = (value: unknown): value is AnatomyMode => (
  value === 'fixed' || value === 'resizable'
);
export const sanitizeAnatomyWidth = anatomyPreference.sanitizeWidth;
export const currentAnatomyMode = anatomyPreference.currentMode;
export const currentAnatomyWidth = anatomyPreference.currentWidth;
export const applyAnatomyModeValue = anatomyPreference.applyMode;
export const applyAnatomyWidthValue = anatomyPreference.applyWidth;

export function useAnatomyLayout() {
  const { mode, width, setMode, setWidth } = anatomyPreference.usePaneLayout();
  return {
    anatomyMode: mode,
    anatomyWidth: width,
    setAnatomyMode: setMode,
    setAnatomyWidth: setWidth,
  };
}
