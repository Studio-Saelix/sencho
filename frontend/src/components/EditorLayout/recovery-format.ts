import type { Node } from '@/context/NodeContext';
import type { StackActionResult } from './EditorView';

export function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatElapsed(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds >= 60) {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m}m ${s}s`;
    }
    return `${seconds}s`;
}

// Plain-text troubleshooting blob for the recovery panel's "Copy details". The
// last output line is included only when the record carries one (session-safe).
export function buildDiagnostics(
    stackName: string,
    result: StackActionResult,
    activeNode: Node | null,
    backupInfo: { exists: boolean; timestamp: number | null },
): string {
    const lines = [
        `Stack: ${stackName}`,
        `Node: ${activeNode?.name ?? 'local'}${activeNode?.id != null ? ` (id ${activeNode.id})` : ''}`,
        `Action: ${result.action}`,
        `Outcome: failed${result.rolledBack ? ' (rolled back to previous version)' : ''}`,
        `Elapsed: ${formatElapsed(result.endedAt - result.startedAt)}`,
        `Error: ${result.errorMessage ?? 'unknown'}`,
        `Backup: ${backupInfo.exists
            ? `available${backupInfo.timestamp ? ` (${new Date(backupInfo.timestamp).toISOString()})` : ''}`
            : 'none'}`,
    ];
    if (result.lastOutputLine) lines.push(`Last output: ${result.lastOutputLine}`);
    return lines.join('\n');
}
