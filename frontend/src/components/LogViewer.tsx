import { useEffect, useState, useRef } from 'react';
import { Modal, ModalHeader } from "@/components/ui/modal";
import { Loader2, Terminal } from "lucide-react";

interface LogViewerProps {
    containerId: string | null;
    containerName: string;
    isOpen: boolean;
    onClose: () => void;
}

export function LogViewer({ containerId, containerName, isOpen, onClose }: LogViewerProps) {
    const [logs, setLogs] = useState<string[]>([]);
    const [isConnected, setIsConnected] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom when new logs arrive
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [logs]);

    useEffect(() => {
        if (!isOpen || !containerId) return;

        // eslint-disable-next-line react-hooks/set-state-in-effect
        setLogs([]);
        setIsConnected(false);

        const activeNodeId = localStorage.getItem('sencho-active-node') || '';
        const eventSource = new EventSource(`/api/containers/${containerId}/logs?nodeId=${activeNodeId}`);

        eventSource.onopen = () => setIsConnected(true);

        eventSource.onmessage = (event) => {
            try {
                const newLog = JSON.parse(event.data);
                setLogs(prev => {
                    const updated = [...prev, newLog];
                    return updated.length > 1000 ? updated.slice(updated.length - 1000) : updated;
                });
            } catch (err) {
                console.error("Failed to parse log line", err);
            }
        };

        eventSource.onerror = () => {
            setIsConnected(false);
            eventSource.close();
        };

        return () => {
            eventSource.close();
        };
    }, [isOpen, containerId]);

    return (
        <Modal open={isOpen} onOpenChange={(open) => !open && onClose()} className="max-w-4xl h-[80vh] flex flex-col">
            <ModalHeader
                kicker={`LOGS · ${containerName.toUpperCase()}`}
                title={
                    <span className="flex items-center gap-2">
                        <Terminal className="w-5 h-5" strokeWidth={1.5} />
                        Container logs
                        {isConnected ? (
                            <span className="text-success text-xs ml-2">(connected)</span>
                        ) : (
                            <Loader2 className="inline w-4 h-4 ml-2 animate-spin" />
                        )}
                    </span>
                }
                description={`Live log stream for ${containerName}`}
            />

            <div
                ref={scrollRef}
                className="flex-1 w-full bg-[var(--terminal-bg)] text-success p-4 overflow-y-auto font-mono text-xs mx-6 mb-6 rounded-md"
            >
                {logs.length === 0 && !isConnected ? (
                    <div className="text-muted-foreground">Connecting to container stream...</div>
                ) : (
                    logs.map((log, i) => (
                        <div key={i} className="break-all whitespace-pre-wrap leading-tight mb-1">
                            {log}
                        </div>
                    ))
                )}
            </div>
        </Modal>
    );
}
