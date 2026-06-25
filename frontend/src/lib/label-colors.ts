export const HUE_VARS = [
    'teal', 'blue', 'purple', 'rose', 'amber',
    'green', 'orange', 'pink', 'cyan', 'slate',
] as const;

export type LabelHue = typeof HUE_VARS[number];

/** djb2-style hash that maps a string to a stable LabelHue. */
export function hashLabel(label: string): LabelHue {
    let h = 0;
    for (let i = 0; i < label.length; i += 1) {
        h = (h * 31 + label.charCodeAt(i)) | 0;
    }
    return HUE_VARS[Math.abs(h) % HUE_VARS.length];
}
