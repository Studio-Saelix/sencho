interface SidebarBrandProps {
  isDarkMode: boolean;
}

export function SidebarBrand({ isDarkMode }: SidebarBrandProps) {
  return (
    <div className="flex items-center justify-center gap-3 px-4 h-14 border-b border-glass-border">
      <img
        src={isDarkMode ? '/sencho-logo-dark.svg' : '/sencho-logo-light.svg'}
        alt=""
        className="w-9 h-9 shrink-0"
      />
      <div className="flex items-baseline gap-1.5">
        <span className="font-display italic text-[28px] leading-none text-foreground">Sencho</span>
        <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-stat-subtitle">
          v{__APP_VERSION__}
        </span>
      </div>
    </div>
  );
}
