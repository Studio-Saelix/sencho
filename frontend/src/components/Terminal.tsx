import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Download, Search, ChevronUp, ChevronDown, X } from 'lucide-react';
import { loadXtermModules, type Terminal, type FitAddon, type SearchAddon, type SerializeAddon } from '@/lib/xtermLoader';
import { buildXtermTheme } from '@/lib/terminalTheme';

interface TerminalComponentProps {
  stackName?: string;
  /** Correlation id sent on the generic `connectTerminal` handshake so the
   *  backend streams the matching deploy's output to this socket. */
  deploySessionId?: string;
  onReady?: () => void;
  /** Fired when the socket fails to connect or drops while still mounted, so the
   *  caller can stop waiting on a best-effort progress stream. */
  onError?: () => void;
  onMessage?: (text: string) => void;
}

export default function TerminalComponent({ stackName, deploySessionId, onReady, onError, onMessage }: TerminalComponentProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstance = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [searchText, setSearchText] = useState('');

  useEffect(() => {
    if (!terminalRef.current) {
      console.error('Terminal ref not ready');
      return;
    }

    // Clean up any existing terminal
    if (terminalInstance.current) {
      try {
        terminalInstance.current.dispose();
      } catch {
        // Ignore dispose errors
      }
    }
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        // Ignore close errors
      }
    }

    let mounted = true;

    const initTerminal = async () => {
      if (!mounted || !terminalRef.current) return;

      const mods = await loadXtermModules().catch((err) => {
        console.error('Terminal: failed to load xterm:', err);
        return null;
      });
      if (!mods || !mounted || !terminalRef.current) return;

      try {
        const term = new mods.Terminal({
          cursorBlink: true,
          convertEol: true,
          allowProposedApi: true,
          theme: buildXtermTheme(),
          fontFamily: "'Geist Mono', monospace",
          fontSize: 13,
          scrollback: 10000,
        });

        const fitAddon = new mods.FitAddon();
        const searchAddon = new mods.SearchAddon();
        const serializeAddon = new mods.SerializeAddon();

        term.loadAddon(fitAddon);
        term.loadAddon(searchAddon);
        term.loadAddon(serializeAddon);

        fitAddonRef.current = fitAddon;
        searchAddonRef.current = searchAddon;
        serializeAddonRef.current = serializeAddon;

        term.open(terminalRef.current);
        terminalInstance.current = term;

        // Custom key handler for Ctrl+F
        term.attachCustomKeyEventHandler((event) => {
          if (event.ctrlKey && event.key === 'f' && event.type === 'keydown') {
            event.preventDefault();
            setIsSearchVisible(prev => {
              const next = !prev;
              if (next) {
                setTimeout(() => searchInputRef.current?.focus(), 50);
              }
              return next;
            });
            return false;
          }
          return true;
        });

        // Fit after DOM paint using requestAnimationFrame
        requestAnimationFrame(() => {
          if (!mounted || !fitAddonRef.current || !terminalRef.current) return;
          try {
            fitAddonRef.current.fit();
          } catch (err) {
            console.error('Error fitting terminal:', err);
          }
        });

        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const cleanStackName = stackName?.replace(/\.(yml|yaml)$/, '');
        const activeNodeId = localStorage.getItem('sencho-active-node') || '';

        // If a stackName is provided, connect to the dedicated logs WebSocket
        // Otherwise, fall back to the generic terminal WebSocket
        const wsUrl = cleanStackName
          ? `${wsProtocol}//${window.location.host}/api/stacks/${cleanStackName}/logs${activeNodeId ? `?nodeId=${activeNodeId}` : ''}`
          : `${wsProtocol}//${window.location.host}/ws${activeNodeId ? `?nodeId=${activeNodeId}` : ''}`;

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (mounted) {
            if (!cleanStackName) {
              // Generic terminal mode - send connect action with the deploy
              // correlation id so the backend streams this deploy's output here.
              ws.send(JSON.stringify({ action: 'connectTerminal', sessionId: deploySessionId }));
              onReady?.();
            }
            // For stack logs mode, the server starts streaming automatically on connection
          }
        };

        ws.onmessage = (event) => {
          if (mounted && terminalInstance.current) {
            const text = typeof event.data === 'string' ? event.data : event.data.toString();
            onMessage?.(text);
            terminalInstance.current.write(text.replace(/\r?\n/g, '\r\n'));
          }
        };

        ws.onerror = (err) => {
          console.error('WebSocket error:', err);
          if (mounted) onError?.();
        };

        ws.onclose = () => {
          // Only surface unexpected closes. Intentional teardown sets mounted
          // false before closing, so this skips minimize/navigation/unmount.
          if (mounted) onError?.();
        };

      } catch (err) {
        console.error('Error initializing terminal:', err);
        // A synchronous setup failure (e.g. WebSocket construction blocked by
        // CSP) gives no onerror/onclose, so release the deploy gate now instead
        // of waiting out the connect timeout.
        if (mounted) onError?.();
      }
    };

    // Initialize terminal after a small delay to ensure container is rendered
    const timeoutId = setTimeout(() => { void initTerminal(); }, 50);

    // Attach ResizeObserver to the terminal's parent container
    let resizeTimeout: number | undefined;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (fitAddonRef.current && terminalRef.current && mounted) {
          try {
            fitAddonRef.current.fit();
          } catch {
            // Ignore fit errors during resize
          }
        }
      }, 50);
    });

    if (terminalRef.current.parentElement) {
      resizeObserver.observe(terminalRef.current.parentElement);
    }

    return () => {
      mounted = false;
      clearTimeout(timeoutId);
      resizeObserver.disconnect();
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // Ignore close errors
        }
        wsRef.current = null;
      }
      if (terminalInstance.current) {
        try {
          terminalInstance.current.dispose();
        } catch {
          // Ignore dispose errors
        }
        terminalInstance.current = null;
      }
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      serializeAddonRef.current = null;
    };
  }, [stackName, deploySessionId, onReady, onError, onMessage]);

  const handleDownload = () => {
    if (!serializeAddonRef.current) return;
    const content = serializeAddonRef.current.serialize();
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.download = `logs-${stackName || 'terminal'}-${timestamp}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleSearchNext = () => {
    if (!searchAddonRef.current || !searchText) return;
    searchAddonRef.current.findNext(searchText);
  };

  const handleSearchPrev = () => {
    if (!searchAddonRef.current || !searchText) return;
    searchAddonRef.current.findPrevious(searchText);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (e.shiftKey) handleSearchPrev();
      else handleSearchNext();
    } else if (e.key === 'Escape') {
      setIsSearchVisible(false);
    }
  };

  return (
    <div className="flex flex-col h-full w-full relative group">
      {/* Floating Action Bar / Search Bar Panel */}
      <div className={`absolute top-2 right-6 z-10 flex gap-2 transition-opacity duration-200 ${isSearchVisible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'}`}>
        {!isSearchVisible ? (
          <Button variant="outline" size="sm" onClick={() => {
            setIsSearchVisible(true);
            setTimeout(() => searchInputRef.current?.focus(), 50);
          }} className="h-8 bg-background/80 backdrop-blur-sm shadow-sm" title="Search (Ctrl+F)">
            <Search className="w-4 h-4 mr-2" />
            Search
          </Button>
        ) : (
          <div className="flex flex-row items-center p-1 pr-1 bg-background/95 backdrop-blur-sm border border-border shadow-md rounded-md">
            <Input
              ref={searchInputRef}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Find in terminal..."
              className="h-7 w-48 border-none focus-visible:ring-0 bg-transparent text-sm min-h-0"
            />
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleSearchPrev} title="Previous (Shift+Enter)">
              <ChevronUp className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleSearchNext} title="Next (Enter)">
              <ChevronDown className="w-4 h-4" />
            </Button>
            <div className="w-px h-4 bg-border mx-1" />
            <Button variant="ghost" size="icon" className="h-6 w-6 hover:bg-destructive/10 hover:text-destructive" onClick={() => setIsSearchVisible(false)} title="Close (Esc)">
              <X className="w-4 h-4" />
            </Button>
          </div>
        )}

        <Button variant="outline" size="sm" onClick={handleDownload} className="h-8 bg-background/80 backdrop-blur-sm shadow-sm" title="Download Logs">
          <Download className="w-4 h-4 mr-2" />
          Download
        </Button>
      </div>

      <div ref={terminalRef} className="flex-1 w-full overflow-hidden" />
    </div>
  );
}