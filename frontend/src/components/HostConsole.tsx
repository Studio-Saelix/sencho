import { useEffect, useRef, useState, useCallback } from 'react';
import { ArrowLeft, Copy, Trash2, Download, RefreshCw } from 'lucide-react';
import { Button } from './ui/button';
import { PageMasthead, type MastheadTone } from './ui/PageMasthead';
import { loadXtermModules, type Terminal, type FitAddon, type SerializeAddon } from '@/lib/xtermLoader';
import { buildXtermMinimalTheme } from '@/lib/terminalTheme';
import { useNodes } from '@/context/NodeContext';
import { copyToClipboard } from '@/lib/clipboard';

interface HostConsoleProps {
    /** Resolved active node id; WebSocket must target this id, not localStorage. */
    nodeId: number;
    stackName?: string | null;
    onClose: () => void;
}

// Window considered "live" for the masthead pulsing dot.
const LIVE_WINDOW_MS = 5_000;


function formatUptime(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) return `${h}H ${m.toString().padStart(2, '0')}M`;
    return `${m}:${s.toString().padStart(2, '0')} UP`;
}

type ConnState = 'reconnecting' | 'connected' | 'disconnected';

export default function HostConsole({ nodeId, stackName, onClose }: HostConsoleProps) {
    const { activeNode } = useNodes();
    const terminalRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const serializeRef = useRef<SerializeAddon | null>(null);
    const wsRef = useRef<WebSocket | null>(null);

    const [connState, setConnState] = useState<ConnState>('reconnecting');
    const [lastActivityAt, setLastActivityAt] = useState<number | null>(null);
    const [dims, setDims] = useState<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
    const [mountedAt, setMountedAt] = useState<number | null>(null);
    const [tick, setTick] = useState(0);
    const [reconnectNonce, setReconnectNonce] = useState(0);

    useEffect(() => {
        const run = () => {
            const now = Date.now();
            setTick(now);
            setMountedAt(prev => prev ?? now);
        };
        const init = setTimeout(run, 0);
        const id = setInterval(run, 1000);
        return () => { clearTimeout(init); clearInterval(id); };
    }, []);

    useEffect(() => {
        const container = terminalRef.current;
        if (!container) return;

        let mounted = true;
        let resizeObserver: ResizeObserver | null = null;
        let resizeTimeout: ReturnType<typeof setTimeout> | undefined;

        void loadXtermModules().then((mods) => {
            if (!mounted) return;

            const term = new mods.Terminal({
                theme: buildXtermMinimalTheme(),
                fontFamily: "'Geist Mono', monospace",
                fontSize: 14,
                cursorBlink: true,
            });

            const fitAddon = new mods.FitAddon();
            const serializeAddon = new mods.SerializeAddon();
            term.loadAddon(fitAddon);
            term.loadAddon(serializeAddon);
            term.open(container);

            xtermRef.current = term;
            fitAddonRef.current = fitAddon;
            serializeRef.current = serializeAddon;

            requestAnimationFrame(() => {
                try {
                    if (mounted) {
                        fitAddon.fit();
                        setDims({ cols: term.cols, rows: term.rows });
                    }
                } catch {
                    // Ignore fit errors during initial render
                }
            });

            const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const qs = stackName
                ? `nodeId=${nodeId}&stack=${encodeURIComponent(stackName)}`
                : `nodeId=${nodeId}`;
            const ws = new WebSocket(
                `${wsProtocol}//${window.location.host}/api/system/host-console?${qs}`,
            );
            wsRef.current = ws;

            ws.onopen = () => {
                if (!mounted) return;
                setConnState('connected');
                setLastActivityAt(Date.now());
                term.focus();

                setTimeout(() => {
                    try {
                        if (mounted) {
                            fitAddon.fit();
                            setDims({ cols: term.cols, rows: term.rows });
                        }
                    } catch {
                        // Ignore
                    }
                    if (ws.readyState === WebSocket.OPEN && term.rows > 0 && term.cols > 0) {
                        ws.send(JSON.stringify({
                            type: 'resize',
                            cols: term.cols,
                            rows: term.rows,
                        }));
                    }
                }, 100);
            };

            ws.onmessage = (event) => {
                if (!mounted) return;
                const text = typeof event.data === 'string' ? event.data : event.data.toString();
                term.write(text);
                setLastActivityAt(Date.now());
            };

            ws.onerror = () => {
                if (!mounted) return;
                term.write('\r\n\x1b[31mConnection error\x1b[0m\r\n');
                setConnState('disconnected');
            };

            ws.onclose = () => {
                if (!mounted) return;
                term.write('\r\n\x1b[33mSession ended\x1b[0m\r\n');
                setConnState('disconnected');
            };

            term.onData((data) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'input',
                        payload: data,
                    }));
                }
            });

            resizeObserver = new ResizeObserver(() => {
                clearTimeout(resizeTimeout);
                resizeTimeout = setTimeout(() => {
                    if (!mounted || !fitAddonRef.current || !wsRef.current) return;
                    try {
                        fitAddonRef.current.fit();
                        setDims({ cols: term.cols, rows: term.rows });
                    } catch {
                        return;
                    }
                    if (wsRef.current.readyState === WebSocket.OPEN && term.rows > 0 && term.cols > 0) {
                        wsRef.current.send(JSON.stringify({
                            type: 'resize',
                            cols: term.cols,
                            rows: term.rows,
                        }));
                    }
                }, 50);
            });

            resizeObserver.observe(container);
        }).catch((err) => {
            console.error('HostConsole: failed to load xterm:', err);
        });

        return () => {
            mounted = false;
            if (resizeObserver) resizeObserver.disconnect();
            if (resizeTimeout) clearTimeout(resizeTimeout);
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
            if (xtermRef.current) {
                xtermRef.current.dispose();
                xtermRef.current = null;
            }
            fitAddonRef.current = null;
            serializeRef.current = null;
        };
    }, [nodeId, stackName, reconnectNonce]);

    const handleCopy = useCallback(() => {
        const term = xtermRef.current;
        if (!term) return;
        const selection = term.getSelection();
        if (!selection) return;
        void copyToClipboard(selection).catch(() => { /* ignore */ });
    }, []);

    const handleClear = useCallback(() => {
        xtermRef.current?.clear();
    }, []);

    const handleDownload = useCallback(() => {
        const content = serializeRef.current?.serialize();
        if (!content) return;
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `sencho-console-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, []);

    const handleReconnect = useCallback(() => {
        setConnState('reconnecting');
        setReconnectNonce(n => n + 1);
    }, []);

    const isLive = connState === 'connected' && lastActivityAt != null && (tick - lastActivityAt) < LIVE_WINDOW_MS;
    const tone: MastheadTone = connState === 'disconnected'
        ? 'error'
        : connState === 'reconnecting'
            ? 'warn'
            : isLive ? 'live' : 'idle';
    const stateWord = connState === 'disconnected'
        ? 'Disconnected'
        : connState === 'reconnecting' ? 'Reconnecting' : 'Connected';
    let nodeLabel = `NODE ${nodeId}`;
    if (activeNode?.id === nodeId) {
        nodeLabel = activeNode.type === 'local' ? 'LOCAL' : activeNode.name.toUpperCase();
    }
    const kicker = `HOST CONSOLE · ${nodeLabel}`;

    const uptime = mountedAt != null ? formatUptime(tick - mountedAt) : '—';
    const viewport = dims.cols > 0 && dims.rows > 0 ? `${dims.cols}×${dims.rows}` : '—';
    const metadata = [
        { label: 'SHELL', value: 'BASH', tone: 'subtitle' as const },
        { label: 'VIEWPORT', value: viewport, tone: 'subtitle' as const },
        { label: 'SESSION', value: uptime, tone: 'subtitle' as const },
    ];

    return (
        <div className="relative flex h-full w-full flex-col bg-background text-foreground">
            <PageMasthead
                kicker={kicker}
                state={stateWord}
                tone={tone}
                pulsing={tone === 'live' || tone === 'warn'}
                metadata={metadata}
            >
                {stackName ? (
                    <button
                        type="button"
                        onClick={onClose}
                        className="inline-flex items-center gap-1.5 rounded-md border border-card-border bg-card px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle shadow-btn-glow transition-colors hover:text-stat-value focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
                    >
                        <ArrowLeft className="h-3 w-3" strokeWidth={1.5} />
                        <span className="max-w-[160px] truncate">{stackName}</span>
                    </button>
                ) : null}
            </PageMasthead>

            <div
                className="relative min-h-0 flex-1 p-2 shadow-[inset_0_2px_4px_0_oklch(0_0_0/0.4)]"
                style={{ backgroundColor: 'var(--terminal-bg)', overflow: 'hidden' }}
            >
                <div ref={terminalRef} style={{ width: '100%', height: '100%' }} />

                <div className="pointer-events-none absolute bottom-4 right-6 z-10 flex items-center gap-2">
                    <div className="pointer-events-auto flex items-center gap-1 rounded-md border border-glass-border bg-popover/95 p-1 shadow-md backdrop-blur-[10px] backdrop-saturate-[1.15]" data-sn-glass="panel">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleCopy}
                            className="h-7 gap-2 px-2 text-xs text-stat-subtitle hover:text-stat-value"
                            aria-label="Copy selection"
                        >
                            <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
                            <span className="font-mono text-[10px] uppercase tracking-[0.18em]">Copy</span>
                        </Button>
                        <div className="h-5 w-px bg-card-border" />
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleClear}
                            className="h-7 gap-2 px-2 text-xs text-stat-subtitle hover:text-stat-value"
                            aria-label="Clear terminal"
                        >
                            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                            <span className="font-mono text-[10px] uppercase tracking-[0.18em]">Clear</span>
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleDownload}
                            className="h-7 gap-2 px-2 text-xs text-stat-subtitle hover:text-stat-value"
                            aria-label="Download scrollback"
                        >
                            <Download className="h-3.5 w-3.5" strokeWidth={1.5} />
                            <span className="font-mono text-[10px] uppercase tracking-[0.18em]">Download</span>
                        </Button>
                        <div className="h-5 w-px bg-card-border" />
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleReconnect}
                            className="h-7 gap-2 px-2 text-xs text-stat-subtitle hover:text-stat-value"
                            aria-label="Reconnect session"
                        >
                            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.5} />
                            <span className="font-mono text-[10px] uppercase tracking-[0.18em]">Reconnect</span>
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
