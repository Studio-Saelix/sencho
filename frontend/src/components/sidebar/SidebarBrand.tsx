import { FlaskConical } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { BuildInfo } from '@/context/BuildInfoProvider';

interface SidebarBrandProps {
  isDarkMode: boolean;
  buildInfo?: BuildInfo | null;
}

/** Detail shown under the DEV/PREVIEW chip, or the truthful Unknown / Restricted
 *  states when the running reference is unavailable or redacted for this user. */
export function chipDetail(buildInfo: BuildInfo | null | undefined): string {
  if (buildInfo?.restricted) return 'Restricted';
  if (buildInfo?.imageRef) {
    return buildInfo.revision ? `${buildInfo.imageRef} · ${buildInfo.revision}` : buildInfo.imageRef;
  }
  return 'Unknown';
}

export function SidebarBrand({ isDarkMode, buildInfo }: SidebarBrandProps) {
  const channel = buildInfo?.channel;
  const showChip = channel === 'dev' || channel === 'preview';

  return (
    <div className="flex items-center justify-center gap-3 px-4 h-14 border-b border-glass-border">
      <img
        src={isDarkMode ? '/sencho-logo-dark.svg' : '/sencho-logo-light.svg'}
        alt=""
        className="w-9 h-9 shrink-0"
      />
      <div className="flex items-center gap-1.5">
        <span className="font-display italic text-[28px] leading-none text-foreground">Sencho</span>
        <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-stat-subtitle">
          v{buildInfo?.version ?? __APP_VERSION__}
        </span>
        {showChip ? (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={
                    channel === 'dev'
                      ? 'inline-flex items-center font-mono text-[9px] leading-3 uppercase tracking-[0.16em] px-1.5 py-0.5 rounded bg-warning/15 text-warning border border-warning/30'
                      : 'inline-flex items-center font-mono text-[9px] leading-3 uppercase tracking-[0.16em] px-1.5 py-0.5 rounded bg-brand/15 text-brand border border-brand/30'
                  }
                >
                  {channel === 'dev' ? <FlaskConical className="w-2 h-2 mr-1" strokeWidth={1.5} /> : null}
                  {channel === 'dev' ? 'DEV' : 'PREVIEW'}
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="start">
                <span className="font-mono text-[10px]">{chipDetail(buildInfo)}</span>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </div>
    </div>
  );
}
