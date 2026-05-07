import { SystemSheet, SheetSection } from '@/components/ui/system-sheet';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toast-store';
import { copyToClipboard } from '@/lib/clipboard';
import { Container, Copy } from 'lucide-react';

export interface NetworkInspectData {
  Id: string;
  Name: string;
  Created: string;
  Scope: string;
  Driver: string;
  Internal: boolean;
  Attachable: boolean;
  Labels: Record<string, string>;
  IPAM: {
    Driver: string;
    Config: Array<{ Subnet?: string; Gateway?: string; IPRange?: string }>;
  };
  Containers: Record<string, {
    Name: string;
    EndpointID: string;
    MacAddress: string;
    IPv4Address: string;
    IPv6Address: string;
  }>;
  Options: Record<string, string>;
}

interface NetworkDetailSheetProps {
  network: NetworkInspectData | null;
  onClose: () => void;
}

export function NetworkDetailSheet({ network, onClose }: NetworkDetailSheetProps) {
  const containerCount = network ? Object.keys(network.Containers || {}).length : 0;
  const subnet = network?.IPAM?.Config?.[0]?.Subnet;
  const meta = network
    ? `${network.Driver} · ${network.Scope}${subnet ? ` · ${subnet}` : ''} · ${containerCount} container${containerCount === 1 ? '' : 's'}`
    : '';

  const footerContext = network?.Created
    ? `Created ${new Date(network.Created).toLocaleString()}`
    : undefined;

  return (
    <SystemSheet
      open={!!network}
      onOpenChange={(open) => { if (!open) onClose(); }}
      crumb={['Resources', 'Networks', network?.Name ?? '—']}
      name={network?.Name ?? 'Network'}
      meta={meta}
      footerContext={footerContext}
      size="md"
    >
      {network && (
        <>
          <SheetSection title="Overview">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div>
                <span className="text-xs text-muted-foreground">ID</span>
                <p className="font-mono text-xs mt-0.5 flex items-center gap-1.5">
                  {network.Id.substring(0, 12)}
                  <button
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    onClick={async () => {
                      try { await copyToClipboard(network.Id); toast.success('ID copied'); }
                      catch { toast.error('Copy failed.'); }
                    }}
                    aria-label="Copy network ID"
                  >
                    <Copy className="w-3 h-3" strokeWidth={1.5} />
                  </button>
                </p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Driver</span>
                <span className="text-xs mt-0.5 block">
                  <Badge variant="outline" className="text-[10px] h-5">{network.Driver}</Badge>
                </span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Scope</span>
                <span className="text-xs mt-0.5 block">
                  <Badge variant="outline" className="text-[10px] h-5">{network.Scope}</Badge>
                </span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Created</span>
                <p className="text-xs mt-0.5">{new Date(network.Created).toLocaleString()}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Internal</span>
                <p className="text-xs mt-0.5">{network.Internal ? 'Yes' : 'No'}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Attachable</span>
                <p className="text-xs mt-0.5">{network.Attachable ? 'Yes' : 'No'}</p>
              </div>
            </div>
          </SheetSection>

          {network.IPAM?.Config?.length > 0 && (
            <SheetSection title="IPAM configuration">
              <div className="divide-y divide-card-border/40">
                {network.IPAM.Config.map((cfg, i) => (
                  <div key={i} className="py-2 space-y-1.5">
                    {cfg.Subnet && (
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-muted-foreground">Subnet</span>
                        <span className="font-mono text-xs tabular-nums">{cfg.Subnet}</span>
                      </div>
                    )}
                    {cfg.Gateway && (
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-muted-foreground">Gateway</span>
                        <span className="font-mono text-xs tabular-nums">{cfg.Gateway}</span>
                      </div>
                    )}
                    {cfg.IPRange && (
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-muted-foreground">IP Range</span>
                        <span className="font-mono text-xs tabular-nums">{cfg.IPRange}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </SheetSection>
          )}

          {network.Options && Object.keys(network.Options).length > 0 && (
            <SheetSection title="Options">
              <Table>
                <TableBody>
                  {Object.entries(network.Options).map(([key, val]) => (
                    <TableRow key={key} className="hover:bg-muted/30">
                      <TableCell className="font-mono text-xs py-1.5 text-muted-foreground">{key}</TableCell>
                      <TableCell className="font-mono text-xs py-1.5 text-right">{val}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </SheetSection>
          )}

          <SheetSection title={`Connected · ${containerCount} container${containerCount === 1 ? '' : 's'}`}>
            {containerCount === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">No containers connected to this network.</p>
            ) : (
              <div className="divide-y divide-card-border/40">
                {Object.entries(network.Containers).map(([id, c]) => (
                  <div key={id} className="py-2 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <Container className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.5} />
                      <span className="text-sm font-medium truncate">{c.Name}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 pl-5">
                      <div>
                        <span className="text-[10px] text-muted-foreground">IPv4</span>
                        <p className="font-mono text-xs tabular-nums">{c.IPv4Address || 'N/A'}</p>
                      </div>
                      <div>
                        <span className="text-[10px] text-muted-foreground">MAC</span>
                        <p className="font-mono text-xs tabular-nums">{c.MacAddress || 'N/A'}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SheetSection>

          {network.Labels && Object.keys(network.Labels).length > 0 && (
            <SheetSection title="Labels">
              <Table>
                <TableBody>
                  {Object.entries(network.Labels).map(([key, val]) => (
                    <TableRow key={key} className="hover:bg-muted/30">
                      <TableCell className="font-mono text-xs py-1.5 text-muted-foreground">{key}</TableCell>
                      <TableCell className="font-mono text-xs py-1.5 text-right">{val}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </SheetSection>
          )}
        </>
      )}
    </SystemSheet>
  );
}
