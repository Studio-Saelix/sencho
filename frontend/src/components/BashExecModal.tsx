import { useEffect, useRef, useState, useCallback } from 'react';
import { Modal, ModalHeader } from './ui/modal';
import { Terminal as TerminalIcon } from 'lucide-react';
import { loadXtermModules, type Terminal, type FitAddon, type XtermModules } from '@/lib/xtermLoader';
import { buildXtermMinimalTheme } from '@/lib/terminalTheme';

type TerminalContainer = HTMLDivElement & { __resizeObserver?: ResizeObserver };

interface BashExecModalProps {
  isOpen: boolean;
  onClose: () => void;
  containerId: string;
  containerName: string;
}

export default function BashExecModal({ isOpen, onClose, containerId, containerName }: BashExecModalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const initTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  const cleanup = useCallback(() => {
    if (initTimeoutRef.current) {
      clearTimeout(initTimeoutRef.current);
      initTimeoutRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (xtermRef.current) {
      xtermRef.current.dispose();
      xtermRef.current = null;
    }
    fitAddonRef.current = null;
    setIsConnected(false);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      cleanup();
      return;
    }

    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 15; // up to 1.5 seconds
    let modules: XtermModules | null = null;

    const checkAndInit = () => {
      if (cancelled || !modules) return;
      // If already initialized, stop.
      if (xtermRef.current) return;

      const container = terminalRef.current;

      // If Radix Dialog Portal hasn't rendered the DOM node yet, poll.
      if (!container) {
        if (attempts++ < maxAttempts) {
          initTimeoutRef.current = setTimeout(checkAndInit, 100);
        } else {
          console.error('BashExecModal: terminalRef never populated.');
        }
        return;
      }

      // DOM exists. Now verify it has actual layout size from CSS.
      // During initial Radix zoom-in animation, it might be 0x0.
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        if (attempts++ < maxAttempts) {
          initTimeoutRef.current = setTimeout(checkAndInit, 100);
        } else {
          console.warn('BashExecModal: terminal container has zero dimensions after 1.5s, forcing init anyway.');
          initTerminal(container, modules);
        }
        return;
      }

      // Node exists and has layout - safe to initialize xterm!
      initTerminal(container, modules);
    };

    void loadXtermModules().then((mods) => {
      if (cancelled) return;
      modules = mods;
      initTimeoutRef.current = setTimeout(checkAndInit, 50);
    }).catch((err) => {
      console.error('BashExecModal: failed to load xterm:', err);
    });

    function initTerminal(containerEl: HTMLDivElement, mods: XtermModules) {
      const term = new mods.Terminal({
        theme: buildXtermMinimalTheme(),
        fontFamily: "'Geist Mono', monospace",
        fontSize: 14,
        cursorBlink: true,
      });

      const fitAddon = new mods.FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerEl);

      xtermRef.current = term;
      fitAddonRef.current = fitAddon;

      // Fit after xterm has rendered its canvas
      requestAnimationFrame(() => {
        try {
          fitAddon.fit();
        } catch {
          // Ignore fit errors during initial render
        }
      });

      // Connect to WebSocket for bash exec
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const activeNodeId = localStorage.getItem('sencho-active-node') || '';
      const ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws${activeNodeId ? `?nodeId=${activeNodeId}` : ''}`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({
          action: 'execContainer',
          containerId: containerId,
          nodeId: localStorage.getItem('sencho-active-node') || undefined
        }));
        setIsConnected(true);

        // Focus so user can type immediately
        term.focus();

        // Fit again now that everything is settled, then send dimensions
        setTimeout(() => {
          try {
            fitAddon.fit();
          } catch {
            // Ignore
          }
          if (ws.readyState === WebSocket.OPEN && term.rows > 0 && term.cols > 0) {
            ws.send(JSON.stringify({
              type: 'resize',
              rows: term.rows,
              cols: term.cols,
            }));
          }
        }, 100);
      };

      ws.onmessage = (event) => {
        // Raw text from container → write directly to xterm
        term.write(event.data);
      };

      ws.onerror = () => {
        term.write('\r\n\x1b[31mConnection error\x1b[0m\r\n');
        setIsConnected(false);
      };

      ws.onclose = () => {
        term.write('\r\n\x1b[33mSession ended\x1b[0m\r\n');
        setIsConnected(false);
      };

      // Handle user input - JSON up
      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'input',
            data: data,
          }));
        }
      });

      // ResizeObserver for modal/window resize events
      const resizeObserver = new ResizeObserver(() => {
        if (!fitAddonRef.current || !wsRef.current) return;
        try {
          fitAddonRef.current.fit();
        } catch {
          return;
        }
        if (wsRef.current.readyState === WebSocket.OPEN && term.rows > 0 && term.cols > 0) {
          wsRef.current.send(JSON.stringify({
            type: 'resize',
            rows: term.rows,
            cols: term.cols,
          }));
        }
      });

      resizeObserver.observe(containerEl);

      // Store observer cleanup on the container element for later
      (containerEl as TerminalContainer).__resizeObserver = resizeObserver;
    }

    return () => {
      cancelled = true;
      // Clean up ResizeObserver
      const el = terminalRef.current as TerminalContainer | null;
      if (el?.__resizeObserver) {
        el.__resizeObserver.disconnect();
        delete el.__resizeObserver;
      }
    };
  }, [isOpen, containerId, cleanup]);

  const handleClose = () => {
    cleanup();
    onClose();
  };

  return (
    <Modal open={isOpen} onOpenChange={handleClose} mobileFullScreen className="max-w-4xl h-[600px] flex flex-col">
      <ModalHeader
        kicker={`BASH · ${containerName.toUpperCase()}`}
        title={
          <span className="flex items-center gap-2">
            <TerminalIcon className="w-5 h-5" strokeWidth={1.5} />
            Bash session
            {isConnected && (
              <span className="ml-2 text-xs bg-success/20 text-success px-2 py-0.5 rounded-full">
                Connected
              </span>
            )}
          </span>
        }
        description={`Interactive bash terminal session for ${containerName}`}
      />
      <div className="flex-1 rounded-lg bg-black p-1 min-h-0 mx-6 mb-6" style={{ overflow: 'hidden' }}>
        <div
          ref={terminalRef}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
    </Modal>
  );
}
