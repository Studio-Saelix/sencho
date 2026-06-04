(function () {
  // Pre-paint: apply the saved theme/accent/knobs/type to <html> before first
  // paint so there is no flash. Mirrors the apply logic in src/hooks/use-theme.ts;
  // keep the two in sync. Dependency-free on purpose (runs in <head>).
  var STORAGE_KEY = 'sencho.appearance.theme';
  var LEGACY_KEY = 'sencho-theme';
  var MODES = { dim: 1, oled: 1, light: 1, auto: 1 };
  var ACCENTS = {
    cyan: 1, blue: 1, violet: 1, magenta: 1,
    orange: 1, amber: 1, lime: 1, steel: 1,
  };
  var UI_FONTS = { 'Geist': 1, 'IBM Plex Sans': 1, 'Hanken Grotesk': 1 };
  var MONO_FONTS = { 'Geist Mono': 1, 'IBM Plex Mono': 1, 'Fira Code': 1 };
  var DEFAULTS = {
    theme: 'dim', accent: 'cyan', borderBoost: 0, glow: 0.16, contrast: 0,
    uiFont: 'Geist', monoFont: 'Geist Mono', typeScale: 1,
  };

  function num(v, min, max, def) {
    if (typeof v !== 'number' || !isFinite(v)) return def;
    return Math.min(max, Math.max(min, v));
  }

  function read() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && typeof p === 'object') {
          return {
            theme: MODES[p.theme] ? p.theme : DEFAULTS.theme,
            accent: ACCENTS[p.accent] ? p.accent : DEFAULTS.accent,
            borderBoost: num(p.borderBoost, -0.06, 0.12, DEFAULTS.borderBoost),
            glow: num(p.glow, 0, 0.4, DEFAULTS.glow),
            contrast: num(p.contrast, -0.6, 1.2, DEFAULTS.contrast),
            uiFont: UI_FONTS[p.uiFont] ? p.uiFont : DEFAULTS.uiFont,
            monoFont: MONO_FONTS[p.monoFont] ? p.monoFont : DEFAULTS.monoFont,
            typeScale: num(p.typeScale, 0.88, 1.2, DEFAULTS.typeScale),
          };
        }
      }
      // Legacy migration: old string key held only the mode (dark mapped to dim).
      var legacy = localStorage.getItem(LEGACY_KEY);
      var legacyTheme = legacy === 'light' || legacy === 'auto' ? legacy : legacy === 'dark' ? 'dim' : null;
      if (legacyTheme) {
        var migrated = {};
        for (var k in DEFAULTS) migrated[k] = DEFAULTS[k];
        migrated.theme = legacyTheme;
        return migrated;
      }
    } catch (e) { /* ignore */ }
    var out = {};
    for (var d in DEFAULTS) out[d] = DEFAULTS[d];
    return out;
  }

  function resolveTheme(theme) {
    if (theme === 'auto') {
      var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      return dark ? 'dim' : 'light';
    }
    return theme;
  }

  try {
    var s = read();
    var resolved = resolveTheme(s.theme);
    var root = document.documentElement;
    root.dataset.theme = resolved;
    root.dataset.accent = s.accent;
    root.style.setProperty('--border-boost', String(s.borderBoost));
    root.style.setProperty('--glow', String(s.glow));
    root.style.setProperty('--contrast', String(s.contrast));
    root.style.setProperty('--ui-font', "'" + s.uiFont + "'");
    root.style.setProperty('--mono-font', "'" + s.monoFont + "'");
    root.style.setProperty('--type-scale', String(s.typeScale));
    root.classList.toggle('dark', resolved !== 'light');
  } catch (e) { /* ignore */ }
})();
